# LP NFT & Ownership

EXNIHILO uses a single-LP model. Each pool has exactly one liquidity provider, identified by an LP NFT.

## How it works

When a market is created via the Factory:
1. An LP NFT is minted to the market creator
2. The NFT is linked to the new pool via `poolOf(tokenId)`
3. Initial liquidity (underlying tokens + USDC) is seeded into the pool

The LP NFT holder has exclusive authority over all LP operations.

## LP rights

Whoever holds the LP NFT can:
- **Add liquidity** — deposit more tokens + USDC
- **Withdraw liquidity** — remove tokens + USDC when there is no open position (long or short)
- **Claim fees** — withdraw accumulated LP fees (3% of position opens)
- **Set position caps** — limit individual position sizes
- **Force realize positions** — settle any underwater open position

## Transferring LP ownership

The LP NFT is a standard ERC-721 token. Transferring it transfers all LP rights immediately. The new owner can perform all LP operations on the pool.

This enables:
- Selling a profitable pool
- Delegating management to another wallet
- Building composable LP protocols on top

## One LP per pool

This is a deliberate design choice:
- **Simple fee accounting** — no pro-rata distribution needed
- **Clear authority** — one entity controls pool parameters
- **Full transferability** — LP rights are a single, tradeable asset
- **No LP token fragmentation** — no impermanent loss calculations across multiple LPs
