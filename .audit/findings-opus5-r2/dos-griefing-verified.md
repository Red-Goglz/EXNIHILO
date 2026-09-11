# DoS & Griefing — Verified (Opus 5 R2)

**Date:** 2026-08-20
**Baseline:** `.audit/findings-opus5/` @ `5197494`; this pass audits the working tree at `c02af1d`
**Scope covered:** `EXNIHILOPool` (settlement guard, expiry/renewal, claims, liquidity),
`PreMarket`, `PreMarketFactory`, `LockedLpVault` (all three previously unaudited),
`EXNIHILOFactory`, `PoolDeployer`, `PositionNFT`, `EXNIHILORouter`, `LpNFT`, `Faucet`

```
1 CRITICAL | 0 HIGH | 1 MEDIUM | 4 LOW | 8 INFO
```

Every finding below has a runnable proof-of-concept. The PoC file is archived at
`C:\Users\sschu\AppData\Local\Temp\claude\C--dev-projects-exnihilo-dapp\269af955-6b7d-4fb7-8710-4f30099858dc\scratchpad\dos-poc.ts`
(it was run from `packages/blockchain/test/` and removed again — the repo is unchanged).

---

## Structural result: the unbounded-loop class is still absent

```
grep -nE "for \(|while \(" contracts/*.sol contracts/test/*.sol   →  zero matches
```

Confirmed again across all ten contracts, including the three new ones. There is no
iteration over any user-growable collection anywhere in the protocol. Classes 1
(unbounded loop), 2 (batch external-call failure) and 4 (storage bloat via iteration)
have no surface here. `EXNIHILOFactory.allPools` (`EXNIHILOFactory.sol:101`) and
`PreMarketFactory.allPreMarkets` (`PreMarketFactory.sol:51`) grow permissionlessly but
are never iterated on-chain; `allPools.length` is read as an O(1) LP-NFT-id predictor
(`EXNIHILOFactory.sol:224`).

---

## CRIT-DOS-1 — the new settlement guard is evaded by splitting one swap into twenty

**Severity:** CRITICAL (pre-launch — the live mainnet deploy predates this code)
**Location:** `EXNIHILOPool.sol:1437` (`_armSettlementGuard`), `:1452` (`_assertSettlementUnguarded`),
`:1482` / `:1515` (the two arming call sites), `:1100-1102` (`RENEW_MARGIN_BPS` test)
**Class:** the guard is a block-window lock whose arming predicate is per-call, not per-block

### The claim being tested

`SETTLE_GUARD_BPS` is documented at `:248-277` as bounding the achievable manipulation:

> *"Capping f at SETTLE_GUARD_BPS therefore caps the swing at SETTLE_GUARD_BPS × mark,
> and a margin of RENEW_MARGIN_BPS × mark above that bound cannot be crossed by any swap
> small enough to evade the guard."*

That is true of **one** swap. `_armSettlementGuard` is called once per `swap()` and compares a
single trade's USDC leg against the reserve **as it stands at that moment**:

```solidity
function _armSettlementGuard(uint256 usdcValue) internal {
    if (usdcValue * BPS_DENOM >= backedAirUsd * SETTLE_GUARD_BPS) {
        lastLargeSwapBlock = block.number;
    }
}
```

There is no per-block accumulator and no anchor to the block's opening reserves. `swap()` has
no per-caller or per-block rate limit, and `nonReentrant` only guards re-entry *within* one
call, so a contract can call `swap()` n times and then `settleExpired()` — all in one
transaction. Each slice is measured against a reserve the previous slice already moved, so n
slices of 0.99 % compound to a ~1 − 0.99ⁿ move while every individual slice tests clean.

### Verified exploit

Pool: 100,000 USDC / 1,000,000 token. Holder opens a 5,000 USDC long (5 % of depth, well
under the 20 % cap), price rises, position expires. Attacker fires 20 sub-threshold
token→USDC dumps and a settlement into a **single block**:

| | honest settlement | after 20-slice batch |
|---|---|---|
| `lastLargeSwapBlock` | unchanged | **unchanged — guard never armed** |
| holder payout (no auto-renew) | 3,881.67 USDC | **1,045.09 USDC** |
| holder payout (auto-renew opted in, near boundary) | 505.59 USDC | **0.00 USDC, position force-closed** |

