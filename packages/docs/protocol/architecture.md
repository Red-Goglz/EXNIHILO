---
description: "The contracts that make up EXNIHILO — factory, pool, NFTs, router and the launchpad stack — and how a market and a position move through them."
---

# Architecture

Nothing is upgradeable: no proxies, no `delegatecall`, and no owner on the factory.

```
EXNIHILOFactory ── PoolDeployer ──► EXNIHILOPool     one per market
      ├── LpNFT                        one token per pool — the LP's control
      └── PositionNFT                  every position in every pool

EXNIHILORouter                         one approval for opens and swaps on any pool

PreMarketFactory ──► PreMarket ── buyout ──► EXNIHILOFactory
                                              └── LockedLpVault holds the LP NFT
```

## Core contracts

| Contract | Role |
|---|---|
| **EXNIHILOFactory** | Permissionless `createMarket`: deploys the pool through `PoolDeployer`, mints the LP NFT and seeds liquidity in one transaction. Its one privileged role, `deployer`, can call `closePool` on any pool |
| **EXNIHILOPool** | Everything per market — the three curves, swaps, positions, funding, dust sweeps, liquidity, fee accounting and position caps. Holds all tokens and all collateral |
| **PositionNFT** | Shared ERC-721 registry of positions with on-chain SVG metadata. Holds no funds; only the owning pool can release a position |
| **LpNFT** | ERC-721, one per pool; its holder is that pool's LP |
| **EXNIHILORouter** | Pulls the quoted fee or swap input, forwards the call, and refunds anything unused. Holds nothing between transactions; closes and LP operations go straight to the pool |
| **PoolDeployer** | Deploys pools for the factory, keeping the pool's bytecode out of the factory |

## Launchpad contracts

| Contract | Role |
|---|---|
| **PreMarketFactory** | Seeds a `PreMarket` for a token bonded in some quote asset |
| **PreMarket** | A token/quote AMM with a descending-price USDC auction on its quote reserve. The buyout creates the real market; with USDC as the quote it launches directly |
| **LockedLpVault** | Holds a launched market's LP NFT with no withdrawal path, and splits its fee stream between the project and the integrator |

See [SDK — Launchpad integration](/developers/sdk#launchpad-integration).

## A position's path

```
open     trader ─ fee ─► Router ─► Pool    mint synthetic debt, lock collateral
                                    └──► PositionNFT.mint
funding                            Pool    every position on a side shrinks, every second
close    holder ────────────────► Pool    price against the curves, pay the surplus
                                    └──► PositionNFT.release (burn)
```
