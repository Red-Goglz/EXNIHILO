---
description: "Every position is a transferable ERC-721. What the NFT records, where the collateral actually lives, how transfers work, and the fully on-chain artwork."
---

# Position NFTs

Every open position is an ERC-721 in the shared `PositionNFT` contract. Token IDs are sequential
across all markets, and each position's `pool` field says which market it belongs to.

## What it records

| Field | Long | Short |
|---|---|---|
| `isLong` | `true` | `false` |
| `pool` | Pool address | Pool address |
| `lockedAmountAtOpen` | airToken locked | airUsd locked |
| `usdcIn` | USDC notional | USDC notional |
| `airUsdMinted` | Synthetic airUsd debt | `0` |
| `airTokenMinted` | `0` | Synthetic airToken debt |
| `feesPaid` | Open fee | Open fee |
| `openedAt` | Timestamp | Timestamp |
| `fundingIndexAtOpen` | The pool's long funding index at open | The pool's short funding index at open |

Every amount is the **opening** figure. Funding shrinks collateral, debt and notional together,
so read the live figures from the pool with `liveAmountsOf(nftId)`.

The NFT is a registry, not a vault. The collateral never leaves the pool; when a position settles,
the pool calls `release(tokenId)`, which burns the NFT and hands back the record. Only the owning
pool can release a position.

## Transferring

Positions are standard ERC-721s — `transferFrom`, `safeTransferFrom`, or any wallet or
marketplace. The new owner can close the position and choose where the payout goes. Nothing is
tied to the holder: the position keeps its terms and its decay, and there is nothing to re-enable
after a transfer.

## On-chain artwork

`tokenURI` is generated entirely on-chain — no IPFS, no server — reading the pool at call time.
The card shows the side, market and token ID; position size, locked collateral and fees paid;
**live estimated P&L** net of the premium, from the pool's `quoteClose`; and the opened date and
**size remaining**. Size and collateral are net of funding.

The JSON attributes add the synthetic debt — a buyer needs it to price the position — and Return
on Premium %. View the card on any marketplace or explorer that renders `tokenURI`, or decode the
base64 JSON directly.
