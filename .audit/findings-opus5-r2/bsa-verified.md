# Behavioral State Analysis — Verified (Opus 5 R2)

**Date:** 2026-08-20
**Baseline:** `SCOPE.md` — working tree at `c02af1d`, contracts uncommitted.
**Method:** classify each contract, model its state machine, then run only the
threat engines that shape applies. New this round: the three subsystems that
make a pool's behaviour a function of `block.timestamp - createdAt` and of
`lastLargeSwapBlock`, and the three never-audited contracts.

**Scope actually covered:** `EXNIHILOPool.sol` (full), `PreMarket.sol`,
`PreMarketFactory.sol`, `LockedLpVault.sol`, `PositionNFT.sol`,
`EXNIHILOFactory.sol`, `EXNIHILORouter.sol`, `PoolDeployer.sol`, `LpNFT.sol`,
`Faucet.sol`. Findings were verified against a BigInt reimplementation of the
pool's exact settlement and swap arithmetic; every number below is produced by
that model, not estimated.

```
1 CRITICAL | 2 HIGH | 1 MEDIUM | 4 LOW | 2 INFO
```

## Contract classification

| Contract | Type | Engines run |
|---|---|---|
| `EXNIHILOPool` | Single-LP synthetic derivatives AMM + expiry engine | ETE, ACTE, SITE + time-state |
| `PreMarket` | Bonding-curve launchpad w/ Dutch buyout | ETE, SITE (state machine), ACTE lite |
| `PreMarketFactory` | Permissionless deployer | ACTE lite |
| `LockedLpVault` | Two-party revenue-share vault, ERC-721 custodian | ETE, ACTE |
| `PositionNFT` | Position registry + on-chain SVG | ACTE lite |
| `EXNIHILOFactory` / `PoolDeployer` / `LpNFT` | Immutable factory chain | ACTE lite |
| `EXNIHILORouter` | Stateless forwarder | none material |
| `Faucet` | Testnet utility | none (see INFO) |

The single-LP classification from the prior round still holds and still removes
the share-accounting threat family. What it does **not** remove — and what this
round turns on — is that the sole LP is the counterparty to every position, so
every settlement is a bilateral transfer between two identified parties, one of
whom controls the reserves the settlement is priced from.

## Pool state machine — now three-dimensional

The prior round's OPEN → CLOSING → DRAINABLE machine is unchanged, but two new
orthogonal axes were added:

```
  wall-clock axis (createdAt-anchored, monotone, unstoppable)
    age:  0 ────1h────8h────24h──────────7d──────────►
    cap:  1% ───────linear ramp───────► 20%   (currentMaxPositionBps)
    dur:  1h │ 8h  │ 24h │      7d      │  30d (currentPositionDuration)

  block axis (other users' actions, resettable)
    lastLargeSwapBlock ──► +5 blocks of third-party settlement lockout
```

Per-position sub-machine: `open → (renew | auto-renew)* → settled`. The link to
the pool machine is `openPositionCount`, which gates DRAINABLE.

Phase-boundary review:

| Boundary | Discontinuity | Exploitable? |
|---|---|---|
| `age = 1h / 8h / 24h / 7d` | duration steps 8×, 3×, 7×, 4.3× | No — non-decreasing, and `closePool`'s coverage argument survives for un-renewed positions |
| `age = 24h` | cap ramp flattens at 20% | No — ramp is monotone, no cliff |
| `elapsed = 0` | cap = 1% of seed | No |
| `lastLargeSwapBlock + 5` | settlement lockout ends | **Yes — see CRITICAL-BSA-R2-1** |
| `closeDate` set | opens blocked, renewals bounded | **Yes — see HIGH-BSA-R2-2** |

---

## CRITICAL-BSA-R2-1 — the settlement guard is per-call and swap-only; the LP can zero out any expired position's payout for free

**Location:** `EXNIHILOPool.sol:1437-1441` (`_armSettlementGuard`),
`EXNIHILOPool.sol:1452-1458` (`_assertSettlementUnguarded`),
armed only at `EXNIHILOPool.sol:1482` and `EXNIHILOPool.sol:1515`,
consumed at `EXNIHILOPool.sol:1058` and `EXNIHILOPool.sol:1176`.

### Root cause