Both variants ran with `evm_setAutomine(false)`, all swaps plus the settle queued into one
block — no third party can interleave, and no arbitrageur ever sees the displaced price.
`settleExpired` / `closePositionAfterDeadline` succeeded, which is itself the proof the guard
never fired.

The auto-renew variant is the sharper one: the holder had opted in via
`PositionNFT.setAutoRenew`, `closePositionAfterDeadline` correctly reverted `AutoRenewActive`
before the attack, and after 20 slices the same call **succeeded and paid zero** — the
suppression pushed the position into `_settle`'s underwater branch (`EXNIHILOPool.sol:1630-1643`),
so the locked collateral went to `backedAirToken` and the holder received nothing. That is
principal destruction, not just profit suppression.

### Who profits, and at what cost

The suppressed payout does not leave the pool — it stays in `backedAirUsd`, i.e. it becomes LP
equity. So:

- **A non-LP attacker griefs**: ~40 bps of depth in swap fees (20 slices out + 20 back) to
  destroy 2,836 USDC of a holder's profit on a 100k pool. A 7:1 destruction ratio.
- **The pool's own LP steals it, for free.** Measured directly: ten arm-and-restore round
  trips moved 201.15 USDC out of the LP's wallet and 201.15 USDC into `backedAirUsd` —
  **net 0.00 USDC**, with zero residual token exposure. The swap fee is retained by *not*
  reducing the output-side backed reserve (`:1486-1489`, `:1519-1522`), and the sole LP owns
  those reserves. Gas is the LP's entire cost.

Anyone can become an LP: `createMarket` is permissionless (`EXNIHILOFactory.sol:182`). Seed a
market, attract traders, harvest every expiring position at a price you set atomically.

### Why the guard does not stop it

The guard's cost model is "the manipulator must survive `SETTLE_GUARD_BLOCKS` of arbitrage
exposure" (`:280-282`). That model assumes the manipulator must *arm* the guard to move the
price enough to matter. Two separate measurements show it does not hold:

1. **Arming without exposure.** A two-block round trip arms the guard, restores `backedAirToken`
   exactly, and leaves the griefer flat — measured cost 20.10 USDC on a 100,000 USDC pool
   (**2 bps of depth**), zero directional position. The 5 blocks of "exposure" are not exposure.
2. **Moving the price without arming.** The batch above never armed it at all, so the 5-block
   window is irrelevant to the attack.

The guard does close the naive single-swap version, and it raises the attacker's gas ~20×.
That is all it does.

### Fix

Anchor the arming test to the block, not to the individual call. The cleanest form also happens
to be the tightest: record `backedAirUsd` as it stood at the **start of the current block** (one
SSTORE on the first reserve-mutating op per block), then have `_assertSettlementUnguarded`
additionally reject when the live reserve differs from that anchor by ≥ `SETTLE_GUARD_BPS`.

This closes the atomic attack by construction: the attack must settle *while* the reserves are
displaced, so the displacement is visible at exactly the moment the check runs, regardless of
how many calls produced it. Keep the existing 5-block window on top, for the cross-block
manipulation it already handles. Note that a *net*-movement test is not sufficient — an
attacker who moves and restores inside the block still settles at the displaced price, so the
comparison must be against the block-opening anchor, evaluated at settlement.

Please have the manipulation / oracle pass cross-rate this: the DoS framing here is
"force-close against the holder's opt-in", but the extraction framing is the more severe one.

---

## MED-DOS-1 — a PreMarket can be pushed into a state where it can never launch, stranding both legs

**Severity:** MEDIUM
**Location:** `PreMarket.sol:515-519` (`factory.createMarket` inside `buyout`),
`PreMarket.sol:301-333` (constructor validation), `PreMarketFactory.sol:120-121`,
`EXNIHILOFactory.sol:196` (`TokenIsUsdc`), `EXNIHILOPool.sol:1844-1850` (`_transferIn`)

`PreMarket` documents an absolute liveness guarantee at `:143-156` and `:466-471`:

