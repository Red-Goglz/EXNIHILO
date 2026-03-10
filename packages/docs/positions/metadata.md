# On-chain SVG Metadata

Every Position NFT has fully on-chain artwork — no IPFS, no external servers.

## What's rendered

The SVG displays:
- **EXNIHILO** glitch logo with animated cyan/red layers
- **LONG** or **SHORT** badge with color coding (green / red)
- **Token ID** in the header
- **Position size** (USDC for longs, locked amount for shorts)
- **Locked tokens** (airToken amount for longs)
- **Fees paid**
- **Live estimated P&L** — computed from current pool reserves
- **Open date**

## Live P&L

The `tokenURI()` function reads pool state at call time:

- Queries `backedAirToken`, `backedAirUsd`, `airToken.totalSupply()`, `airUsd.totalSupply()`
- Computes the current value of locked tokens vs the synthetic debt
- Renders the P&L as green (+$X.XX) or red (-$X.XX)

All pool reads are wrapped in `try/catch` — if the pool is in an unexpected state, P&L shows "N/A" instead of reverting.

## Design

The SVG matches the EXNIHILO cyberpunk aesthetic:
- Black background with border decorations (cyan corner accents)
- Monospace font (Courier New)
- Glitch animation on the title (CSS keyframes — works in browsers and some NFT viewers)

## Viewing

The NFT artwork is visible on:
- Any NFT marketplace that supports on-chain SVG (e.g., OpenSea)
- Block explorers that render `tokenURI`
- Directly calling `tokenURI(tokenId)` and decoding the base64 JSON