```solidity
function _armSettlementGuard(uint256 usdcValue) internal {
    if (usdcValue * BPS_DENOM >= backedAirUsd * SETTLE_GUARD_BPS) {
        lastLargeSwapBlock = block.number;
    }
}
```

The predicate is evaluated **per call**, against the **live** `backedAirUsd`, and
nothing accumulates across calls or across a block. The design note at
`EXNIHILOPool.sol:234-282` reasons about "a swap that moves `backedAirUsd` by a
fraction f of its depth" — singular. Two independent facts break that:

1. **N sub-threshold swaps in one transaction never arm.** Each call is measured
   against the reserve the previous call already moved, so the threshold shrinks
   as you go and the cumulative move is unbounded.
2. **`openLong` / `openShort` move the same reserves and never arm at all.** This
   is deliberate (`EXNIHILOPool.sol:386-395`), justified on the grounds that they
   "pay a 5 % fee of which the 1 % protocol share is a real loss even to the LP".
   That cost is a fraction of the attacker's *notional*; the prize is a fraction
   of the *victim's mark*. The two are unrelated quantities.

The guard is also the only protection on this path. `closePositionAfterDeadline`
takes `minPayout` from the **caller**, who is the attacker — and `minPayout` is
never checked on the underwater branch (`EXNIHILOPool.sol:1630-1643`; the check
lives at `1647`, inside the `else`). The holder has no lever at all.

### Exploit — verified numerically

Pool: 1,000,000 token / $100,000 USDC. Victim opens a max-size long ($20,000 at
the 20 % cap), price rises, position expires with $6,104.72 of priced surplus →
$6,043.68 net payout. The LP, in one transaction:

**Variant A — split swaps (zero cost, fully atomic, no position opened):**

```
20 × swap(token→USDC, sized just under 1% of live backedAirUsd)
     closePositionAfterDeadline(victimNft, 0)
     swap(USDC→token, all of it back)
```

| | honest | attacked |
|---|---|---|
| guard armed | — | **false** |
| victim payout | $6,043.68 | **$0.00** |
| LP token leg | 809,736.7692 | **809,736.7692** (identical) |
| LP USDC leg | $124,995.28 | **$131,100.00** |
| attacker protocol fee | — | **$0.00** (swaps carry none) |

Net: **+$6,104.72 to the LP, −$6,043.68 to the trader, zero cost, zero risk, one
transaction.** The token leg is byte-identical because the round trip's swap fees
are retained in the LP's own reserves — the mechanism the design note itself
identifies as making this "very nearly free", which the 5-block delay was
supposed to price. Splitting removes the delay entirely.

**Variant B — one `openShort` (never arms at any size):**

| suppressing short | protocol-fee cost | victim payout |
|---|---|---|
| $260 (1 % of cap) | $2.60 | $5,941.29 |
| $2,600 (10 %) | $26.00 | $5,046.78 |
| $6,500 (25 %) | $65.00 | $3,656.86 |
| $13,000 (50 %) | $130.00 | $1,588.07 |
| $26,000 (100 %) | $260.00 | **$0.00** |

Profitable at **every** size (~23–38× on the real cost), so it is not a knife
edge. Full terminal accounting with the attacker's own short held to its expiry
and wiped: LP USDC leg $124,995.28 → $130,840.00, i.e. **+$5,844.72 for $260**.

**Variant C — the mirror.** An expired *short* is suppressed by `openLong` the
same way: honest payout $3,812.31 → **$0.00** for a $129.01 protocol fee, with
`_priceClose` pushed past `priceable` so the trader's entire locked collateral
($20k) reverts to `backedAirUsd`.

### The auto-renew margin does not hold either

`RENEW_MARGIN_BPS` exists so that "any flip needs a swap large enough to arm that
guard". Measured on a position whose honest verdict is RENEW:

| position | 1 non-arming swap | 3 non-arming swaps | `openShort` at 25 % of cap |
|---|---|---|---|
| surplus $413.21, fee $288.02, margin $108.26 | **CLOSE** | **CLOSE** | **CLOSE** |
| surplus $807.96, fee $307.14, margin $116.16 | renew | renew | **CLOSE** |

