# Opening a Long

A long position profits when the token price goes up relative to USDC.

## How it works

1. You specify a USDC amount (your position size)
2. The protocol takes a 5% base fee (3% to LP, 2% to protocol treasury) plus a dynamic impact fee (to LP) that scales with position size relative to pool liquidity
3. Synthetic (unbacked) airUsd is minted
4. The synthetic airUsd is swapped through SWAP-2 for airToken tokens
5. The airToken tokens are locked in the PositionNFT contract
6. You receive a Position NFT representing your long

## What's in your NFT

Your Position NFT holds:
- **lockedAmount** — airToken tokens locked as your position
- **usdcIn** — your original USDC position size
- **airUsdMinted** — the synthetic airUsd debt created at open (this is what you "owe" when closing)
- **feesPaid** — total fees paid at open

## Slippage protection

You set a `minAmountOut` when opening. If the AMM would give you fewer airToken tokens than this minimum, the transaction reverts. This protects against front-running and large price moves.

## Position caps

The LP may set caps on position size:
- **maxPositionUsd** — hard dollar cap per position
- **maxPositionBps** — soft cap as a percentage of pool TVL

If either cap is active and your position exceeds it, the transaction reverts.

## Example

You open a long with 100 USDC on a RGOGLZ/USDC pool:

1. ~5.08 USDC fee taken (3 base + 0.08 impact to LP, 2 to treasury)
2. mints 100 synthetic airUsd
3. Swapped for airToken → locked in your NFT
4. If RGOGLZ price rises, your airToken is worth more airUsd when you close → profit
