---
description: "How position P&L is computed from pool state alone with no oracles, and why closing returns the surplus only rather than the full notional."
---

# P&L Calculation

P&L is computed from pool state alone — no oracles.

::: warning You receive the profit, not the position size
Opening transfers only the fee; the notional is synthetic. So closing returns the **surplus
only**: a $100 position that gains 50% pays out roughly $50, not $150.
:::

`locked` and `debt` below are a position's live figures from `liveAmountsOf(nftId)`. Funding
shrinks both by the same fraction, so the price you need to clear never moves — only the size
behind it does.

## Long

```
airUsdOut = cpAmountOut(locked, airTokenSupply − locked, backedAirUsd)
surplus   = airUsdOut − debt                 // debt == the live notional
payout    = surplus − 1% close fee
```

The position's own collateral is excluded from the reserve it sells into.

## Short

```
totalBuyable = cpAmountOut(locked, airUsdSupply − locked, backedAirToken)
cost         = ceil(locked × debt / totalBuyable)
surplus      = locked − cost
payout       = surplus − 1% close fee
```

`cost` is the airUsd needed to buy back the airToken debt, rounded up in the pool's favour.

## Notes

- `surplus ≤ 0` means underwater: the position cannot be closed.
- The payout depends on reserves when you close, clamped as described in
  [Closing Positions](/trading/closing-realizing).
- Large positions relative to the pool lose more to slippage, and long and short P&L are not
  perfectly symmetric.
- `quoteClose(nftId)` returns exactly what a close would pay, and the NFT's artwork shows the same
  number.