Two independent reasons: the margin protects only positions clearing it by a
*full* margin (`_renewFees` reprices the fee and the margin from the same
manipulated state, so the threshold moves with the surplus), and `openShort`
moves the mark far past 2 % at any cost the attacker chooses.

### Why I believe it

`AutoRenew.ts:774-806` tests exactly **one** maximal non-arming swap and asserts
`swing < margin`; `AutoRenew.ts:871-880` asserts that opening a position does not
arm the guard, using a $500 open, and treats that as the intended property. No
test exercises repeated sub-threshold swaps, and none exercises a cap-sized open
as a settlement lever. The guard's own doc-comment enumerates the paths it
excludes and prices each one against the wrong quantity.

### Fix (do not apply — coordinator's call)

Arm on **cumulative** USDC-denominated reserve movement within a block, not
per-call, and arm from every path that moves `backedAirUsd` / `airTokenSupply` /
`airUsdSupply` — `openLong`, `openShort`, and `_settle` included. Accumulate into
a `(block.number, movedThisBlock)` pair and arm when the running total crosses
`SETTLE_GUARD_BPS`. Settlement batching can be preserved by exempting `_settle`
from *arming* only while it is not itself preceded by an armed move in the same
block. Separately, enforce `minPayout` on the underwater branch of `_settle` so
the parameter is not silently inert.

---

## HIGH-BSA-R2-2 — `renewPosition` stacks deadlines without bound; `closePool` does not bound them retroactively; LP principal is freezable for ~$61

**Location:** `EXNIHILOPool.sol:1004-1008` (`renewPosition`),
`EXNIHILOPool.sol:511` (`closePool`), `EXNIHILOPool.sol:897` (`removeLiquidity`).

**This supersedes carried finding LOW-BSA-1, whose stated mitigation is false.**

```solidity
uint256 base = pos.deadline > block.timestamp ? pos.deadline : block.timestamp;
uint256 newDeadline = base + currentPositionDuration();
if (closeDate != 0 && newDeadline > closeDate) revert RenewalExceedsCloseDate();
```

A renewal of a *live* position extends from its existing deadline, not from now.
Nothing caps the number of renewals or the absolute deadline while
`closeDate == 0`. `closePool` then sets `closeDate = now + currentPositionDuration()`
— which gates future opens and future renewals but **has no effect on deadlines
already written**. `closePositionAfterDeadline` and `settleExpired` both require
`block.timestamp >= pos.deadline`, so a stacked position cannot be force-settled,
and `removeLiquidity` reverts `OpenPositionsExist` while it lives.

### Exploit

1. Open a dust long. `openLong(1, 0, self)` succeeds on any pool with real depth;
   `_openFees` floors at `MIN_POSITION_FEE` = 0.05 USDC.
2. Call `renewPosition(nftId, type(uint256).max)` 1,217 times. Each call charges
   the floored base fee — `_baseFees(n + surplus)` with `n = 1` floors to 0.05
   USDC, and the impact slice rounds to zero at that notional. No equity test
   applies: unlike auto-renew, `renewPosition` has no solvency gate and works
   while the position is arbitrarily underwater.
3. Deadline is now **100 years out**. Total fees: **$60.85**, plus roughly $140 of
   Avalanche gas.
4. The LP calls `closePool()`. `closeDate` lands 30 days out; the position
   outlives it by a century. `removeLiquidity()` reverts forever.

One dust position freezes **100 % of the pool's principal**, at a cost that is
independent of the pool's size. A $10M pool is frozen for the same $200.

### Why I believe it

