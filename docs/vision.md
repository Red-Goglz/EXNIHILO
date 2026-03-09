# EXNIHILO
### *"Out of Thin Air" — Permissionless Leveraged Trade Platform*
**Product Requirements Document | v1.0 | 2025**

---

## 1. Overview & Product Vision

Exnihilo is a decentralized, permissionless leveraged trading platform built on Avalanche. The name — Latin for *"out of nothing"* — reflects the core mechanic: synthetic wrapper tokens are minted on demand to power directional trades without requiring a traditional order-book or centralized counterparty.

The platform enables any user to:

- Create a market for any ERC-20 token paired against USDC, permissionlessly, via a factory contract.
- Take leveraged long or short positions on the created market.
- Provide liquidity and earn fees, with LP ownership represented as a transferable NFT.

> **Core Principle:** All leverage is synthetic. When a user goes long or short, the protocol mints wrapper tokens representing their position, swaps them through a custom AMM, and locks the resulting tokens in a transferable NFT. No external oracle is required for execution.

---
