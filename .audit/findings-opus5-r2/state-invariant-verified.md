# State Invariant Detection — Verified (Opus 5, R2)

**Date:** 2026-08-20
**Baseline:** `.audit/findings-opus5-r2/SCOPE.md` — branch `mainnet-launch`, HEAD `c02af1d`
plus uncommitted working-tree contract changes.
**Method:** re-derive every mathematical relationship between state variables from
the current source (assuming nothing from round 1), then hunt for the mutation
path that violates one. Every derived relationship was then checked *empirically*
against a live pool with exact-equality assertions, not by reading alone.

```
0 CRITICAL | 0 HIGH | 0 MEDIUM | 2 LOW | 4 INFO
```

## Scope actually covered

`EXNIHILOPool.sol` (re-derived from scratch), `PositionNFT.sol`,
`EXNIHILOFactory.sol`, `PoolDeployer.sol`, `LpNFT.sol`, and the three unaudited
contracts `PreMarket.sol`, `PreMarketFactory.sol`, `LockedLpVault.sol`.

## Inferred invariants and where they are enforced

| # | Invariant | Enforced | Verified |
|---|---|---|---|
| I1 | `backedAirToken ≤ airTokenSupply` | explicit, Pool:1904 | exact |
| I2 | `backedAirUsd ≤ airUsdSupply` | explicit, Pool:1905 | exact |
| I3 | `token.balanceOf(pool) ≥ backedAirToken` | explicit, Pool:1906 | **loose — see SI-001** |
| I4 | `usdc.balanceOf(pool) ≥ backedAirUsd + totalShortCollateral + lpFeesAccumulated + protocolFeesAccumulated + totalClaimable` | explicit, Pool:1914–1921 | **exact, slack 0** |
| I5 | `totalClaimable == Σ claimable[addr]` | structural | exact |
| I6 | `totalShortCollateral == Σ lockedAmount` over open shorts | structural | exact |
| I7 | `openPositionCount == live position NFTs for this pool` | structural | exact |
| I8 | `longOpenInterest == Σ airUsdMinted` over open longs | structural | exact |
| I9 | `shortOpenInterest == Σ usdcIn` over open shorts | structural | exact |
| **I10** | `airUsdSupply == backedAirUsd + totalShortCollateral + longOpenInterest` | **not asserted anywhere** | exact |
| **I11** | `airTokenSupply == backedAirToken + Σ longs.lockedAmount + Σ shorts.airTokenMinted` | **not asserted anywhere** | exact |
| I12 | `lpFeesAccumulated + lpFeesPaidTotal` and `protocolFeesAccumulated + protocolFeesPaidTotal` account for 100 % of every atom taken | structural | exact |
| I13 | `lpAccrued + integratorAccrued + lpClaimedTotal + integratorClaimedTotal == harvestedTotal` (LockedLpVault) | structural | exact |
| I14 | `token.balanceOf(pm) == tokenReserve` and `quote.balanceOf(pm) == quoteReserve` (PreMarket) | structural | exact |
| I15 | `LpNFT._nextTokenId == EXNIHILOFactory.allPools.length` | **not asserted** — see SI-003 | holds |

I1–I4 are asserted at exactly seven call sites, unchanged from round 1:
Pool:680 (`openLong`), 811 (`openShort`), 884 (`addLiquidity`), 1148
(`_tryAutoRenew`), 1495 / 1528 (both swap internals), 1674 (`_settle`).

I10 and I11 are new this round: they fall out of the delta algebra and hold with
zero slack, but nothing in the contract states them. I10 in particular is the
exact form of I2 — I2 is I10 with two non-negative terms dropped.

---

## SI-001 — LOW — the token-side reserve invariant is still the loose lower bound that was fixed on the USDC side

**Location:** `packages/blockchain/contracts/EXNIHILOPool.sol:1906`

```solidity
if (underlyingToken.balanceOf(address(this)) < backedAirToken) {
    revert ReserveInvariantViolated();
}
```