> *"there is no state in which the reserves become unbuyable, and therefore none in which they
> are stranded"*

That guarantee holds for the auction pricing — `MIN_BUYOUT_USDC` genuinely removes the
zero-cost terminal state. It does **not** hold for the four ERC-20 movements `buyout` must
complete after pricing. There is no refund, expiry, withdrawal or rescue path anywhere in
`PreMarket` or `PreMarketFactory`, so any permanent failure of those transfers is permanent
loss of the seeder's token **and** the launchpad's bonded quote.

Two paths verified:

**(a) The project token turns its transfer fee on after seeding.** `PreMarketFactory._pullExactTo`
(`:176-182`) rejects fee-on-transfer at seed time, and so does `PreMarket._pullExact` (`:555`) on
every swap — but nothing re-checks at buyout, and the pool's own `_transferIn`
(`EXNIHILOPool.sol:1844`) does. Chain: `buyout` → `createMarket` → `pool.addLiquidity`
(`EXNIHILOFactory.sol:241`) → `_transferIn` → `FeeOnTransferNotSupported`.

PoC: seed with the fee off (buyout succeeds — verified against a snapshot), call
`enableFee()`, and `buyout` reverts. Still reverts after full auction decay. 500 quote units
sit in the premarket with no exit. The token's own admin controls the switch, so a project can
hold a launchpad's bonded liquidity hostage — or destroy it — at will. The existing FoT test
(`test/PreMarket.ts:859-884`) covers the *quote* asset on the `swap` path only; the token-side
buyout path is untested.

The same shape applies to any post-seed change that makes a transfer fail: the token
blacklisting the PreMarket address, the pool address, or the factory; or an `approve` that
`forceApprove` cannot satisfy.

**(b) `token == usdc`.** Neither `PreMarketFactory.createPreMarket` (`:120-121`) nor
`PreMarket`'s constructor (`:302-314`) rejects it, but `EXNIHILOFactory.createMarket` does
(`:196`, `TokenIsUsdc`). PoC: the premarket is created happily and `buyout` reverts
`TokenIsUsdc` forever. Self-inflicted rather than griefable, but a launchpad integrating by
API can trip it, and the failure is silent until buyout — by which point the funds are already
irrecoverable.

**Fix.** (i) Mirror `EXNIHILOFactory`'s input validation into `PreMarket`'s constructor —
`token != usdc`, `token != quote` — so a doomed premarket cannot be created. (ii) For (a),
either accept that the guarantee is conditional and say so in the header, or add a
launch-failure escape: a `rescue()` callable by `creator` only when `buyout` has demonstrably
reverted, returning both legs. A one-way commitment is the product, so the second option needs
care — but the current text promises something the code does not deliver.

---

## LOW-DOS-3 — the settlement guard is a cheap third-party liveness lock, and free for the LP

**Severity:** LOW
**Location:** `EXNIHILOPool.sol:1437` (`_armSettlementGuard`), `:1452-1458`, `:574-592` (`swap`
has no `closeDate` gate)

Separate from CRIT-DOS-1: even used *as designed*, the guard hands any third party a
repeatable block on settlement.

**Cost to arm, measured:** a token round trip arms the guard and restores the price in two
blocks for 20.10 USDC on a 100,000 USDC pool — **2 bps of depth, zero residual exposure**.
The design comment at `:280` calls the 5 blocks "arbitrage exposure a manipulator must
survive"; the arm-and-restore pattern has none.

**Cost to hold it continuously:** ~2 s Avalanche blocks × 5 = one arming per 10 s = 8,640
armings/day. At 2 bps each that is ~1.7× the pool's entire USDC depth per day (172,800 USDC/day
on a 100k pool) — and every cent of it lands in the LP's reserves. **Sustained griefing by a
non-LP is not economically viable.** Retry asymmetry compounds that: a blocked party retries for
a cent of gas while the griefer pays 2 bps per window.

**But not for the LP.** Ten armings measured: LP wallet −201.15 USDC, pool reserves +201.15 USDC,
**net 0.00**. The LP recycles its own capital into reserves it owns. For a normal LP that is a
wash; only for a `LockedLpVault`-owned pool is it a real (unrecoverable) cost.

