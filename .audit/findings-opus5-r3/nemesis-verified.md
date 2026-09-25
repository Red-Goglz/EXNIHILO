# N E M E S I S — Verified Findings, Opus 5 R3

**Date:** 2026-09-15
**Tree:** `mainnet-launch` HEAD `609723f` plus uncommitted changes that are comment-only
(verified: every non-comment line of `git diff -- contracts` is a comment or whitespace).
**Primary target:** the continuous-funding redesign, never audited — funding index and
closed-form decay, `_weightedElapsed`, clock carry, price-ring clamp, `sweepDust`,
`_flushResidue`, wind-down doubling. Delta vs `1964520`: `EXNIHILOPool` 1,914 lines,
`PositionNFT` 178, `EXNIHILORouter` 2, `LockedLpVault` 5.
**Also covered:** the post-R2 fixes committed in `1964520` (`PreMarket` C-2 floor, M-1),
`PreMarketFactory`, `EXNIHILOFactory`, `PoolDeployer`, `LpNFT`, `LockedLpVault`, `Faucet`.
**Deployment status:** none of this is deployed; mainnet still runs the expiry-model
contracts. Every finding is pre-launch.

```
0 CRITICAL | 1 HIGH | 0 MEDIUM | 4 LOW | 3 INFO
```

Test suite at audit start: **630 passing, 0 failing.** PoCs: `poc/AuditR3Poc.ts`
(copy into `packages/blockchain/test/` to run; 7 passing).

## Method

Nemesis loop, converged in 4 passes: Feynman (full) → State (full) → Feynman on the
state gaps → State on the root cause. Working notes: `nemesis-raw.md`.

Structural result from Pass 2, worth keeping: across every mutator,

```
airTokenSupply == backedAirToken + totalLongCollateral + totalShortDebt
airUsdSupply   == backedAirUsd  + totalShortCollateral + longOpenInterest
```

hold **exactly**, and the token/USDC balance checks are preserved term for term. Solvency
is structural; the bugs this round are about who gets which value, not about insolvency.

---

## NM-R3-001 — HIGH — A rounding residue freezes a side's funding clock; the next opener is billed for the whole frozen period

**Status: FIXED 2026-09-15 (uncommitted).** `openLong` / `openShort` now set
`lastFundingLong` / `lastFundingShort = block.timestamp` after the accrual and before the
position joins the aggregate. Regression tests in `Funding.ts`, "does not bill a newcomer
for time carried on a residue" (short residue, long residue, deliberate 1-unit dust).
Mutation-checked: with the two lines removed all three fail (7,037 / 7,085 / 7,035 bps
against a floor of 9,999); with them, all pass. Full suite 633 passing, 0 failing. The
F-1 cases in `poc/AuditR3Poc.ts` assert the pre-fix behaviour and now fail by design.

**Discovery path:** cross-feed P1→P2. Pass 1 exposed the assumption "aggregate collateral
== 0 iff the side is empty"; Pass 2 found no per-side emptiness state.

**Code.**
- `EXNIHILOPool.sol:1057` — `_projectFunding` returns factor `RAY` (no charge, index
  unchanged) when `_released(aggregateCollateral, f) == 0`.
- `EXNIHILOPool.sol:1002-1004`, `:1018-1020` — the clock then advances **only** if the
  aggregate is exactly `0`. Otherwise time is "carried".
- `EXNIHILOPool.sol:1084-1088` — `_released` rounds the kept amount **up**. With an
  aggregate of `1`, `_released(1, f) = 1 − ceil(f) = 0` for every `f > 0`: **the clock
  never advances again.**
- `EXNIHILOPool.sol:1282-1283` — `_flushResidue` clears residue only when the **global**
  `openPositionCount == 0`, i.e. both sides empty.
- `EXNIHILOPool.sol:365-413`, `:432-484` — `openLong` / `openShort` add to the aggregate
  without touching the side's clock.

**Why residue is the normal case, not an edge.** Aggregates round up and positions round
down by design (`:1081-1083`, `:1254`), so when a side's last position settles, 1–2 units
normally remain. PoC: one short opened, closed after one accrual → `totalShortCollateral
= 1`. If any position on the other side is still open, nothing clears it.

**Trigger — organic, no attacker.**
1. A long is open (any size). A short opens and later closes in profit.
2. Residue `totalShortCollateral = 1`; the short clock is now frozen. Every swap, open
   and poke for the next N days accrues nothing on the short side.
3. A trader opens a short. The accrual inside that open sees aggregate `1`, charges
   nothing, and leaves the clock where it froze.
