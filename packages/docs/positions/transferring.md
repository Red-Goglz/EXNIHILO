---
description: "Position NFTs are standard ERC-721s and freely transferable. What the new owner gains — and the one setting that deliberately does not transfer."
---

# Transferring Positions

Position NFTs are standard ERC-721 tokens and are fully transferable.

## How to transfer

Use any standard ERC-721 transfer method:
- `transferFrom(from, to, tokenId)`
- `safeTransferFrom(from, to, tokenId)`

Or use any NFT marketplace, wallet, or tool that supports ERC-721 transfers.

## What transfers with the NFT

The new owner gains:
- Full right to **close**, **renew**, and configure the position
- The locked collateral (custodied in the NFT contract)
- The on-chain SVG metadata showing live P&L

One thing deliberately does **not** transfer: the **auto-renewal opt-in** is
cleared on every ownership change. A buyer must call `setAutoRenew` themselves
— nobody inherits a keeper authorization they never gave.

## Use cases

- **Lending a position** — If your position is in profit you could lend it in a protocol that allows this.
- **Portfolio management** — Move positions between your own wallets
- **OTC trading** — Trade positions peer-to-peer without going through the AMM

## Important notes

- Only the current NFT owner can close or renew the position before its deadline
- After the deadline, anyone can settle expired positions (via `settleExpired`, earning a 0.05 USDC bounty)
- Transferring the NFT does not change the position's parameters (entry price, debt, fees paid, deadline) — only the auto-renew flag resets