**What is actually blocked, and for whom.** The guard gates only `settleExpired` (`:1058`) and
`closePositionAfterDeadline` (`:1176`). The holder is exempt (`:1453`), which I verified is
airtight — `closeLong`/`closeShort`, `renewPosition`, `claimPayout`, `claimFees` and
`removeLiquidity` are all unguarded. **A holder can never be trapped in a position, and a
bleeding position can always be exited by its owner.** The griefer's only victims are:

- **Keepers acting for absent holders** — in particular auto-renew users, who by construction
  are not online at expiry. A held guard can stall a renewal until price drift pushes surplus
  below `totalFee + margin`, converting an opted-in renewal into a close. The guard stops an
  attacker *choosing* the price atomically (modulo CRIT-DOS-1); it does not stop one choosing a
  10-second window and letting the market choose.
- **The LP's own wind-down.** Verified: after `closePool()` and `closeDate`, a griefer arms the
  guard and the LP cannot `settleExpired` an absent holder's position, so `removeLiquidity`
  reverts `OpenPositionsExist`. `swap` has no `closeDate` check (`:574`), so the arming route
  stays open forever. The LP exits the moment the griefer stops paying — also verified.

**On expiry interaction, specifically.** A position can freely expire while the guard is armed;
expiry is timestamp-driven and the guard is block-driven, and there is no upper time bound on
either settlement entry point (so no block-stuffing surface, Class 7 clean). Nobody "eats a
difference" in a fixed sense: settlement prices at whatever the reserves say when it lands, so
the holder bears adverse drift and the LP favourable drift — symmetric with any keeper delay.
The bounded cost is ≤5 blocks of drift per arming.

Reported LOW rather than dismissed because the cost model in the code comment overstates the
attacker's cost by assuming exposure that arm-and-restore removes. Fixing CRIT-DOS-1 with a
block-anchored check would also fix this: an arm-and-restore round trip nets to zero
displacement at settlement time and would stop blocking anything.

---

## LOW-DOS-4 — `LockedLpVault` discards the pool's blacklist escape hatch

**Severity:** LOW
**Location:** `LockedLpVault.sol:215-216`, against `EXNIHILOPool.sol:926-936`

The pool's `claimFees` takes a destination precisely so a recipient that cannot receive USDC can
redirect — that is the documented remediation for R1's DoS-2 and the reason `LOW-DOS-1` was
downgraded. `LockedLpVault` hardcodes itself as that destination:

```solidity
if (pool.lpFeesAccumulated() != 0) {
    pool.claimFees(address(this));      // LockedLpVault.sol:216
}
```

The vault is the LP NFT's permanent owner and has no `transferFrom`, no approve, and no
generic call path by design (`:46-53`), so `claimFees` can only ever be reached through this
line. If the vault address is ever USDC-blacklisted, `harvest()`, `claimLpFees()` and
`claimIntegratorFees()` all revert forever and the market's entire LP fee stream — the base
4 % of notional plus 100 % of impact fees — is stranded in the pool with no recipient that can
ever collect it. The vault's own header calls the `to` parameter out as the reason a blocked
party "can still redirect their own balance" (`:72-78`); that holds for the two claim functions
but not for the pool-to-vault hop they depend on.

Realistic? A permissionlessly-deployed vault is not a likely blacklist target on its own. But
the failure is total and irreversible for that market, and the mitigation is one parameter.

**Fix:** give `harvest` a destination for the pool-side pull, or hold a settable `sink` address
the two role-holders jointly control. Note that `claimLpFees`/`claimIntegratorFees` also fail
outbound if the vault is blacklisted, so a full fix routes the pool's payout past the vault
entirely rather than through it.

Everything else in the vault checked clean — see below.

---

## LOW-DOS-1 (carried from R1) — blacklisted treasury blocks its own fee claims

**Status: still holds, unchanged.** `EXNIHILOPool.sol:944-955` is byte-identical in intent:
gated on `msg.sender == protocolTreasury`, sends to an arbitrary `to`. A blacklisted treasury
redirects; nothing else in the pool is affected. Remains the downgraded form of the original
finding.

