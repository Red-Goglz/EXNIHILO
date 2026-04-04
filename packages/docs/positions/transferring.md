# Transferring Positions

Position NFTs are standard ERC-721 tokens and are fully transferable.

## How to transfer

Use any standard ERC-721 transfer method:
- `transferFrom(from, to, tokenId)`
- `safeTransferFrom(from, to, tokenId)`

Or use any NFT marketplace, wallet, or tool that supports ERC-721 transfers.

## What transfers with the NFT

Everything. The new owner gains:
- Full right to **close** the position and receive the USDC settlement
- The locked collateral (custodied in the NFT contract)
- The on-chain SVG metadata showing live P&L

## Use cases

- **Lending a position** — If your position is in profit you could lend it in a protocol that allows this.
- **Portfolio management** — Move positions between your own wallets
- **OTC trading** — Trade positions peer-to-peer without going through the AMM

## Important notes

- Only the current NFT owner can close or realize the position
- After the deadline, anyone can close expired positions
- Transferring the NFT does not change the position's parameters (entry price, fees paid, etc.)