`PositionDurationRamp.ts:240-263` ("closeDate is at or beyond every outstanding
deadline") tests only positions that were never renewed — the coverage argument
it encodes is sound for that case and vacuous for the renewed one. The Nemesis R2
pass reached the same conclusion independently and left an executing probe at
`test/ZZNemesisR2.ts:366-372`, which asserts `d5 > closeDate` and then
`PositionNotExpired` / `OpenPositionsExist` on-chain.

This is **not new to this round** — the same stacking existed with the old
`positionDuration` immutable (where the step could be as large as 365 days). The
duration ramp caps the per-renewal step at 30 days, which makes it marginally
cheaper to attack per unit of time bought, not safer. LOW-BSA-1 recorded the
opposite because it assumed `closePool` bounded the wait.

### Fix

Bound `newDeadline` at `block.timestamp + currentPositionDuration()` rather than
extending from `pos.deadline`, or cap the stack (e.g. `newDeadline <= now + DURATION_MAX`).
Either makes `closePool`'s coverage guarantee true for all positions, not just
un-renewed ones.

---

## HIGH-BSA-R2-3 — the holder is exempt from the guard, so a position holder can sandwich their own settlement and drain the LP

**Location:** `EXNIHILOPool.sol:1453` (`if (msg.sender == holder) return;`),
and `closeLong` / `closeShort` at `EXNIHILOPool.sol:710` / `835`, which carry no
guard at all.

The exemption is deliberate and its stated reason is sound — "an armed guard can
never trap a holder in a position". The consequence is that the one direction the
guard does not cover is the one that moves LP capital *out*.

### Exploit — verified

Pool 1,000,000 token / $130,000 USDC, holder's long at mark $26,043 (a genuine,
honestly-opened, in-profit position), expired:

```
swap(USDC→token, $100,000)          // arms the guard — irrelevant, holder exempt
settleExpired(ownNft, 0)            // or closeLong; neither is gated
swap(token→USDC, all of it back)
```

| | honest | sandwiched |
|---|---|---|
| holder receives | $6,043.68 | $49,369.35 gross |
| swap round trip cost | — | $39,641.20 |
| **holder net** | **$6,043.68** | **$9,728.15** |
| LP `backedAirUsd` | $123,895.28 | **$119,773.17** |
| LP `backedAirToken` | 809,736.7692 | 809,736.7692 (identical) |

**$4,122 of LP USDC leaves that would not have under honest settlement** — 3.2 %
of the pool's USDC depth, in one transaction, per close. The token leg is
unchanged, so this is an unambiguous one-sided drain rather than a valuation
artefact. Break-even condition from the model: profitable whenever the position's
**mark exceeds ~1 % of `backedAirUsd`**, and the cap permits marks up to 20 % —
20× the threshold.

### Why this is HIGH and not CRITICAL

I swept the **from-scratch** version (open a position purely to sandwich it, no
external price move) across 4 notionals × 7 swap sizes. **Every** cell is
negative once the open fee is included — best case −$267.66 at 20 % notional.
The 5 % base + OI-integral impact fee genuinely does dominate a manufactured
cycle, exactly as the prior round's `oracle-flashloan-verified.md` concluded.

What the prior round could not see is the **incremental** case, because
`runManipulation` opens the position *inside* the measured window — `before` is
sampled at `ManipulationSafety.ts:138`, `openSide` runs at `:140`. With the
open fee sunk — paid for a directional bet the trader was taking anyway — the
marginal manipulate→close leg stands alone and is profitable. Every legitimately
profitable position in the protocol carries this option.

### Fix

Bound the holder path the way the voluntary path is already bounded: `closeLong`
/ `closeShort` already give the holder `minUsdcOut`, which protects them from
being sandwiched *by others*; the missing piece is protecting the LP from being
sandwiched by the holder. The structural fix is the same cumulative-move
accounting as CRITICAL-BSA-R2-1, applied as a *pricing* constraint rather than a
lockout — e.g. settle against a reserve snapshot that ignores moves made in the
same block, so the holder's own swap cannot inflate their own payout.

---

## MEDIUM-BSA-R2-4 — a PreMarket can be created already at the buyout floor; "cannot be pulled back out, by anyone, ever" is a parameter choice

**Location:** `PreMarket.sol:313-314` (validation),
`PreMarket.sol:354-358` (`currentPrice`), `PreMarket.sol:379-382` (`_buyoutCost`),
`PreMarket.sol:156` (`MIN_BUYOUT_USDC`).

The auction has **no reserve price, no deadline, and no minimum duration**, and
`startPrice` is validated only as `!= 0`:

```solidity
if (c.startPrice == 0) revert InvalidPriceRange();
if (c.decayBpsPerMinute == 0 || c.decayBpsPerMinute > BPS_DENOM) revert InvalidDecayRate();
```

State machine consequence — the SEEDED → BOUGHT-OUT transition can be entered in
the **same block as seeding**:

