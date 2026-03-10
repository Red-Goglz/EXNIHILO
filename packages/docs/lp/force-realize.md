# Force Realize Positions

The LP NFT holder has the authority to force-realize any open position in their pool.

## What is force realize?

Force realize settles an open position early, just like a normal realize — but initiated by the LP instead of the position holder.

The settlement math is identical:
1. Locked tokens are released from the Position NFT
2. Synthetic debt is settled through the AMM
3. Remaining value stays in the pool as backed reserves
4. The Position NFT is burned

The key difference: **the position holder does not receive USDC**. The remaining value goes to the pool's reserves.

## When would an LP use this?

- **Risk management** — If a large position is creating excessive exposure
- **Pool wind-down** — Before withdrawing all liquidity, the LP may want to settle outstanding positions
- **Stuck positions** — If a position holder has lost access to their wallet

## Access control

```solidity
pool.realizeLong(tokenId)   // LP or position holder
pool.realizeShort(tokenId)  // LP or position holder
```

The LP is authorized because `realize` checks for either:
- `msg.sender == positionNFT.ownerOf(tokenId)` (position holder), or
- `msg.sender == lpNftContract.ownerOf(lpNftId)` (LP)

## Important notes

::: warning
Force realize does not pay out USDC to the position holder. The value remains in the pool. This is a powerful LP tool and should be used responsibly.
:::

- Force realize uses the **realize** path, not the close path
- The position holder's NFT is burned regardless
- No close fee is charged (since no USDC is withdrawn)
