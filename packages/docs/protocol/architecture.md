# Architecture Overview

EXNIHILO consists of four smart contracts working together.

## Contract hierarchy

```
EXNIHILOFactory (singleton, immutable, no owner)
  │
  ├── Per market deployment:
  │   └── EXNIHILOPool (AMM + trading engine; airToken/airUsd
  │       accounting lives in the pool as supply counters)
  │
  ├── LpNFT (singleton — one token per pool)
  └── PositionNFT (singleton — all positions across all pools)
```

## Contracts

### EXNIHILOFactory

The entry point for market creation. Fully permissionless — anyone can call `createMarket()`. No admin functions, no owner, all parameters are immutable after deployment.

Deploys the Pool, mints the LP NFT, seeds initial liquidity — all in one atomic transaction.

### EXNIHILOPool

The core contract. Handles:
- Token swaps (SWAP-1)
- Long/short position opens (SWAP-2, SWAP-3)
- Position closes and expiry settlements
- Position renewal and expiry closure
- Liquidity management (add/withdraw)
- Fee accounting and claims
- Position cap enforcement

All state-changing functions are protected by ReentrancyGuard and follow the CEI pattern.

### PositionNFT

Shared ERC-721 Enumerable contract. A pure position registry — locked collateral never leaves the pool; the Position struct records everything settlement needs. Renders fully on-chain SVG metadata with live P&L.

### LpNFT

ERC-721 contract. One token per pool, minted at market creation. The holder has exclusive LP authority over the associated pool.

## Data flow

```
Trader                          LP NFT Holder
  │                                  │
  ├── openLong/openShort ───►  EXNIHILOPool
  │                               │    (supply counters += synthetic mint)
  │                               └──► PositionNFT (mint position record)
  │
  ├── closeLong/closeShort ──►  EXNIHILOPool
  │                               │    (supply counters -= burned debt)
  │                               └──► PositionNFT (burn position record)
  │                               │
  │                          USDC ──► Trader
  │
  └── swap ──────────────────►  EXNIHILOPool (SWAP-1)
```