4. The next accrual — the next block, anyone's transaction, even the victim's own close —
   charges the **entire frozen interval** to an aggregate that now includes the victim,
   at a utilization computed from the victim's own open interest.

**Trigger — attacker.** `openShort(3)` yields `airUsdOut == 1`, so `totalShortCollateral
== 1` for a 0.05 USDC fee. The market creator is the LP and receives every unit funding
releases, so the LP of a permissionless market can install this on its own pool. The same
dust position is unsweepable (its index never moves) and, when alone on the pool,
delays the LP's own exit after `closePool` from 18 to 22 days.

**Measured** (market 1 day old at freeze, 30-day gap, victim 10,000 USDC notional):

| Scenario | victim `remainingSizeBps` one block after open | Collateral released to LP | Time billed |
|---|---|---|---|
| Control: short book empty (aggregate 0) | 9,999 | 0.000422 USDC | 1 s |
| Organic residue, short side | **6,590** | **2,981.66 USDC** | **30.0002 days** |
| Organic residue, long side (18-dec token, 2 wei) | **6,843** | — | 30 days |
| Attacker 3-unit dust short | **6,694** | **2,971.94 USDC** | **30.0000 days** |

A third of the position is gone one block after it was opened. The victim cannot escape
by closing: a fresh position is underwater on its own entry fee, and even an immediate
close accrues first. The frozen side still reports a positive `fundingRatePerSecond`,
and nothing a trader can quote before opening reveals the carry.

**Consequence.** The option the victim paid for shrinks by the factor for a period that
predates it; the LP's liability shrinks with it, realised when the victim closes in
profit. Longer gaps and younger markets are worse (the rate integrates `1/window`).

