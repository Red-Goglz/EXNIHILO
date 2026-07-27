# Closing Positions

A position is settled by **closing** it — the position's value is realized in USDC against the pool's curves.

## Close

Closing fully settles your position and returns USDC. Only possible when in profit.

### Closing a Long

1. The locked airToken collateral re-enters the pool's backed reserves
2. It is valued through SWAP-3
3. The synthetic airUsd debt (`airUsdMinted`) is cancelled
4. Any surplus is your profit — paid to you in USDC
5. A 1% fee on profit accrues to the protocol treasury
6. The Position NFT is burned

### Closing a Short

1. The locked airUsd collateral is released
2. The synthetic airToken debt is bought back through SWAP-2
3. Remaining airUsd is your profit — paid to you in USDC
4. A 1% fee on profit accrues to the protocol treasury
5. The Position NFT is burned

## Position expiry

Every position has a **deadline**. After the deadline, anyone can call `closePositionAfterDeadline(nftId, minPayout)`:

- **Profitable**: settled like a normal close, but the payout (minus the 1% fee) is **credited to your claimable balance** rather than pushed to your wallet — withdraw it any time with `claimPayout(to)`. This pull-payment design means no wallet condition (e.g. a USDC blacklist) can ever block position cleanup.
- **Underwater**: collateral returns to the LP, synthetic debt is cancelled, no payout

To avoid expiry, call `renewPosition(nftId, maxFee)` before the deadline (or opt into auto-renewal via `PositionNFT.setAutoRenew`). The fee is dynamic — quote it with `quoteRenewFee(nftId)` — and extends the deadline by one position duration. See [Expiry & Renewal](/positions/expiry).

## Who can do what?

- **Close** — only the NFT owner (the trader), at any time while in profit
- **closePositionAfterDeadline** — anyone, but only after the deadline
- **renewPosition** — only the NFT owner (pay fee to extend deadline)
- **claimPayout** — the credited holder, any time after an expiry settlement
