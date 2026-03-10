# Adding & Withdrawing Liquidity

Only the LP NFT holder can add or withdraw liquidity from a pool.

## Adding liquidity

Call `addLiquidity(tokenAmount, usdcAmount)` on the pool.

- Both underlying tokens and USDC must be provided
- Tokens are wrapped into airToken and airUsd
- `backedAirToken` and `backedAirUsd` increase
- The LP must approve both tokens before calling

::: tip
Adding liquidity increases the pool's TVL and reduces price impact for traders. Larger pools attract more trading volume and fee revenue.
:::

## Withdrawing liquidity

Call `withdrawLiquidity(tokenAmount, usdcAmount)` on the pool.

- You can withdraw up to the current backed reserves
- Wrapper tokens are burned, real tokens returned to the LP
- `backedAirToken` and `backedAirUsd` decrease

::: warning
Withdrawing too much liquidity while positions are open can increase price impact and may affect position settlement. The reserve invariant (`backed ≤ totalSupply`) is always enforced.
:::

## Access control

Both operations check:
```
require(msg.sender == lpNftContract.ownerOf(lpNftId))
```

If you transfer your LP NFT, you immediately lose the ability to add or withdraw.