**What is wrong.** This is the same defect round 1 found in the USDC leg, on the
other asset, and the fix was applied to one side only.

`openLong` (Pool:660) does `backedAirToken -= airTokenOut` while the underlying
token itself never moves — it stays in the pool as the position's collateral and
is recorded as `pos.lockedAmount` on the NFT. Both `_settle` branches return it
with `backedAirToken += pos.lockedAmount` (Pool:1633 underwater, Pool:1650
profitable). So between open and settle there is a block of real underlying token
in the contract that no counter on the right-hand side of I3 represents. The
check therefore passes whether or not that token is still present — exactly the
sentence the contract itself now writes about short collateral at Pool:1909–1913.

**Measured size of the blind spot.** Over a randomised 360-operation lifecycle
across three seeds, I recorded both forms after every operation:

```
usdc.balanceOf - (backedAirUsd + totalShortCollateral + fees + totalClaimable)
    max slack = 0                       ← I4, exact, round 1's fix holds

token.balanceOf - backedAirToken
    max slack = 17163276701931303616556 (≈ 17,163 of 100,000 seeded tokens, 17 %)

token.balanceOf - backedAirToken - Σ longs.lockedAmount
    max slack = 0                       ← the missing term is exactly long collateral
```

The third line is the point: the residual is zero, so `Σ longs.lockedAmount` is
precisely and only what I3 fails to account for. Up to ~17 % of the pool's token
reserve could vanish without the assertion noticing.

**Why I believe it, and why it is LOW not HIGH.** There is no exploit path in the
current code. Only two paths move underlying token out — `_swapUsdcToToken`
(Pool:1526), which pairs the transfer with `backedAirToken -= netOut` and where
`netOut < backedAirToken` strictly by the constant-product form; and
`removeLiquidity` (Pool:910), which is gated on `openPositionCount == 0` and so
runs only when `Σ longs.lockedAmount == 0`. So nothing leaks today. The finding
is that the pool's principal solvency assertion cannot *detect* such a leak, and
that is the identical reasoning round 1 used to justify adding
`totalShortCollateral`.

**Failure mode if it ever did happen.** With the tight form, an operation that
removed token beyond `backedAirToken + Σ longs.lockedAmount` reverts at the
offending call. With the loose form it succeeds, and the revert instead lands on
the *trader's* `_settle`, where `backedAirToken += pos.lockedAmount` pushes the
accounted amount above the balance. A safe immediate failure becomes a position
that can never be closed. Wrong party, wrong time.

**Fix (three sites, exactly mirroring `totalShortCollateral`).** Add
`uint256 public totalLongCollateral;` at the end of storage, then:

| Mutation | Site | Accumulator |
|---|---|---|
| `openLong` locks `airTokenOut` | Pool:660 | `+= airTokenOut` |
| `_settle` underwater long returns it | Pool:1633 | `-= pos.lockedAmount` |
| `_settle` profitable long returns it | Pool:1650 | `-= pos.lockedAmount` |

Three sites, not four: a long's `lockedAmount` is immutable after mint. Both
renewal paths pass `pos.lockedAmount` through unchanged — `renewPosition`
(Pool:1014) and the long branch of `_tryAutoRenew` (Pool:1134) — and only the
short branch (Pool:1142) rewrites it. Then extend Pool:1906 to
`< backedAirToken + totalLongCollateral`.

The change makes I3 exact and I11 checkable; my probe confirms both hold with
zero slack today, so the strengthened assertion cannot regress the current suite.

---

## SI-002 — LOW — PreMarket's seed-time validation is incomplete, and two accepted configurations strand the seed permanently

**Location:** `packages/blockchain/contracts/PreMarket.sol:301–333` (constructor),
`PreMarket.sol:515–519` (the `createMarket` call), `PreMarketFactory.sol:120–121`

