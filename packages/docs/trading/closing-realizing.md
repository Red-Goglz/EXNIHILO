# Closing & Realizing Positions

There are two ways to settle a position: **close** and **realize**.

## Close

Closing fully settles your position and returns USDC. Only possible when in profit.

### Closing a Long

1. The airToken locked in your NFT is released
2. It's swapped through SWAP-3 for airUsd
3. The synthetic airUsd debt (`airUsdMinted`) is burned
4. Any surplus airUsd is your profit — converted to USDC and sent to you
5. A 1% fee on profit is sent to the protocol treasury
6. The Position NFT is burned

### Closing a Short

1. The airUsd locked in your NFT is released
2. The synthetic airToken debt is bought back through SWAP-2
3. Remaining airUsd is your profit — converted to USDC and sent to you
4. A 1% fee on profit is sent to the protocol treasury
5. The Position NFT is burned

## Realize

Realize releases the locked airTokens instead of swapping to USDC. The synthetic airUsd has to be paid to clear the pool imbalance. The position is still fully settled and the NFT is burned.

This is useful for:
- LP force-realize operations (see [Force Realize Positions](/lp/force-realize))
- Situations where the trader wants to exit and receive the tokens (for staking or governance)

## Who can close / realize?

- **Close** — only the NFT owner (the trader)
- **Realize** — the NFT owner *or* the LP (via force realize when underwater)
