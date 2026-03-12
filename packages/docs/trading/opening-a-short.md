# Opening a Short

A short position profits when the token price goes down relative to USDC.

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