- `startPrice = 1` ⇒ `currentPrice()` returns 1 from `elapsed = 0`.
- `_buyoutCost(quoteOut, 1) = quoteOut / quoteUnit`, clamped up to
  `MIN_BUYOUT_USDC` = **$1**.
- So 100 AVAX of bonded quote is buyable for **$1**, immediately, by anyone —
  including the party that just seeded it.

Even with the documented calibration (`startPrice ≈ spot × 1.01`,
`decayBpsPerMinute = 200`), the decay is **linear**, so the price reaches the
floor at `60 × 10000 / decayBpsPerMinute` = **3,000 seconds**. After 50 minutes
the entire quote reserve is a $1 lot, permanently. `decayBpsPerMinute = 10000`
(the maximum the constructor allows) collapses that window to **60 seconds**.

The contract header states: "A launchpad can verify from the bytecode that its
liquidity cannot be pulled back out, by anyone, ever." That is true of the
*function surface* and false of the *behaviour*. A launchpad operator holding
third-party bonded quote chooses both parameters, and either choice hands them a
riskless path to take all of it back for $1 while the end user's only visible
guarantee is "no withdraw function exists".

### Fix

Floor the auction: require `decayBpsPerMinute` such that time-to-floor exceeds a
minimum (e.g. ≥ 15 minutes), and either add a reserve price expressed as a
fraction of `startPrice` or make `MIN_BUYOUT_USDC` a seed-time parameter with a
floor tied to the seeded quote. At minimum, emit both parameters in
`PreMarketCreated` so an indexer can surface the real lock-up terms.

---

## LOW-BSA-R2-5 — the PreMarket TRADING phase is an unrestricted AMM, so the seeded quote is recoverable by any large token holder

**Location:** `PreMarket.sol:416-452`.

`swap` has no size limit, no per-address limit, and no restriction on the seeder.
Anyone holding the token in size — which for a freshly launched project token
means the project itself — can push token in and pull the quote out along the
curve for a 1 % fee and slippage. Seeding is irreversible in the sense that no
`withdraw` exists; it is reversible in the sense that matters. Combined with
MEDIUM-BSA-R2-4 (buy out the drained shell for $1), a seeder can recover
substantially all of the bonded quote and still produce a "launched, LP-locked"
market at a garbage ratio. The `LockedLpVault` guarantee is real, but it only
attaches at LAUNCH, and there is nothing to lock by then.

---

## LOW-BSA-R2-6 — `PreMarket` does not validate `token != usdc`, so a premarket can be seeded into a permanently unlaunchable state

**Location:** `PreMarket.sol:302-314` vs `EXNIHILOFactory.sol:196`.

The factory gained `if (tokenAddress == usdc) revert TokenIsUsdc();` this round
(SCOPE item 10). `PreMarket`'s constructor checks `token`, `quote`, `usdc`,
`factory`, `creator`, `lpOwner` for zero and `usdc == factory.usdc()`, but never
compares `token` against `usdc` (nor against `quote`). A premarket seeded with
`token == usdc` reverts inside `factory.createMarket` on every future `buyout()`
call, forever. Since there is no expiry, refund, or withdrawal path, the LAUNCH
transition is permanently unreachable.

This directly violates the contract's own stated rule
(`PreMarket.sol:107-109`): "Market parameters are validated at seed time, not at
buyout. With no expiry path, a pool constructor revert during buyout would strand
the premarket's liquidity permanently." The rule is right; the new factory guard
was not mirrored into it.

---

## LOW-BSA-R2-7 — both ramps are anchored to pool age, not to liquidity, and are bypassable by pre-aging an empty pool

**Location:** `EXNIHILOPool.sol:552` (`createdAt`), `1290-1295`, `1310-1317`,
`1828-1831`.

`currentMaxPositionBps()` and `currentPositionDuration()` both read
`block.timestamp - createdAt`. `createMarket` requires only `usdcAmount > 0 &&
tokenAmount > 0`, so a pool can be created with dust at the intended ratio, left
for 24 hours (cap → 20 %) or 7 days (duration → 30 days), and only then funded
via `addLiquidity` — whose ratio check preserves the seeded price. From the first
block of real depth the market offers full size and 30-day lifetimes with no
price history at all, which is precisely the state both ramps exist to prevent
("lets the market prove itself before it accepts real size").

