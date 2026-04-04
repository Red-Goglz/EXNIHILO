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

This is useful for situations where the trader wants to exit and receive the tokens (for staking or governance).

## Position expiry

Every position has a **deadline**. After the deadline, anyone can call `closePositionAfterDeadline(nftId)`:

- **Profitable**: closed like normal — holder receives USDC profit minus 1% fee
- **Underwater**: collateral returns to LP, synthetic debt burned, no payout

To avoid expiry, call `renewPosition(nftId)` before the deadline. This pays 5% of notional and extends the deadline by one position duration. See [Expiry & Renewal](/positions/expiry).

## Who can close / realize / close after deadline?

- **Close** — only the NFT owner (the trader), at any time
- **Realize** — only the NFT owner
- **closePositionAfterDeadline** — anyone, but only after the deadline
- **renewPosition** — anyone, at any time (pay fee to extend deadline)
