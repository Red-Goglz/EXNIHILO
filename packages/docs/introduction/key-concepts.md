# Key Concepts

## Positions Are Options

The single most useful frame: **an EXNIHILO position is an option**. The open fee is the
premium, a long is a call, a short is a put, and the premium is the maximum you can
lose. [Positions Are Options](./positions-are-options) covers the full mapping — and,
importantly, the four places where the analogy breaks.

## Premium, Not Collateral

Unlike traditional perps where you post collateral and face liquidation, EXNIHILO
positions only require the fees. You pay USDC to open a position and receive an NFT.
Those fees have to be paid again to extend the duration of a position. When you close in
profit, you get back USDC — depending on price movement.

There is no margin and no liquidation engine. Instead of a funding rate, positions have
a **deadline** — after which anyone can settle the position. Traders pay a fee to extend
the deadline, repriced each period at the position's current value and the pool's open
interest. Winners can opt into **auto-renewal**, where the fee is paid out of the
position's own profit — a winning position sustains itself; one that can't pay settles.
See [Expiry & Renewal](/positions/expiry).

::: tip Why no liquidations is not a marketing claim
Margin products *lend* you exposure, and anything lent can be recalled — liquidation is
simply that recall. EXNIHILO lends nothing; it mints synthetic units instead. With
nothing borrowed, there is nothing to call back. The tradeoff is that the premium is
non-refundable and a losing position cannot be closed at all.
:::

## Three-Curve AMM

Every EXNIHILO pool runs three constant-product curves simultaneously:

| Curve | X Reserve | Y Reserve | Used For |
|---|---|---|---|
| **SWAP-1** | backedAirToken | backedAirUsd | Normal token swaps |
| **SWAP-2** | backedAirToken | airUsdSupply | Open long / close short |
| **SWAP-3** | airTokenSupply | backedAirUsd | Open short / close long |

All three use the standard `x * y = k` formula. The key insight: **backed reserves** track real collateral, while the **supply counters** include synthetic (unbacked) mints. This divergence is what creates leveraged price exposure.

## Synthetic Minting

When you open a long, the protocol mints synthetic airUsd (not backed by real USDC). This inflates `airUsdSupply` without changing `backedAirUsd`.

When you open a short, synthetic airToken is minted instead, inflating `airTokenSupply`.

These synthetic units are burned when the position is closed, restoring the supply ratio.

## Backed vs Total Supply

- **backedAirToken** / **backedAirUsd** — Real collateral deposited by LPs and swappers. Always ≤ the supply counter.
- **airTokenSupply** / **airUsdSupply** — Backed units + synthetic units from open positions.

The ratio between backed and total supply determines how much leverage exists in the system.

## Position NFTs

Every position (long or short) is an ERC-721 token. The NFT records the position's locked collateral and debt for its lifetime (the collateral itself never leaves the pool). This means:

- Positions are transferable and tradeable
- Collateral is safely isolated from the pool
- On-chain SVG metadata shows live P&L

## Single-LP Model

Each pool has exactly one liquidity provider, identified by an LP NFT. The LP earns swap fees passively, collects a 3% base fee on every position opened, and receives a dynamic impact fee that scales with position size relative to pool liquidity. Transferring the LP NFT transfers all LP rights.
