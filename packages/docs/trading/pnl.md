---
description: "How position P&L is computed from pool state alone with no oracles, and why closing returns the surplus only rather than the full notional."
---

# P&L Calculation

Position profit and loss is computed entirely from on-chain pool state — no oracles involved.

::: warning You receive the profit, not the position size
The notional is never deposited — opening a position transfers only the fee
(`_transferIn(underlyingUsdc, msg.sender, totalFee)` in `openLong`). So closing
returns the **surplus only**. A $100 position that gains 50% pays out roughly
$50, not $150. Your total outlay was the premium, and your total return is the
surplus minus the 1% close fee.
:::

## Long P&L

When closing a long, the locked airToken is valued back through SWAP-3. Note
that the position's own locked amount is excluded from the reserve it trades
against:

```
airUsdOut = cpAmountOut(lockedAmount, airTokenSupply - lockedAmount, backedAirUsd)
surplus   = airUsdOut - airUsdMinted        // airUsdMinted == the notional
payout    = surplus - 1% close fee
```

- If `surplus > 0` — profit. You receive `payout`.
- If `surplus <= 0` — underwater. You cannot close the position at all; it can
  only be held (renewed) or left to settle for nothing at the deadline.

## Short P&L

When closing a short, the synthetic airToken debt is bought back via SWAP-2:

```
totalBuyable = cpAmountOut(lockedAmount, airUsdSupply - lockedAmount, backedAirToken)
cost         = ceil(lockedAmount * airTokenMinted / totalBuyable)
surplus      = lockedAmount - cost
payout       = surplus - 1% close fee
```

`cost` is what it takes to buy back the synthetic airToken debt; the remainder
of the locked collateral is your profit. The division rounds **up**, in the
pool's favour.

- If `surplus > 0` — the token price dropped, buying back the debt is cheap. Profit.
- If `surplus <= 0` — the token price rose; you cannot close the position.

## Live P&L on your NFT

The PositionNFT contract computes P&L in real-time using calls to the pool. This data is rendered directly in the on-chain SVG metadata — no off-chain service needed.

## Important notes

- P&L depends on pool reserves at the time of closing, not at the time of opening
- Large positions relative to pool size will experience more slippage
- The three-curve design means long and short P&L are not perfectly symmetric
- Positions expire after the pool's position duration — renew before the deadline to keep trading. See [Expiry & Renewal](/positions/expiry)
