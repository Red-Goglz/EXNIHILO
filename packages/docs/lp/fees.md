# LP Fee Earnings

LPs earn fees from two sources.

## 1. Position open fees — 3% of notional

Every time a trader opens a long or short, 3% of the USDC notional is added to `lpFeesAccumulated`. The LP can claim these at any time via `claimFees()`.

```
openFee = usdcAmount * 5 / 100
lpShare = openFee * 3 / 5    // 3% of notional
```

Fees accumulate in USDC and are claimed in a single transaction.

## 2. Swap fees — passive yield

The configurable swap fee (default 1%) stays in the pool on every swap. This implicitly increases the LP's backed reserves over time — it's not claimed separately, it's reflected in larger withdrawal amounts.

## Claiming fees

Call `claimFees()` on the pool. The accumulated USDC is transferred to the LP NFT holder and `lpFeesAccumulated` resets to zero.

Only the current LP NFT holder can claim.

## Revenue model

LP earnings scale with:
- **Number of positions opened** — more opens = more 3% fees
- **Swap volume** — more swaps = more passive yield
- **Pool TVL** — larger pools attract more traders
- **Position size** — bigger positions = bigger fees

::: tip
LPs can use position caps to manage risk while still earning fees on smaller positions.
:::
