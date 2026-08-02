---
description: "A short is a put with bounded loss. Unlike shorting on margin, a squeeze can never cost you more than the premium you paid when you opened."
---

# Opening a Short

A short position profits when the token price goes down relative to USDC.

**In option terms, a short is a put.** You pay a premium (the open fee), you post no
collateral, and that premium is the most you can lose — unlike shorting on margin, where
losses are theoretically unbounded. See
[Positions Are Options](/introduction/positions-are-options).

::: tip Why this matters more for shorts than longs
A margin short can lose far more than you put in if the token squeezes. An EXNIHILO
short cannot. Your worst case was priced and paid at open.
:::

## How it works

1. You specify a USDC amount (your position size)
2. The protocol takes a 5% open fee (3% to LP, 2% to protocol treasury)
3. Synthetic (unbacked) airToken is minted at the current usdc swap rate
4. The synthetic airToken is swapped through SWAP-3 for airUsd tokens
5. The airUsd tokens are locked in the PositionNFT contract
6. You receive a Position NFT representing your short

## What's in your NFT

Your Position NFT holds:
- **lockedAmount** — airUsd tokens locked as your position
- **airTokenMinted** — the synthetic airToken debt created at open (burned when closing)
- **feesPaid** — total fees paid at open

## Slippage protection

Same as longs — set `minAmountOut` to protect against unfavorable execution.

## Example

You open a short with 100 USDC on a RGOGLZ/USDC pool:

1. 5 USDC fee taken (3 to LP, 2 to treasury)
2. Synthetic airToken minted based on SWAP-3 curve
3. Swapped for airUsd → locked in your NFT
4. If RGOGLZ price drops, buying back the synthetic airToken costs less → profit