Secondarily, `_checkLeverageCap` measures the cap against `backedAirUsd`, which
any caller can inflate in the same transaction with a USDC→token swap. That path
is self-limiting — raising the cap by ΔC costs a round trip on `10000/bps × ΔC`,
i.e. ~10 % of ΔC at the 20 % cap and ~200 % during the first hour — so it is
noted as bounded rather than reported as exploitable. The `createdAt` anchor is
the cheap bypass.

---

## LOW-BSA-R2-8 — `minPayout` is inert on the underwater branch of `_settle`

**Location:** `EXNIHILOPool.sol:1630-1643` vs `EXNIHILOPool.sol:1647`.

The slippage bound is checked only inside the `else` (in-surplus) branch. A
settlement manipulated into `deficit > 0` or `!priceable` takes the underwater
path, releases the NFT, and credits nothing — regardless of what `minPayout` the
caller passed. Any keeper or holder passing a non-zero `minPayout` as protection
has none in exactly the case it was needed. This is the reason
CRITICAL-BSA-R2-1's variants terminate at $0.00 rather than reverting.

---

## INFO-BSA-R2-9 — `factory.deployer()` can terminate a "permanently locked" premarket-launched market

`closePool` (`EXNIHILOPool.sol:501-514`) accepts `factory.deployer()` as well as
the LP holder. When the LP holder is a `LockedLpVault`, the vault has no code
path that calls `closePool` — but the deployer does. Closing the pool blocks all
future `openLong`/`openShort`, which is the vault's only income source, so the
fee stream the vault exists to split can be ended unilaterally by a protocol-level
EOA. The liquidity remains locked (the vault cannot call `removeLiquidity`), and
`swap` is not gated on `closeDate`, so post-closure spot volume keeps retaining
fees into reserves that nobody can ever withdraw. Same substance as
INFO-BSA-1 / NM-OP5-002, but the consequence is materially different once a
third party has been sold a permanence guarantee.

## INFO-BSA-R2-10 — manipulation-suite coverage notes

- `ManipulationSafety.ts:138-140` samples the attacker's portfolio *before*
  `openSide`, so the open fee is inside every measurement. That is the correct
  test for a manufactured cycle and structurally cannot detect HIGH-BSA-R2-3.
- The sweep's `NOTIONAL_FRACS` reach 5000 and 9000 bps, both above the new 20 %
  cap. Those cells now revert at open and are excluded by the
  `opened && net > 0n` filter, so the grid silently lost its largest cases while
  still reporting "no drains".
- No suite exercises repeated sub-threshold swaps in one transaction.

---

## Carried findings — disposition

| ID | Status |
|---|---|
| **LOW-BSA-1** — "LP exit requires all positions settled, bounded by `closePool`" | **Does not hold. Superseded by HIGH-BSA-R2-2.** The bound is real only for positions that were never renewed; `renewPosition` stacks deadlines past any later `closeDate`. `renewPosition` does still require `ownerOf(nftId) == msg.sender` (`EXNIHILOPool.sol:995`), so the NM-004 half of the finding remains closed. |
| **INFO-BSA-1** — emergency deployer is a state-machine actor | **Holds**, and is sharper now — see INFO-BSA-R2-9. |
| **INFO-BSA-2** — auto-renew is holder-authorized, keeper-executed | **Holds structurally** (opt-in, `maxFee` cap, `closeDate` bound, cleared on transfer at `PositionNFT.sol:389-399`), but `KEEPER_BOUNTY` is gone so the flat-bounty reasoning is void, and the renew/close verdict is now flippable by a third party — see CRITICAL-BSA-R2-1. |
| **NM-003** — "no keeper incentive", previously closed by `KEEPER_BOUNTY` | **Re-opened, and now benign.** Nobody is paid to settle. In practice the holder settles their own profitable position and the LP settles underwater ones to reclaim collateral, so both outcomes have a motivated party. The residual is that a *worthless* expired position has nobody motivated to clean it up — which, via `openPositionCount`, is the same lever HIGH-BSA-R2-2 exploits deliberately. |

---

## Checked and found clean

