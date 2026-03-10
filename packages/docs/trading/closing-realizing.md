# Closing & Realizing Positions

There are two ways to settle a position: **close** and **realize**.

## Close

Closing fully settles your position and returns USDC.

### Closing a Long

1. The airToken locked in your NFT is released back to the pool
2. It's swapped through SWAP-3 for airUsd
3. The synthetic airUsd debt (`airUsdMinted`) is burned
4. Any surplus airUsd is your profit — converted to USDC and sent to you
5. If there's a deficit, you receive less than you put in (loss)
6. A 1% fee on profit is sent to the protocol treasury
7. The Position NFT is burned

### Closing a Short

1. The airUsd locked in your NFT is released back to the pool
2. The synthetic airToken debt is bought back through SWAP-2
3. Remaining airUsd is your profit — converted to USDC and sent to you
4. A 1% fee on profit is sent to the protocol treasury
5. The Position NFT is burned

## Realize

Realize works like close, but instead of receiving USDC, the profit (or remaining value) stays in the pool as additional backed reserves. The position is still fully settled and the NFT is burned.

This is useful for:
- LP force-realize operations (see [Force Realize Positions](/lp/force-realize))
- Situations where the trader wants to exit without withdrawing USDC

## Who can close / realize?

- **Close** — only the NFT owner (the trader)
- **Realize** — the NFT owner *or* the LP (via force realize)
