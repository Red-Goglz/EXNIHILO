# Key Concepts

## Buy Now, Pay Later Trading

Unlike traditional perps where you post collateral and face liquidation, EXNIHILO positions only require the fees to open. You pay USDC to open a position and receive an NFT. When you close in profit, you get back USDC — depending on price movement.

There is no margin, no funding rate, and no liquidation engine.

## Three-Curve AMM

Every EXNIHILO pool runs three constant-product curves simultaneously:

| Curve | X Reserve | Y Reserve | Used For |
|---|---|---|---|
| **SWAP-1** | backedAirToken | backedAirUsd | Normal token swaps |
| **SWAP-2** | backedAirToken | airUsd.totalSupply() | Open long / close short |
| **SWAP-3** | airToken.totalSupply() | backedAirUsd | Open short / close long |

All three use the standard `x * y = k` formula. The key insight: **backed reserves** track real collateral, while **totalSupply** includes synthetic (unbacked) mints. This divergence is what creates leveraged price exposure.

## Synthetic Minting

When you open a long, the protocol mints synthetic airUsd (not backed by real USDC). This inflates `airUsd.totalSupply()` without changing `backedAirUsd`.

When you open a short, synthetic airToken is minted instead, inflating `airToken.totalSupply()`.

These synthetic tokens are burned when the position is closed, restoring the supply ratio.

## Backed vs Total Supply

- **backedAirToken** / **backedAirUsd** — Real collateral deposited by LPs and swappers. Always ≤ totalSupply.
- **totalSupply** — Backed tokens + synthetic tokens from open positions.

The ratio between backed and total supply determines how much leverage exists in the system.

## Position NFTs

Every position (long or short) is an ERC-721 token. The NFT custodies the locked wrapper tokens for the position's lifetime. This means:

- Positions are transferable and tradeable
- Collateral is safely isolated from the pool
- On-chain SVG metadata shows live P&L

## Single-LP Model

Each pool has exactly one liquidity provider, identified by an LP NFT. The LP earns swap fees passively and collects a 3% fee on every position opened. Transferring the LP NFT transfers all LP rights.
