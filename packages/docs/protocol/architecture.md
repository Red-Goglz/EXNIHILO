# Architecture Overview

EXNIHILO consists of five smart contracts working together.

## Contract hierarchy

```
EXNIHILOFactory (singleton, immutable, no owner)
  │
  ├── Per market deployment:
  │   ├── AirToken (airToken — wraps underlying ERC-20)
  │   ├── AirToken (airUsd — wraps USDC)
  │   └── EXNIHILOPool (AMM + trading engine)
  │
  ├── LpNFT (singleton — one token per pool)
  └── PositionNFT (singleton — all positions across all pools)
```

## Contracts

### EXNIHILOFactory

The entry point for market creation. Fully permissionless — anyone can call `createMarket()`. No admin functions, no owner, all parameters are immutable after deployment.

Deploys AirTokens + Pool, mints LP NFT, seeds initial liquidity — all in one atomic transaction.

### EXNIHILOPool

The core contract. Handles:
- Token swaps (SWAP-1)
- Long/short position opens (SWAP-2, SWAP-3)
- Position closes and realizes
- Liquidity management (add/withdraw)
- Fee accounting and claims
- Position cap enforcement

All state-changing functions are protected by ReentrancyGuard and follow the CEI pattern.

### AirToken

Minimal ERC-20 wrapper. Deployed twice per market. Only the owning pool can mint/burn. The factory wires it to the pool via `initPool()` (one-shot, irreversible).

### PositionNFT

Shared ERC-721 Enumerable contract. Custodies locked wrapper tokens for all positions across all pools. Renders fully on-chain SVG metadata with live P&L.

### LpNFT

ERC-721 contract. One token per pool, minted at market creation. The holder has exclusive LP authority over the associated pool.

## Data flow

```
Trader                          LP NFT Holder
  │                                  │
  ├── openLong/openShort ───►  EXNIHILOPool
  │                               │    │
  │                    mint ──► AirTokens   ──► PositionNFT (custody)
  │                               │
  ├── closeLong/closeShort ──►  EXNIHILOPool
  │                               │
  │                    burn ──► AirTokens   ──► PositionNFT (release)
  │                               │
  │                          USDC ──► Trader
  │
  └── swap ──────────────────►  EXNIHILOPool (SWAP-1)
```