## LOW-DOS-2 (carried from R1) — `factory.deployer()` can force-close every pool

**Status: still holds, with a new wrinkle.** `EXNIHILOFactory.sol:93` / `:273-276`
(`setDeployer`, still a single mutable EOA, still zeroable) and `EXNIHILOPool.sol:501-514`
(`closePool`, LP-or-deployer) are unchanged.

New in this round: `LockedLpVault` deliberately has **no** `closePool` path (`:46-53`). So for
every market launched through `PreMarket`, `factory.deployer()` is the *only* address that can
ever wind the pool down. The factory's own doc recommends renouncing that role to zero
(`EXNIHILOFactory.sol:264-271`). Renouncing therefore makes every vault-owned market
permanently un-closeable — which is the intended lock, but it means the same role is
simultaneously a griefing risk (it can close every pool) and the sole liveness path for
vault-owned pools. That tension should be a conscious decision, not a side effect. No funds are
at risk either way: positions remain settleable by anyone at any time in both configurations.

---

## Re-examining NM-003 — the `KEEPER_BOUNTY` closure is void

`KEEPER_BOUNTY` is gone; `grep -rn "KEEPER_BOUNTY" contracts/` returns only a doc reference at
`EXNIHILOPool.sol:1025` explaining its removal. R1 closed NM-003 ("no caller incentive") on the
bounty's existence, so that closure no longer stands. Re-examined from scratch:

**Is the pool ever stuck if nobody settles?** No. `settleExpired` and
`closePositionAfterDeadline` are permissionless, have no upper time bound, and cost only gas.
`_priceClose` returning `priceable == false` (`:1563`, `:1577`, `:1583`) routes into `_settle`'s
underwater branch rather than reverting, so even a position the math cannot value can always be
cleaned up. There is no state in which a position becomes uncloseable.

**Is anyone motivated?** Yes — better than the 0.05 USDC bounty was:

| Position state at expiry | Who wants it settled | Why |
|---|---|---|
| Profitable | holder | collects the payout; exempt from the guard |
| Renewable (auto-renew on) | LP **and** treasury | `_renewFees` pays 4 % of mark + full impact fee to the LP, 1 % to the treasury (`:1781-1801`) |
| Underwater | LP | collateral returns to reserves, synthetic debt cancelled, curve un-distorted |
| Marginal | LP | decrements `openPositionCount`, which gates `removeLiquidity` |

Every expired position has at least one identified party with a positive economic reason to
call. The removed bounty was a flat 0.05 USDC — below Avalanche gas at times and, as the code
comment notes, capable of exceeding the payout it was carved from.

**Residual, and it is real.** There is now no *permissionless self-funding* incentive. For a
`LockedLpVault`-owned pool the incentive is one hop removed: the vault itself cannot call
`settleExpired` (no such path), so the `lp` and `integrator` EOAs must pay gas from their own
wallets to earn a fee that accrues to the vault and is then split. Still strongly positive
(≈$20 net on a $1,000-mark renewal for ~$0.02 of gas), but it depends on an off-chain party
choosing to act. A position nobody settles keeps its optionality for free and its synthetic
debt keeps distorting SWAP-2/3 for everyone else. **INFO, not a finding** — anyone can settle
at any time for gas, and no funds are stuck — but NM-003 should be recorded as *re-closed on
economic-alignment grounds*, not as still-closed-by-bounty.

Removing the bounty also removed a push transfer to `msg.sender` from the settlement flow,
which is a strict improvement to this pass's threat model.

---

## Confirming R1's DoS-2 (blacklisted holder blocks LP exit) — still closed

Re-derived from the diff rather than assumed. Every USDC egress in the pool:

| Path | `EXNIHILOPool.sol` | Recipient | Blockable by a third party? |
|---|---|---|---|
| `claimFees(to)` | `:934` | caller-chosen | no |
| `claimProtocolFees(to)` | `:953` | caller-chosen | no |
| `claimPayout(to)` | `:971` | caller-chosen | no |
| `_settle`, expiry | `:1666` → `_creditPayout` | **pure state write** | no |
| `_settle`, voluntary | `:1669` | `holder`, and `holder == msg.sender` is enforced at `:712`/`:837` | no |
| `removeLiquidity` | `:910`, `:914` | `msg.sender` | no |
| `swap` | `:1493`, `:1526` | caller-chosen `recipient` | no |
| `_tryAutoRenew` | — | no transfer at all, accrual only | no |