**`LockedLpVault` — the vault/revenue-share threat set found nothing.**
- The lock guarantee is real: the only pool call anywhere in the contract is
  `claimFees(address(this))` (`LockedLpVault.sol:216`). No `removeLiquidity`,
  `addLiquidity`, `closePool`, `transferFrom`, `approve`, or `setApprovalForAll`
  exists, and `setApprovalForAll` can only be issued by the vault itself, which
  has no such code. The NFT cannot leave.
- `_harvest`'s `balanceOf - lpAccrued - integratorAccrued` (`:221`) cannot
  underflow: the only USDC exits are the two claims, and each zeroes its own
  accrual in the same statement it transfers. Verified by exhausting the exit
  paths, not by trusting the comment.
- Neither role can touch the other's balance, change `integratorBps` (immutable),
  or block the other. A lost integrator key strands only the integrator's share.
- `poolOf(lpNftId) != pool_` in the constructor (`:179`) correctly prevents a
  vault pointed at the wrong market; `poolOf` reverts on an unminted id, so a
  fabricated pairing cannot pass.
- Rounding dust favours the LP by ≤ 1 wei per harvest. The Nemesis R2 pass has a
  probe on 1-unit harvest granularity; the smallest real accrual is 40,000 wei
  (the LP share of `MIN_POSITION_FEE`), so the achievable extraction is bounded
  at ~$1 per million harvests. Not material.

**`PreMarket` state machine — no transition can be entered twice or skipped.**
`launched` is written before every external call in `buyout` (`:501`), and both
`swap` (`:422`) and `buyout` (`:484`) reject on it. Contract-level
`ReentrancyGuard` covers both, so a callback token cannot re-enter either.
Reserves cannot be fully drained (`getAmountOut`'s denominator strictly exceeds
its numerator's fee term, so `reserveOut - amountOut >= 1`), which keeps
`createMarket`'s `ZeroAmount` unreachable. The seeding window — reserves recorded
in the constructor before `PreMarketFactory._pullExactTo` delivers them
(`PreMarketFactory.sol:154-155`) — is reachable by a callback in an
attacker-supplied `quote`, but every path out of it requires the attacker to pay
real assets into their own premarket. No cross-victim path exists.

**Pool accounting through the new paths.** `_tryAutoRenew`'s long branch keeps
`longOpenInterest` and `pos.airUsdMinted` in lockstep (`EXNIHILOPool.sol:1131-1135`)
so `_settle`'s `longOpenInterest -= pos.airUsdMinted` cannot underflow; the short
branch leaves `pos.usdcIn` and `shortOpenInterest` untouched, which is also
consistent. `backedAirUsd -= cost` cannot underflow because
`_autoRenewQuote` requires `surplus >= totalFee + margin` and `surplus` is itself
bounded by `backedAirUsd`. `airUsdSupply` is correctly left flat on a long
auto-renew (reserve out, debt in). The `_assertReserveInvariant` USDC arm now
covers `totalShortCollateral`, and it held across every state my model produced.

**Duration-ramp monotonicity.** `currentPositionDuration` is non-decreasing in
age, and for an un-renewed position `t_open < t_close ∧ D(age_open) <= D(age_close)`
gives `deadline < closeDate` at every step boundary. The property `closePool`
depends on is sound; only renewals break it (HIGH-BSA-R2-2).

**Authorization state.** Every transition still gates on live ownership
(`lpNftContract.ownerOf`, `positionNFT.ownerOf`) rather than a cached address, so
transferring either NFT moves control atomically with no stale-authority window.
`PositionNFT._update` clears the auto-renew opt-in on every ownership change, so
a buyer never inherits a keeper authorization. `mintLong`/`mintShort` require
`msg.sender == pool` **and** `factory.isPool(pool)`; `release` and `applyRenewal`
require `msg.sender == pos.pool`. `initFactory` is one-shot and deployer-gated.

**Router.** `EXNIHILORouter` holds no state between transactions, pulls only the
pool-quoted fee, revokes approvals, and refunds residual against a pre-call
balance snapshot so a prior donation is never attributable to the current caller.
`onlyPool` gates every entry. Nothing to report.

**`Faucet.sol`** is testnet-only (`usdc.mint`), has an owner with `withdraw()`,
and is not referenced by any mainnet deploy script. No finding, but it should not
be in the mainnet verification set.
