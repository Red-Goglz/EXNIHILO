# Nemesis R4 — working notes

Tree: `mainnet-launch` HEAD `2ce997a` + uncommitted changes to `EXNIHILOPool.sol` and
`EXNIHILOFactory.sol` that are comment-only (every `+`/`-` code line of `git diff` is a
comment). Contract delta since R3 (`609723f`): `344abcb` (open resets clock, later replaced),
`066d595` (deployer role removed, `quoteCloseUnclamped`), `2789cf3` (external review: 12 contract
changes). `4ad4a9f` is site-only. Peripheral contracts: only `LockedLpVault._harvest` saturation
changed. Baseline suite: 673 passing.

## Phase 0 — recon

Attack goals: (1) drain LP USDC/token through settlement pricing; (2) LP extracts holder value
via funding/clamp/sweep; (3) brick removeLiquidity or the pool; (4) premarket buyout theft.

Novel code: `_settleCarriedFunding`, `_liveAt` zeroing, `MIN_FUNDING_INDEX`, `_flushResidue`
rebase, `_buybackCost` bisection, `sweepDustBatch`, claim-path invariant asserts, decimals bound.

Value stores: pool (backed reserves, short collateral, fees, claimable), LockedLpVault (fees),
PreMarket (reserves until buyout).

## Pass 1 — Feynman (full)

`_priceCloseClamped:930` — Q1.1 WHY skip `e.timestamp <= pos.openedAt`? Stated: "one at or before
openedAt predates the position". Consequence: for a position opened in THIS block, every ring
entry is skipped, the clamp is the live price. R3 NM-R3-006 flagged this and closed it on the
grid in `ManipulationSafety.ts`. The grid is (a) multi-transaction, so the clamp catches it, and
(b) marks leftover tokens at P0 instead of unwinding. Neither tests the atomic from-scratch shape.
→ SUSPECT, fed to the model.

Model (`scratchpad/sim.py`, integer replica of open/close/swap) — atomic
openShort → dump → closeShort → rebuy: +1.79 % of pool USDC (N = 20 %, dump 0.95x token reserve).
Long mirror: negative with single swaps. On-chain PoC matches to the cent: +$1,793.71 on 100k/100k.

Q4 (assumptions) on `_cpAmountOut`: the fee is on the input's PRE-swap spot value. That makes one
large swap expensive but nothing stops splitting it. Random search found 2 shorts + a dump split
in two → $7,350. Chunked grid: short 3 × 20 %, dump 5.8x in 20 swaps → +$17,467.45 (on-chain);
long, pump 2.2x in 20 swaps → +$2,788.47 (on-chain).

Q1.1 on `_buybackCost` (2789cf3): exact inverse vs the prorated cost. With the prorated cost the
single-short atomic shape is −$142 (model) — the overcharge was the only margin. But the overcharge
shrinks with position size, so splitting defeats it: R3 tree k = 32 → +$1,128. So 2789cf3 did not
introduce the flaw; it removed the margin for the single-position form.

Deployed contracts (`5197494`, live since 2026-07-28): no clamp, prorated cost, creator caps.
On-chain PoC in a worktree: k = 32 → +$1,129.74; chunked → +$14,516.65 per 100k. Mainnet read
(public RPC, 2026-09-24): 3 markets (RGOGLZ, ARENA, PHAR), all backedAirUsd = 0. No funds at risk
now; any new market on the live factory would be.

Fresh pool (1 % cap): 60 shorts + chunked dump → $14,752 (model). Cap ramp is per position, so
splitting bypasses it; bounded by block gas.

Other Pass 1 verdicts:
- `_buybackCost` comment "sound because _cpAmountOut is monotonic": false — output falls for
  x > 9·Ri. Bisection is still correct because the caller guarantees P(hi) and the feasible set is
  an interval. `if (lo > hi) lo = 0` is dead. INFO.
- `_priceCloseAt` short: `totalBuyable = _cpAmountOut(locked, …)` can be < debt in the falling
  region while a smaller input covers it → a deep-profit short reads unpriceable. Needs
  backedAirUsd drained below ~locked/9. INFO.
- Factory decimals bound: unit value is set by the seed ratio, not decimals. INFO.
- `MIN_FUNDING_INDEX`: 17 y at base rate; ~1.4 y at the 4x utilization cap; opens refused until
  the whole book empties. Sustained cap utilization is uneconomic (impact fee). INFO.
- Claim paths assert the whole invariant incl. the token leg → a token-side deficit (rebase,
  admin burn) freezes USDC claims (fees, protocol fees, sweep payouts). LOW.
- `_settleCarriedFunding`: at settle time the modifier's accrual just proved release == 0, so
  aggregate × (1 − f) < 1 unit; existing holders pay < 1 collateral unit total. Aggregates stay
  ≥ Σ positions. Sound.
- Router fee: execution fee ≤ quote (accrual only raises backedAirUsd). Sound.

## Pass 2 — State (full, enriched)

Identities (exact): `airTokenSupply = backedAirToken + TLC + TSD`,
`airUsdSupply = backedAirUsd + TSC + LOI`; balances cover liabilities; USDC flows conserved term
for term (checked every mutator). Aggregates ≥ Σ positions on all five, including after
`_settleCarriedFunding` (index moves, aggregates don't) and `_liveAt` zeroing (settle subtracts 0).
`_flushResidue` moves every residue with its counterpart. No gap in mutators.

Enrichment from Pass 1: the SUSPECT is not a coupling gap but a pricing-reference gap:
settlement reads SWAP-2/SWAP-3, which share `backedAirToken` / `backedAirUsd` with SWAP-1, and the
only reference that is not the live state (the ring) is filtered by `openedAt`. New pair mapped:
`priceRing[i].timestamp ↔ Position.openedAt` — the filter decides whether any unmanipulated
reference exists.

Parallel paths: short close burns the synthetic debt from `airTokenSupply` and credits `cost` to
`backedAirUsd`, never withdrawing tokens from `backedAirToken`; so the tokens dumped to cheapen
the buyback are still in the pool afterwards, at a price the close moved by only `cost`.

## Pass 3 — Feynman (targeted: the ring filter, the virtual buyback)

WHY does the round trip cost the attacker so little? dump Δ, close, rebuy Δ: loss ≈ swap fees +
cost·Δ/X, gain ≈ L − cost(dumped). As Δ grows cost → 0 and the gain → L (the collateral the open
took from backedAirUsd). Fees on chunked swaps ≈ 1 % of actual output, not of spot value.

Fix candidate: `e.timestamp < pos.openedAt` (include the open block's snapshot). Tested in a
worktree: every atomic PoC reverts `PositionUnderwater`. Residual: the same attack with the
manipulation held across CLAMP_BLOCKS blocks — no-arbitrage bound equals the atomic figures.

## Pass 4 — State (targeted)

Does the root cause touch other paths? `sweepDust` uses the same clamp; a sweep of a position
opened this block is impossible (not dust). `quoteClose` same filter (display). Long side: same
filter, same fix. No further coupled pairs. Converged.