`_creditPayout` (`:1878-1883`) cannot fail. `positionNFT.release` → `_burn`
(`PositionNFT.sol:403-410`) invokes no receiver hook. So no holder — blacklisted, a reverting
contract, or otherwise — can block cleanup, and `removeLiquidity` is reachable once positions
clear. `test/BlacklistResilience.ts` covers exactly this, including
*"LP can removeLiquidity after cleaning up blacklisted holder's expired long"*. **Closed.**

R1's NM-004 (any third party could renew a position to trap LP capital) is also still closed:
`renewPosition` gates on `positionNFT.ownerOf(nftId) != msg.sender` (`:995`), and the
auto-renew path requires the holder's own opt-in (`PositionNFT.sol:367-376`), cleared on every
transfer (`:389-399`).

---

## Checked and clean

**Class 3 — 63/64 insufficient-gas griefing.** No relayer, meta-transaction, or signature
pattern anywhere. No low-level `.call` in any production contract (`Faucet.sol:49`/`:73` are
the only ones, and the Faucet is testnet-only — `scripts/deployMainnet.ts:8` names it as such
and it is absent from `mainnetAddresses.json`). The three `try`/`catch` sites over untrusted
code — `EXNIHILOFactory.sol:210`, `PreMarketFactory.sol:127`, `PositionNFT.sol:427-447` — can be
made to burn gas by a malicious token, but the failure mode is a reverted transaction for the
caller who chose that token, never a permanent state change on a third party. No path marks
work as done on a failed call.

**Class 6 — force-feeding / `address(this).balance`.** Zero uses in production
(`Faucet.sol:45-46`, `:73` only, and only to clamp its own payout). No `selfdestruct` anywhere.
`_assertReserveInvariant` (`EXNIHILOPool.sol:1903-1922`) reads `balanceOf` strictly as a
**lower bound** — donating tokens can only make it more satisfied, never break it. I re-checked
this against the new `totalShortCollateral` term at `:1916`: still a lower bound, no equality
test. Clean.

**Class 5 — timestamp / cooldown griefing.** `createdAt` is immutable, `closeDate` is one-way,
`PreMarket.startTime` is immutable so auction decay cannot be reset, and `pos.deadline` is
extendable only by the holder. The one resettable timing mechanism in the protocol is
`lastLargeSwapBlock` — that is LOW-DOS-3 above.

**Class 7 — block stuffing.** No time-sensitive operation has an upper bound. `settleExpired`,
`closePositionAfterDeadline` and `PreMarket.buyout` are all callable indefinitely after their
lower bound. The `RenewalExceedsCloseDate` bound at `:1008` is a designed wind-down, not a
stuffable race — and the holder controls its timing.

**Block gas limit on `buyout`.** Measured: `PreMarket.buyout` costs **4.27 M gas** (it deploys an
`EXNIHILOPool` *and* a `LockedLpVault` inline). Avalanche C-Chain's 15 M limit leaves ample
headroom, so there is no gas-limit strand. Flagging the number so it is not accidentally grown:
a future pool or vault expansion could approach it, and `buyout` is the only exit from a
`PreMarket`.

**`LockedLpVault` — neither party can block the other.** `harvest()` is permissionless and
accrual-only; `claimLpFees`/`claimIntegratorFees` (`:244-279`) each touch only their own
accrual, take a destination, and cannot be reached by the counterparty; `setLp`/`setIntegrator`
(`:291-309`) each require the current holder and cannot zero the other side. No loops, no push
payments, no `address(this).balance`. The `amount = balanceOf - lpAccrued - integratorAccrued`
underflow claim at `:221` is correct — `lpCut + integratorCut == amount` exactly (`:225-226`),
so `lpAccrued + integratorAccrued == balance` after every harvest and claims decrement both
together. Only LOW-DOS-4 above.

