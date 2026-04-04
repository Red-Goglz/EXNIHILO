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

- You can only withdraw 100%
- You can only withdaw if there no open positions.
- Close a market to stop the creation of new positions or renew payments. Use this carefully and make sure to announce it to your community. 
- Wrapper tokens are burned, real tokens returned to the LP
- `backedAirToken` and `backedAirUsd` decrease


## Access control

Both operations check:
```
require(msg.sender == lpNftContract.ownerOf(lpNftId))
```

If you transfer your LP NFT, you immediately lose the ability to add or withdraw.
