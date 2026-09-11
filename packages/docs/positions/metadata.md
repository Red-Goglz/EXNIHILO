---
description: "Position NFT artwork is generated fully on-chain with no IPFS and no servers. The SVG shows side, size, fees paid and live estimated P&L."
---

# On-chain SVG Metadata

Every Position NFT has fully on-chain artwork — no IPFS, no external servers.

## What's rendered

The SVG displays (same layout for both sides):
- **EXNIHILO** glitch logo with animated cyan/red layers
- **LONG** or **SHORT** badge with color coding (green / red)
- **Token ID** in the header
- **Position size** — the USDC notional
- **Locked collateral** — airToken amount for longs, USDC for shorts
- **Fees paid** — cumulative, including any auto-renewal fees
- **Live estimated P&L** — computed from current pool reserves, with a percentage relative to fees paid
- **Opened** and **Expires** dates — the deadline updates on every renewal

## JSON attributes

Beyond the artwork, `tokenURI` exposes marketplace-standard attributes: Side,
Market, Token ID, Position Size (USDC), Locked collateral, the synthetic
**debt** (airUSD for longs / airToken for shorts — a buyer needs this to price
the position, since it defines the break-even and grows with equity-funded
auto-renewals), Fees Paid, Opened, Deadline, Est. PnL (USDC), and
Est. PnL % (on fees).

## Live P&L

The `tokenURI()` function reads pool state at call time:

- Queries the pool's `quoteClose()` view, which prices the position from `backedAirToken`, `backedAirUsd`, `airTokenSupply`, and `airUsdSupply`
- Computes the current value of locked tokens vs the synthetic debt
- Renders the P&L as green (+$X.XX) or red (-$X.XX)

## Viewing

The NFT artwork is visible on:
- Any NFT marketplace that supports on-chain SVG (e.g., Snowtrace)
- Block explorers that render `tokenURI`
- Directly calling `tokenURI(tokenId)` and decoding the base64 JSON
