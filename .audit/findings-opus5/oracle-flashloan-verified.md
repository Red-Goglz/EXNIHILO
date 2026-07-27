# Oracle & Flash Loan — Verified (Opus 5)

**Date:** 2026-07-27
**Scope:** `EXNIHILOPool` pricing paths

```
0 CRITICAL | 0 HIGH | 0 MEDIUM | 2 LOW (accepted, carried — both weakened)
```

## Oracle trust model: none

`grep -nE "latestRoundData|AggregatorV3|oracle|TWAP" *.sol` returns only a
comment at `EXNIHILOPool.sol:190` stating the pool is oracle-free.

There is no Chainlink feed, no TWAP, no external price source, and therefore no
stale-price risk, no circular price dependency, and no oracle-failure mode. All
prices are derived from the pool's own reserves:

```solidity
spotPrice  = backedAirUsd  * 10**dec / backedAirToken
longPrice  = airUsdSupply  * 10**dec / backedAirToken
shortPrice = backedAirUsd  * 10**dec / airTokenSupply
```

Each returns `0` on a zero denominator rather than reverting.

This collapses the entire oracle-manipulation class into **AMM self-manipulation**,
which is what the two carried findings cover.

## Why self-referential pricing is the right call here

The pool is the sole venue for its own synthetic asset. There is no external
market for `airToken`, so an external oracle would be meaningless — the pool's
reserves *are* the price. The manipulation surface is bounded by the same curve
the attacker must trade against, and every leg charges fees.

## OFL-1 / OFL-2 (carried, accepted) — flash-loan manipulation around open/close

Both remain accepted as uneconomical, and both are now **strictly harder** than
when they were accepted:

**1. The OI-integral impact fee (new since the last audit).** `_openFees` adds

```
impactFee = IMPACT_FEE_BPS * N * (2*OI + N) / (2 * backedAirUsd * BPS_DENOM)
```

on top of the 5% base, charged entirely to LPs. It scales with the square of
position size relative to depth, so the manipulation leg gets more expensive
exactly as the attack gets larger. `_renewFees` charges the same slice on renewal.

**2. Swap fees never undercharge.** `_cpAmountOut` computes
`fee = amountIn * reserveOut * f / (reserveIn * BPS_DENOM)`, dividing by
`reserveIn` rather than `reserveIn + amountIn`. The effective rate is therefore
`f * (1 + amountIn/reserveIn) >= f` — it rises with trade size. A pump-and-dump
pays *more* than the nominal fee on both legs.

**3. Position caps.** `maxPositionUsd` (hard USD cap) and `maxPositionBps` (% of
`backedAirUsd`) bound how much notional a single manipulation can carry.
`_checkLeverageCap` enforces the tighter of the two.

**4. Zero-output swaps now revert** (NM-OP5-001, fixed this round). Moves large
enough that the fee outgrows raw output are rejected outright rather than
silently donating the input to the pool.

## Empirical verification

`test/ManipulationSafety.ts` sweeps a grid of pump-and-dump attempts on both
sides and asserts zero profitable drains:

```
✅ long side:  no drain across the full grid (impact fee holds)
✅ short side: no drain across the full grid (impact fee holds)
```

`test/Parametric.ts` adds named extreme scenarios (small LP with 30× leverage
and a 100× pump, tiny LP with a 500× pump, etc.). All pass.

Both suites were updated this round to treat a reverting pump leg as
"manipulation could not be performed" — a strictly stronger outcome than
"performed but unprofitable". The `drains.length == 0` assertions are unchanged.

## Atomicity

There is no same-block restriction on open→manipulate→close, and none is needed:
the round trip pays the open fee (5% + impact), both swap fees (each above
nominal), and the 1% close fee on surplus. The tests above exercise exactly this
atomic sequence.

## Residual risk worth stating plainly

These findings are *economic*, not structural. They rest on fee parameters. If a
market is ever created with `swapFeeBps` at the `MIN_SWAP_FEE_BPS` floor (100 =
1%) **and** very shallow reserves **and** no position caps, the margin narrows.
The grid tests cover shallow-LP cases and still find no drain, but the safety
here is parametric — it should be re-tested if fee constants are ever lowered.
