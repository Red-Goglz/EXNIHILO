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
cost    = min x such that cpAmountOut(x, airUsdSupply − locked, backedAirToken) ≥ debt
surplus = locked − cost
payout  = surplus − 1% close fee
```

`cost` is the airUsd that buys back the airToken debt: the exact inverse of the curve, found by
bisection. If the whole collateral cannot cover the debt, the position is underwater.

## Notes

- A negative surplus means underwater: the position cannot be closed.
- The payout depends on reserves when you close, clamped as described in
  [Closing Positions](/trading/closing-realizing).
- Large positions relative to the pool lose more to slippage, and long and short P&L are not
  perfectly symmetric.
- `quoteClose(nftId)` quotes what a close sent now would pay. The NFT's artwork shows that payout
  less the premium paid.