**Comment asserting the opposite** (PROCESS-002 pattern): `EXNIHILOPool.sol:986-987`,
"or when there is nothing to charge (so idle time is not billed to the next opener)".
The existing test `Funding.ts:202` ("does not bill a position for idle time that
predates it") only exercises an aggregate of exactly zero, so it certifies the comment
while missing the residue case.

**Fix (minimal).** In both open paths, after the modifier's accrual and before adding the
position, reset that side's clock:

```solidity
// openLong
lastFundingLong = block.timestamp;
// openShort
lastFundingShort = block.timestamp;
```

If the accrual landed, this is a no-op. If it rounded to zero, what is forgiven is by
definition `< 1` unit of the pre-existing aggregate, so the LP loses under one unit and no
newcomer is billed for time before it existed. Repeatedly opening to keep forgiving dust
costs 0.05 USDC per open to evade `< 1` unit per interval — uneconomic. Optionally also
track per-side position counts and flush a side's residue when its own count hits zero.
Regression: the organic scenario in `poc/AuditR3Poc.ts`, asserting `remainingSizeBps ≥
9,999`; mutation-check that it fails without the reset.

---

## NM-R3-002 — LOW — Short funding is path-dependent; the "one step or fifty" claim is false for shorts

**Status: DOCUMENTED 2026-09-16, by owner decision; code unchanged.** `funding.md` (The rate,
Reading a position) and `security.md` now say the claim holds for longs only and that the
error on shorts is always an overcharge. The `_decayFactor` comment is corrected. No
short-side twin of `Funding.ts:821` was added.

`EXNIHILOPool.sol:1068-1079`. The closed form holds `backedAirUsd` constant over the
interval, but short funding releases collateral **into** `backedAirUsd` (`:1012`), which
lowers the short side's utilization mid-interval. Frequent accruals see that; one long
accrual does not.

Measured, twin markets, crowded short side, 20 days: one accrual **5,767 bps**, forty
accruals **5,886 bps** — a 119 bps (2 %) gap. `Funding.ts:821` tolerates 0.1 % but only
tests longs, whose funding moves `backedAirToken`, not the denominator.

Direction is overcharge on quiet pools; anyone can poke, so nobody profits by keeping a
pool quiet. `docs/positions/funding.md` ("a stretch of time costs the same whether it is
accrued in one step or fifty") is wrong for shorts. **Fix:** correct the docs and the
comment, or fold the side's own release into the denominator in the closed form; add the
short twin of `Funding.ts:821`.

## NM-R3-003 — LOW — `sweepDust` can take the holder's residual claim

**Status: DOCUMENTED 2026-09-16, by owner decision; code unchanged.** `sweepDust` stays —
geometric decay never reaches zero and `removeLiquidity` needs every position gone, so
without it one abandoned position would lock LP principal permanently. "Never taken" is
removed from `funding.md`, `faq/questions.md`, `trading/closing-realizing.md`,
`introduction/glossary.md`, `developers/reference.md`, `protocol/security.md` and the SDK's
`keeper.ts`; each now says the residual can be denied by a caller who moves the price and is
bounded by the remaining collateral.

`EXNIHILOPool.sol:588-603` → `_settle` underwater branch `:933-946`. The doc
(`funding.md`, "Any residual claim is credited to the holder, never taken") is false:
`sweepDust` is permissionless and prices through the clamp, so a caller who swaps the
position underwater in the same transaction (the LP pays its own swap fee to itself), or
who leaves an underwater block open inside `CLAMP_BLOCKS` (`:885`), sends the collateral
to the LP and credits the holder nothing. Bounded to a position at ≤ 0.1 % of its opening
collateral. **Fix:** correct the docs; or credit the holder the clamped surplus of the
position's live valuation only, and never classify a sweep as underwater on a snapshot.

## NM-R3-004 — LOW — The close clamp is a denial lever on the holder's own close

**Status: DOCUMENTED and surfaced in the app 2026-09-16, by owner decision; clamp unchanged.**
Now measured, not only traced: a long +$2,821.89 at live reserves, pushed by 10,000 tokens (10 %
of the reserve) at one block boundary and pulled back at the next, quotes live +$2,775.47 but
clamped −$921.98, and `closeLong` reverts `PositionUnderwater` until `CLAMP_BLOCKS` pass
(`ManipulationSafety.ts`, "holds a close back after a dip held across a block boundary"). New pool
view `quoteCloseUnclamped(nftId)` prices at live reserves; the site shows **Retry shortly** and
the live PnL when it is in profit and `quoteClose` is not, and re-reads every 3 s until it clears.
The SDK gains `quoteCloseUnclamped` and `PositionState.closeHeldBack`. Docs: closing-realizing,
security, faq/risks, faq/questions, reference, sdk.

`EXNIHILOPool.sol:884-885`: "Underwater at any open in the window wins outright." A
snapshot is written by the first mutation of a block, so a price push that survives one
block boundary is recorded, and the push can be unwound in that same block. Repeating the
push every ≤ 5 blocks keeps a near-break-even holder's `closeLong`/`closeShort` reverting
`PositionUnderwater` while funding runs to the LP. Costs the LP nothing in fees; costs
one block of arbitrage exposure per repetition. Successor to R2 M-4 in a weaker form.
**Fix:** document; or clamp the payout to the worst *surplus* without letting a snapshot
alone flip the verdict to underwater.

## NM-R3-005 — LOW — `closePool` became confiscatory, and the emergency role holds it on every pool

**Status: FIXED 2026-09-16, by owner decision — role removed.** `EXNIHILOFactory` loses
`deployer`, `setDeployer` and `OnlyDeployer`; `EXNIHILOPool.closePool` is `onlyLpHolder` and
`OnlyLpHolderOrDeployer` is gone. The pool keeps `factory` as a plain address with no authority.
A launchpad market (LP NFT in `LockedLpVault`) can now never be wound down. Test in `Funding.ts`:
the factory's deploying account reverts `OnlyLpHolder`, and the factory ABI has no `deployer` /
`setDeployer`. `deployMainnet.ts` no longer reads the role. Site landing page and docs (security,
ownership, risks, questions, glossary, architecture, reference, index, addresses) updated;
`addresses.md` notes the still-live 2026-07-28 deployment keeps the role until the redeploy.

`EXNIHILOPool.sol:287-303`, `:1152-1175`, `:1210-1214`. Before the redesign, closing a pool
blocked opens and renewals; holders kept their positions to deadline. Now it starts a
7-day grace and then doubles funding daily, decaying every open position to sweepable
dust in ~18 days (measured), all to the LP. `EXNIHILOFactory.deployer` can call it on
**any** pool, including third-party and `LockedLpVault` markets. That is a privilege
escalation of an existing trust assumption, not a bug. **Fix:** renounce the role before
launch (`setDeployer(address(0))`), or limit the deployer to blocking opens without
starting the doubling.

## INFO

- **NM-R3-006** — `EXNIHILOPool.sol:869` skips snapshots with `timestamp <= openedAt`. A
  later block in the same second is skipped too, so the clamp is blind for positions
  opened that second. Only reaches the from-scratch open→pump→close shape, which the
  grid in `ManipulationSafety.ts` shows unprofitable.
- **NM-R3-007** — On `LockedLpVault` markets funding lands in backed reserves nobody can
  ever withdraw; "100 % to the LP" (`funding.md`) is not true for launchpad markets. It
  deepens the market permanently instead.
- **NM-R3-008** — R2 M-2 upper half still present: `PreMarket.sol:229`, `:237`, `:251`
  overflow for `startPrice` ≳ 1e71 with a 1-wei quote seed that passes the 100 USDC
  seeded-value floor. Bricks `buyout`; seeder self-harm only.

---

## Carried findings — re-derived from the code, not from R2's status

| R2 | Status now | Evidence |
|---|---|---|
| C-1 guard does not aggregate | **Gone** with the guard | no `_armSettlementGuard` in tree |
| C-2 buyout for $1 at floor | **Fixed** | price floored, not total: `PreMarket.sol:229-240`, `:250-252` strictly increasing in reserve |
| H-1 opens don't arm guard | **Gone**; clamp is snapshot-based, so opens are covered | `:726-743` |
| H-2 holder sandwiches own close | **Partly open.** Holds of 0–4 blocks clamped; a full 5-block hold still pays **+$478 / +$851 / +$788** vs a plain exit (pumps $20k/$50k/$100k, no arbitrage in harness — upper bound) | `ManipulationSafety.ts:478` |
| H-3 renewal stacking | **Gone** with renewals | — |
| H-4 buyout depends on token `transferFrom` | Documented owner decision | `docs/markets/creating.md` |
| M-1 `token == usdc` | **Fixed** | `PreMarket.sol:176-177`, `PreMarketFactory.sol:83-84` |
| M-2 `startPrice` bounds | Lower bound via 100 USDC seeded value; upper overflow remains (NM-R3-008) | — |
| M-3 no refund path | Open, by design | `PreMarket.sol` |
| M-4 guard as denial lever | Guard gone; weaker successor NM-R3-004 | — |
| SI-001 `totalLongCollateral` | **Fixed** | `:172`, invariant `:1399-1401` |
| PU-001 `PoolDeployer` unguarded | **Fixed** | `PoolDeployer.sol:26` |
| Factory never compares predicted id | **Fixed** | `EXNIHILOFactory.sol:136` |
| IA-R2-7 vault claim frozen by pool revert | **Fixed** (non-strict harvest) | `LockedLpVault.sol:116-127`, `:150` |

## Checked and clean

- **Utilization manipulation by holders (memory concern).** False positive. Every
  mutation of open interest or `backedAirUsd` runs `_accrueFunding` first
  (`reserveMutation`, `:276-281`), so the rate state is constant over each accrued
  interval. Moving depth for an interval means holding a real price move across blocks,
  exposed to arbitrage. The one exception is the carried clock, which is NM-R3-001.
- **Closed form.** `_decayFactor` matches the logistic solution
  `N/N0 = a·q / (a + b·u0·(1 − q))`; window and wind-down enter as a time change that
  scales `a` and `b` together, so `_weightedElapsed` is the right clock. No overflow:
  `_rpow` keeps `x ≤ RAY`; `_simpson` numerator ≤ ~1e29; all RAY products < 1e67.
- **Integration loop** always progresses (`_nextIntegrationBoundary` returns `> t`); a
  5-year gap stays under 400k gas (`Funding.ts:232`).
- **Aggregate ≥ Σ positions** on all five aggregates, so no settle underflows; index
  reaching 0 is only possible in wind-down, where opens are blocked.
- **Short close after a clamped valuation** credits `locked − surplus` (`:960`), and
  clamped surplus ≤ live surplus ≤ `locked`, so no underflow.
- **Reentrancy:** every pool mutator is `nonReentrant`; the `_safeMint` callback runs
  under the lock; `release` burns without hooks.
- **Router** fee quote equals execution (`quoteOpenFee` projects the same accrual).
- **No loops over user data, no `delegatecall`, no proxies, no signatures, no oracles**
  (bounded loops only: ring of 5, integration ≤ 32 steps).

## Recommendations, in order

1. **Fix NM-R3-001 before the redeploy** — two lines plus a regression test that fails
   without them. Rewrite `Funding.ts:202` to cover a residue, not only an empty book.
2. Decide the emergency role (NM-R3-005) before launch; renouncing is one call.
3. Correct `funding.md` on path independence (NM-R3-002) and sweep residuals
   (NM-R3-003), and the comment at `:986-987`.
4. Add a short-side twin of `Funding.ts:821`.

## Scope limits

One Nemesis pass, not the eleven-pass battery of R2. Deep: all of `EXNIHILOPool`,
the funding/clamp/sweep machinery, the post-R2 `PreMarket` fixes. Surface: `PositionNFT`
SVG rendering, `Faucet`, deploy scripts and the indexer (out of scope). No fuzzing or
formal verification. A clean section is evidence of absence only to the depth stated.
