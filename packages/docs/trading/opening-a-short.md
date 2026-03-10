# Opening a Short

A short position profits when the token price goes down relative to USDC.

## How it works

1. You specify a USDC amount (your position size)
2. The protocol takes a 5% open fee (3% to LP, 2% to protocol treasury)
3. The remaining USDC is deposited into the pool, minting backed airUsd
4. Synthetic (unbacked) airToken is minted — this is your leverage
5. The synthetic airToken is swapped through SWAP-3 for airUsd tokens
6. The airUsd tokens are locked in the PositionNFT contract
7. You receive a Position NFT representing your short

## What's in your NFT

Your Position NFT holds:
- **lockedAmount** — airUsd tokens locked as your position
- **airTokenMinted** — the synthetic airToken debt created at open (burned when closing)
- **feesPaid** — total fees paid at open

## Slippage protection

Same as longs — set `minAmountOut` to protect against unfavorable execution.

## Example

You open a short with 100 USDC on a PEPE/USDC pool:

1. 5 USDC fee taken (3 to LP, 2 to treasury)
2. 95 USDC deposited → mints 95 backed airUsd
3. Synthetic airToken minted based on SWAP-3 curve
4. Swapped for airUsd → locked in your NFT
5. If PEPE price drops, buying back the synthetic airToken costs less → profit
