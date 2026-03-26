# LP Fee Earnings

LPs earn fees from three sources.

## 1. Position open fees — 3% of notional

Every time a trader opens a long or short, 3% of the USDC notional is added to `lpFeesAccumulated`. The LP can claim these at any time via `claimFees()`.

```
baseFee = usdcAmount * 5 / 100
lpShare = baseFee * 3 / 5    // 3% of notional
```

## 2. Impact fee — dynamic, scales with position size and OI

An additional impact fee is charged on every position open and goes **entirely to the LP**. This fee protects against LP drain attacks by scaling quadratically with position size relative to pool liquidity.

```
impactFee = 1500 × N × (2 × OI + N) / (2 × backedAirUsd × 10000)
```

The impact fee is negligible for small positions in deep pools but becomes significant when positions are large relative to the pool — exactly when LP protection matters most.

## 3. Swap fees — passive yield

The configurable swap fee (default 1%) stays in the pool on every swap. This implicitly increases the LP's backed reserves over time — it's not claimed separately, it's reflected in larger withdrawal amounts.

## Claiming fees

Call `claimFees()` on the pool. The accumulated USDC (base LP fee + impact fee) is transferred to the LP NFT holder and `lpFeesAccumulated` resets to zero.

Only the current LP NFT holder can claim.

## Revenue model

LP earnings scale with:
- **Number of positions opened** — more opens = more base fees
- **Position size relative to pool** — larger positions pay more impact fee
- **Cumulative open interest** — more OI = higher impact fees on new positions
- **Swap volume** — more swaps = more passive yield
- **Pool TVL** — larger pools attract more traders

::: tip
The impact fee ensures that LPs are always compensated more than the price-distortion cost of any position — no profitable drain strategy exists.
:::
