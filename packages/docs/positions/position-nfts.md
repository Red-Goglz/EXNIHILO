# Position NFTs

Every open position in EXNIHILO is represented as an ERC-721 NFT.

## What the NFT holds

The PositionNFT contract custodies the locked wrapper tokens for the lifetime of the position:

| Field | Long | Short |
|---|---|---|
| `isLong` | true | false |
| `pool` | Pool address | Pool address |
| `lockedToken` | airToken address | airUsd address |
| `lockedAmount` | airToken locked | airUsd locked |
| `usdcIn` | USDC position size | 0 |
| `airUsdMinted` | Synthetic debt | 0 |
| `airTokenMinted` | 0 | Synthetic debt |
| `feesPaid` | Open fees | Open fees |
| `openedAt` | Block timestamp | Block timestamp |

## Shared singleton

All pools share a single PositionNFT contract. Token IDs are sequential across all markets. The `pool` field in each position identifies which pool it belongs to.

## ERC-721 Enumerable

PositionNFT inherits `ERC721Enumerable`, which means:
- `balanceOf(address)` — how many positions a user holds
- `tokenOfOwnerByIndex(address, index)` — iterate through a user's positions

The frontend uses this to populate the Portfolio page.

## Collateral custody

The locked wrapper tokens (airToken for longs, airUsd for shorts) live in the PositionNFT contract, not in the pool. This provides clean separation — the pool's reserves and position collateral are physically separate.

When a position is settled, the pool calls `release(tokenId)`, which:
1. Burns the NFT
2. Returns locked tokens to the pool
3. Returns the Position struct so the pool can complete settlement math