The contract states its own design rule at `PreMarket.sol:107–109`:

> Market parameters are validated at seed time, not at buyout. With no expiry
> path, a pool constructor revert during buyout would strand the premarket's
> liquidity permanently rather than merely delaying it.

Two accepted seeds break that rule. Neither `PreMarket`'s constructor nor
`PreMarketFactory.createPreMarket` checks them, and `buyout()` is the only way
assets ever leave a premarket.

**(a) `token == usdc`.** `EXNIHILOFactory.createMarket` rejects it at
`EXNIHILOFactory.sol:196` with `TokenIsUsdc`, a guard that is itself new this
round. `PreMarket` never checks it. Confirmed empirically: the premarket seeds
normally and holds the liquidity, then

```
buyout()  →  reverts EXNIHILOFactory.TokenIsUsdc   (permanently)
```

**(b) unbounded `startPrice`.** `PreMarket.sol:313` only rejects zero.
`currentPrice()` at `PreMarket.sol:356` computes
`startPrice * decayBpsPerMinute * elapsed` left-to-right, so
`startPrice > 2**256 / decayBpsPerMinute` overflows on the first multiplication
regardless of `elapsed`. Confirmed with `startPrice = 2**255`:
`currentPrice()`, `buyoutCost()` and `buyout()` all revert from the first second
onward, forever.

**Why this is a real finding rather than a footgun.** I enumerated the external
surface of a deployed `PreMarket` and there is no escape hatch of any kind:

```
buyout, buyoutCost, creator, currentPrice, decayBpsPerMinute, factory,
getAmountOut, integrator, launchUsdc, launched, launchedPool, lpOwner, lpVault,
quote, quoteReserve, quoteUnit, startPrice, startTime, swap, swapFeeBps, token,
tokenReserve, usdc
```

No withdraw, rescue, refund, cancel or expiry. Seeding is one-way by design, and
that design is only safe if seed-time validation is complete. It is not.

**Severity.** LOW: the damage is bounded to the seeder's own liquidity and
requires the seeder to pass a wrong address. It is worth fixing because
`createPreMarket` is permissionless and a launchpad that takes the token address
from user input hands the choice to a third party while supplying the quote leg
itself.

