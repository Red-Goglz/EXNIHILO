# Force Realize Positions

The LP NFT holder has the authority to force-realize any underwater open position in their pool.

## What is force realize?

Force realize settles an open position early, just like a normal realize — but initiated and paid by the LP instead of the position holder.
The tokens are sent to the position owner.

## When would an LP use this?

- **Pool wind-down** — Before withdrawing all liquidity, the LP needs to settle all outstanding positions
- **Stuck positions** — If a position holder has lost access to their wallet

## Access control

```solidity
pool.realizeLong(tokenId)   // LP or position holder
pool.realizeShort(tokenId)  // LP or position holder
```

The LP is authorized because `realize` checks for either:
- `msg.sender == positionNFT.ownerOf(tokenId)` (position holder), or
- `msg.sender == lpNftContract.ownerOf(lpNftId)` (LP)