**`PreMarket` griefing that does *not* work.** Front-running a `buyout` with a swap to move
`quoteReserve` reverts the buyout via `maxUsdc`/`minQuoteOut` (`:497-498`), but costs the
griefer the 1 % AMM fee each time and the buyer simply retries with wider bounds — bounded,
LOW-adjacent, not reported separately. `tokenReserve` cannot be driven to zero (constant-product
is asymptotic; `getAmountOut` at `:402` is strictly less than `reserveOut`), so
`createMarket`'s `tokenAmount == 0` guard cannot be tripped. `usdcIn ≥ MIN_BUYOUT_USDC` always,
so the `usdcAmount == 0` guard cannot be tripped either. `EXNIHILOFactory` enforces **no**
one-pool-per-token uniqueness, so pre-creating a market for the same token does *not* block a
premarket's launch — I checked this specifically because it would have been a clean permanent
strand.

**`PoolDeployer`** uses plain `CREATE` (`:24`), so there is no CREATE2 address-collision or
front-run-the-salt surface.

**`LpNFT.mint`** uses `_mint`, not `_safeMint` (`LpNFT.sol:75`), so no receiver hook can block
market creation. `PositionNFT` does use `_safeMint` (`:296`, `:325`) with a caller-supplied
`recipient`, but a reverting receiver only fails the opener's own transaction.

---

## INFO

1. **NM-003 must be re-recorded.** Closed on economic alignment, not on a bounty that no longer
   exists. Detail above.
2. **`settlementGuardArmingSize()` under-reports by up to one atom.** `:1211-1213` floors
   `(backedAirUsd * 100) / 10000`, so a swap at *exactly* the reported size fails to arm the
   guard whenever `backedAirUsd % 100 != 0`. `test/AutoRenew.ts:763` passes only because the
   fixture's reserve happens to be divisible by 100. Harmless as a keeper's "stay below this"
   threshold, wrong as an "arm at this" threshold. Return the ceiling, or document the direction.
3. **Junk-market bloat.** `createMarket(token, 1, 1)` is valid (`EXNIHILOFactory.sol:197` only
   checks non-zero) and deploys a real pool for ~4 M gas. Thousands of junk markets would bloat
   `allPools`, the indexer's `factory()` source, and any frontend pool list, for a few hundred
   dollars. No on-chain iteration means no on-chain DoS; this is an off-chain cost. A minimum
   USDC seed would remove it.
4. **Vault split rounding favours the LP by ≤1 atom per harvest.** `integratorCut = amount *
   bps / 10000` floors (`LockedLpVault.sol:225`). `harvest()` is permissionless, so anyone can
   call it at dust amounts to round the integrator's share away. Uneconomic by orders of
   magnitude — `MIN_POSITION_FEE` puts a 40,000-atom floor on LP accruals
   (`EXNIHILOPool.sol:1746-1750`), so real accruals are never dust — but it is a permissionless
   call with a directional rounding bias.
5. **Router residuals are permanently stranded.** `_refundResidual` (`EXNIHILORouter.sol:67-72`)
   measures a delta against `balBefore`, so USDC donated to the router is never refunded to
   anyone and cannot be swept. Not stealable; not recoverable either. Pre-existing.
6. **`tokenURI` gas is unbounded by an untrusted token.** `PositionNFT._readLive` (`:427-447`)
   calls into the pool and the underlying token inside `try`/`catch`; a hostile token can make
   `tokenURI` expensive enough to break marketplace rendering. View-only, no state impact.
7. **The guard's holder exemption is address-based, not intent-based.** `:1453` compares
   `msg.sender == holder`. An ERC-4337 wallet is fine (the wallet is `msg.sender`), but a
   Gelato-style relayer calling the pool directly on a holder's behalf is treated as a third
   party and blocked. Worth knowing before any keeper-service integration.
8. **The holder exemption also means the holder can settle at a price they moved themselves** —
   though `closeLong`/`closeShort` already allow that unguarded at any time, so the exemption
   adds no new surface. Flagging it for the manipulation pass rather than claiming it here.