**Fix.** In `PreMarket`'s constructor, add `if (c.token == c.usdc) revert
TokenIsUsdc();` and `if (c.token == c.quote) revert ...` if the degenerate
same-asset case is unintended (it is currently accepted and, as it happens, stays
conserved — see the clean list). Bound `startPrice` to something a real quote can
reach, or reorder `currentPrice()` to divide before the last multiply.

---

## SI-003 — INFO — the factory predicts the LP NFT id and never checks the mint returned it

**Location:** `packages/blockchain/contracts/EXNIHILOFactory.sol:224` and `:234`

```solidity
pool = poolDeployer.deploy(..., allPools.length, ...);   // lpNftId_, predicted
...
lpNftId = lpNftContract.mint(address(this), pool);       // actual
```

The comment at `EXNIHILOFactory.sol:231–233` says "The returned id must equal our
prediction; if not, something is wrong with the factory's LP NFT accounting
invariant" — but no comparison is performed. `EXNIHILOPool.lpNftId` is an
**immutable** baked from the prediction, and `onlyLpHolder` resolves authority
through it, so a desync would permanently hand one pool's LP rights to a
different pool's NFT holder.

I could not break it. `LpNFT.factory` is immutable and `mint` checks
`msg.sender != factory` (`LpNFT.sol:69`), `createMarket` mints exactly once and pushes to `allPools` in
the same atomic call, `createMarket` is `nonReentrant`, and the malicious-token
callback windows at `EXNIHILOFactory.sol:202–203` cannot reach `mint` through any
other entry point. So I15 holds. But it is a cross-contract synchronization
invariant with a catastrophic failure mode and no runtime check, in a factory
whose whole LP-NFT-id scheme rests on it. One line —
`if (lpNftId != allPools.length - 1)` after the push, or capturing the predicted
value and comparing — makes it fail closed. Reported as hygiene because there is
no path to it today.

---

## SI-004 — INFO — the fee reweighting was not propagated into `LockedLpVault`'s documentation

**Location:** `packages/blockchain/contracts/LockedLpVault.sol:40` and `:65`

Both still describe the vault's income as "3 % of notional". `LP_FEE_BPS` moved
300 → 400 this round. `PreMarket.sol:135` was updated correctly ("The pool routes
4 % of notional to the LP side, so half of that is 2 % of notional to the
integrator and 2 % to the LP owner"), so `LockedLpVault` is the only place in the
tree where the reweighting was missed. A grep of the contracts for stale
percentages found no others.

This is documentation only — no constant in `LockedLpVault` derives from the
split (see the clean list) — but it is the header a launchpad reads before
committing liquidity, and it currently understates their revenue share by a
third.

---

## SI-005 — INFO — two ways `LockedLpVault.pending()` does not describe what a claim will do

**Location:** `packages/blockchain/contracts/LockedLpVault.sol:317–326`

The core check the coordinator asked for passes exactly: with a funded vault,
`claimLpFees` and `claimIntegratorFees` pay **precisely** the two numbers
`pending()` returned, to the atom, verified by `staticCall` against the view on
the same block. Two narrower divergences exist.

**(a) Unfunded vault.** `pending()` adds `pool.lpFeesAccumulated()`
unconditionally, but `_harvest` (LockedLpVault.sol:215–217) calls
`pool.claimFees`, which is `onlyLpHolder`. A vault deployed before the LP NFT
arrives — the normal sequence outside `PreMarket.buyout`, which funds atomically
— reports claimable value that no call can realise:

```
unfunded vault: pending() = 10093750 / 10093750
harvest() / claimLpFees() / claimIntegratorFees()  →  revert OnlyLpHolder
```

`isFunded()` exists as the intended guard; `pending()` does not consult it.

**(b) Per-harvest flooring.** `integratorCut` is floored on each harvest
(LockedLpVault.sol:225), while `pending()` floors once on the aggregate. Split
across N harvests the integrator's realised total can trail the projection by up
to N atoms. The degenerate case is real — 40 one-atom harvests at
`integratorBps = 5000` produced `lpAccrued = 40, integratorAccrued = 0` — but it
is not reachable as an attack: `pool.claimFees` transfers the entire accrual in
one go, and the smallest single LP accrual is `MIN_POSITION_FEE × 4/5 = 40,000`
atoms (Pool:1746–1750), so the per-harvest loss is at most half an atom. "Dust
favours the LP" (LockedLpVault.sol:226) is accurate and the direction is safe.

---

## SI-006 — INFO — the settlement guard can be re-armed indefinitely against third-party cleanup

Not a state-invariant issue — **handing this to the DoS / griefing pass to rate.**
I hit it while confirming the guard's atomicity and it is measured, so it is
recorded here rather than dropped.

`_assertSettlementUnguarded` (Pool:1452) exempts the position holder but not the
LP. After `closePool`, the LP needs every position settled before
`removeLiquidity` will run (Pool:897). A third party can hold the guard armed
forever by re-arming every five blocks:

```
6 round-trips of re-arming cost the griefer 120,642,488 USDC atoms
(~$120.64 on a $100k pool, ~$20 per 5-block window)
each round: settleExpired reverts, removeLiquidity reverts OpenPositionsExist
```

The economics are self-defeating — every cent of that cost is swap fee retained
in the reserves, i.e. paid to the LP being griefed — and no position holder is
ever trapped, since they are exempt. But the delay is unbounded for an adversary
willing to pay for it.

---

## Checked and found clean

**The fee-split reweighting opens no wedge, and cannot.** `totalFee` is never
computed independently of its parts. `_baseFees` (Pool:1738–1751) sets
`totalFee = protocolFee + lpFee` in the normal branch, and in the
`MIN_POSITION_FEE` floor branch derives `lpFee = MIN_POSITION_FEE - protocolFee`
as the residual — so the identity survives any bps values. `_openFees`
(Pool:1811–1822) and `_renewFees` (Pool:1781–1801) add the impact fee to `lpFee`
and `totalFee` together. Empirically, for eleven notionals straddling the floor
(1 atom … 5,000 USDC, at 1, 999,999, 1,000,000 and 1,000,001 atoms) on both
sides: USDC pulled == `quoteOpenFee` == the increase in
`lpFeesLifetime + protocolFeesLifetime`, every time. Same on twelve manual
`renewPosition` calls across both sides, at varying prices, including one on an
already-expired position. `renewPosition` (Pool:994) is the only fee-charging path
with no `_assertReserveInvariant()` call, so I checked it directly: slack stayed 0
and collateral, debt and both OI counters were untouched.

**The `KEEPER_BOUNTY` removal left no residual reservation.** No `bounty`
identifier survives anywhere in `contracts/`; `_settle` (Pool:1610) no longer
takes the parameter; `_autoRenewQuote` now gates on `totalFee + margin`
(Pool:1102) instead of `totalFee + KEEPER_BOUNTY`; `_tryAutoRenew` sets
`cost = totalFee` (Pool:1121) and the `safeTransfer(msg.sender, KEEPER_BOUNTY)`
is gone. Round 1's settlement algebra needs restating because of it — the
underwater-short branch is now `+lockedAmount − lockedAmount = 0` rather than
`−bountyPaid`. Confirmed on a live auto-renew: the pool's USDC balance did not
change by one atom, the caller was paid nothing, and
`Δ totalShortCollateral == Δ airUsdSupply == Δ (lpFees + protocolFees)` exactly.

**The settlement guard cannot interrupt a settlement.**
`_assertSettlementUnguarded` is a `view` that reverts, and both entry points call
it before any effect — `settleExpired` at Pool:1058 (before `_tryAutoRenew`) and
`closePositionAfterDeadline` at Pool:1176. There is no path that decrements
`openPositionCount`, credits a payout or releases collateral and then hits the
guard. Verified against a guarded position: both entry points reverted
`SettlementGuardActive` with `openPositionCount`, `claimable[holder]`,
`totalClaimable`, `backedAirUsd`, `backedAirToken`, `longOpenInterest` and both
token balances byte-identical afterwards, and the NFT still owned by the holder.

**`closeDate` still dominates every outstanding deadline.**
`currentPositionDuration()` (Pool:1310) is non-decreasing in market age, so for a
position opened at `t ≤ T` the deadline `t + d(t) ≤ T + d(T) = closeDate`. Both
renewal paths refuse to cross it (Pool:1008, Pool:1105), and the auto-renew gate
turns off for every `t > T`, so `closePositionAfterDeadline` can always clear the
book and `removeLiquidity` is never permanently blocked by the `AutoRenewActive`
guard.

**`PreMarket`'s launch handoff conserves exactly.** After eight swaps and a
buyout: the premarket ends holding zero token, zero quote and zero USDC; the
factory holds no residue; the pool holds exactly `tokenReserve` and exactly
`launchUsdc`, with `backedAirToken == airTokenSupply == tokenOut` and
`backedAirUsd == airUsdSupply == usdcIn`; the buyer received exactly the whole
quote reserve; the LP NFT is in the vault. Nothing stranded, nothing
double-counted. Also holds when the `MIN_BUYOUT_USDC` floor binds (paid $1, market
opened with the full 1,000,000-token reserve) and in the degenerate
`token == quote` case, where both reserves share one balance and still sum to it.
Token donated directly to a premarket before launch is stranded after it — that
is inherent to having no rescue path and is consistent with the stated design.

**`LockedLpVault` conservation holds, including a mid-stream role change.**
`lpAccrued + integratorAccrued + lpClaimedTotal + integratorClaimedTotal ==
harvestedTotal` was asserted after every harvest, every claim, and across a
`setLp` **and** `setIntegrator` executed with an unclaimed balance on both sides.
The accrual follows the role, which matches the docstring at
LockedLpVault.sol:283–289; the old holders correctly lose access, and the new
holders receive exactly the pre-transfer accrual. A direct USDC donation is split
50/50 and fully claimable rather than stranded, and the vault drains to a zero
balance. `integratorBps` is immutable and no constant in the vault derives from
`LP_FEE_BPS`, so the fee reweighting has no functional effect here (only the
stale comment, SI-004).

**Structural couplings re-derived and confirmed exact.** `totalShortCollateral`
still has exactly four mutation sites (Pool:791, 1140, 1638, 1659) mirroring the
four writes to a short's `lockedAmount`; the bounty removal neither added nor
removed one. `openPositionCount` still has two `++` (Pool:650, 780) and one `--`
(Pool:1623), so `removeLiquidity`'s guard remains trustworthy. `longOpenInterest`
tracks `airUsdMinted` through auto-renewal because Pool:1132 and Pool:1134
increment both by `cost`. `PositionNFT.applyRenewal` (PositionNFT.sol:340) writes
`airUsdMinted` unconditionally, which is safe only because the pool always passes
the field's current value on the side that does not own it — worth remembering if
a third renewal mode is ever added.

**Failure direction is still closed.** No `unchecked` block exists anywhere in
`EXNIHILOPool.sol`, `PreMarket.sol` or `LockedLpVault.sol`, so any desync that
would drive a counter negative reverts rather than wrapping.

## Empirical

All of the above was checked with throwaway probes under
`packages/blockchain/test/`, run and then deleted; no test files were left in the
repo and no contract was modified.

- **Randomised lifecycle**, deterministic PRNG, four seeds, ~500 operations total
  (open long/short, both swap directions, voluntary close, third-party expiry
  settlement, auto-renew opt-in and fire, ratio-matched `addLiquidity`, all three
  claim functions, `closePool`, full wind-down, `removeLiquidity`). Ten invariants
  re-checked after **every** operation, as exact equalities. **0 failures.**
  Branch coverage reached: 109 underwater settles, 11 profitable settles, 11
  credited payouts, 1 auto-renew fired, 22 claims, 15 liquidity adds, 13
  `closePositionAfterDeadline`. Every pool drained to `usdc = 0, token = 0`.
- **Fee conservation sweep** across the `MIN_POSITION_FEE` boundary, both sides,
  plus 12 manual renewals and the close fee. **0 wedges.**
- **Guard atomicity**, **auto-renew cash flow**, **PreMarket handoff**,
  **PreMarket strand cases**, **vault conservation and role transfer**,
  **unfunded-vault `pending()`**. All as described above.
- Full suite with the probes present: **634 passing, 0 failing.** No
  `ReserveInvariantViolated` anywhere.

## Carried findings from `.audit/findings-opus5/state-invariant-verified.md`

| Round 1 item | Status |
|---|---|
| I4 strengthened with `totalShortCollateral` | **Holds.** Still exact; measured slack 0 across every operation in every probe. |
| I6 non-desync, four mutation sites | **Holds.** Still four; the bounty removal did not disturb them. |
| I7 `openPositionCount` single decrement | **Holds.** |
| I8/I9 open-interest coupling | **Holds**, including through auto-renewal. |
| Settlement algebra per branch | **Restated.** The `bountyPaid` terms are gone from both short branches and from both auto-renew branches; the new algebra balances at zero cash out. |
| I3 `token.balanceOf ≥ backedAirToken` recorded as "explicit" | **Superseded by SI-001** — it is explicit but loose, and the round-1 reasoning that motivated the I4 fix applies to it unchanged. |
