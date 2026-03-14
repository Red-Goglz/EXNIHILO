# Contract Reference

## EXNIHILOPool

### State-changing functions

| Function | Access | Description |
|---|---|---|
| `swap(uint256 amountIn, uint256 minAmountOut, bool tokenToUsdc, address recipient)` | Anyone | Swap tokens via SWAP-1, output sent to `recipient` |
| `openLong(uint256 usdcAmount, uint256 minAirTokenOut, address recipient)` | Anyone | Open a long position, NFT minted to `recipient` |
| `openShort(uint256 usdcNotional, uint256 minAirUsdOut, address recipient)` | Anyone | Open a short position, NFT minted to `recipient` |
| `closeLong(uint256 nftId, uint256 minUsdcOut)` | Position owner | Close long via AMM, receive USDC profit |
| `closeShort(uint256 nftId, uint256 minUsdcOut)` | Position owner | Close short via AMM, receive USDC profit |
| `realizeLong(uint256 nftId)` | Position owner | Deliver USDC to cover debt, receive locked tokens at par |
| `realizeShort(uint256 nftId)` | Position owner | Deliver tokens to cover debt, receive locked USDC at par |
| `forceRealize(uint256 nftId)` | LP only | Force-realize an underwater position (LP pays the debt) |
| `addLiquidity(uint256 tokenAmount, uint256 usdcAmount)` | LP only | Add liquidity (must match reserve ratio) |
| `removeLiquidity()` | LP only | Withdraw all liquidity (requires zero open positions) |
| `claimFees()` | LP only | Claim accumulated LP fees |
| `setPositionCaps(uint256 newUsd, uint256 newBps)` | LP only | Set position size caps |

### View functions

| Function | Returns |
|---|---|
| `spotPrice()` | Current token price in raw USDC units per whole token |
| `backedAirToken()` | Backed token reserves |
| `backedAirUsd()` | Backed USDC reserves |
| `longOpenInterest()` | Aggregate long open interest |
| `shortOpenInterest()` | Aggregate short open interest |
| `lpFeesAccumulated()` | Unclaimed LP fees (USDC) |
| `maxPositionUsd()` | Hard position cap |
| `maxPositionBps()` | Soft position cap (bps) |
| `swapFeeBps()` | Swap fee in bps |
| `openPositionCount()` | Number of open positions |
| `quoteSwap(uint256 amountIn, bool tokenToUsdc)` | Quote a swap: `(grossOut, fee, netOut)` |
| `effectiveLeverageCap()` | Effective position cap in USDC |
| `isLongUnderwater(uint256 nftId)` | Whether a long position is underwater |
| `isShortUnderwater(uint256 nftId)` | Whether a short position is underwater |

### Events

```solidity
event Swap(address indexed caller, address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut);
event LongOpened(uint256 indexed nftId, address indexed holder, uint256 usdcIn, uint256 airUsdMinted, uint256 airTokenLocked, uint256 feesPaid);
event LongClosed(uint256 indexed nftId, address indexed holder, uint256 profit, uint256 airUsdBurned);
event LongRealized(uint256 indexed nftId, address indexed holder, uint256 usdcPaid, uint256 tokenDelivered);
event ShortOpened(uint256 indexed nftId, address indexed holder, uint256 airTokenMinted, uint256 airUsdLocked, uint256 feesPaid);
event ShortClosed(uint256 indexed nftId, address indexed holder, uint256 profit, uint256 airTokenBurned);
event ShortRealized(uint256 indexed nftId, address indexed holder, uint256 tokenPaid, uint256 usdcDelivered);
event PositionForceRealized(uint256 indexed nftId, address indexed lpOwner, uint256 collateralPaid);
event LiquidityAdded(address indexed provider, uint256 tokenAmount, uint256 usdcAmount, uint256 backedAirToken, uint256 backedAirUsd);
event LiquidityRemoved(address indexed provider, uint256 tokenAmount, uint256 usdcAmount);
event FeesClaimed(address indexed lpOwner, uint256 amount);
event PositionCapsUpdated(uint256 newMaxPositionUsd, uint256 newMaxPositionBps, address indexed by);
```

## EXNIHILOFactory

| Function | Description |
|---|---|
| `createMarket(address tokenAddress, uint256 tokenAmount, uint256 usdcAmount, uint256 swapFeeBps)` | Deploy a new market |
| `allPools(uint256 index)` | Get pool address by index |
| `poolCount()` | Total number of deployed pools |

## PositionNFT

| Function | Description |
|---|---|
| `getPosition(uint256 tokenId)` | Read position data |
| `tokenURI(uint256 tokenId)` | On-chain SVG metadata |
| `balanceOf(address owner)` | Number of positions held |
| `tokenOfOwnerByIndex(address owner, uint256 index)` | Enumerate positions |

## EXNIHILORouter

The router allows users to approve USDC (and underlying tokens) once, then trade on any pool without per-pool approvals. LP operations and position exits (close/realize) are called directly on the pool.

| Function | Description |
|---|---|
| `openLong(address pool, uint256 usdcAmount, uint256 minAirTokenOut)` | Open long via router — pulls USDC from caller, NFT minted to caller |
| `openShort(address pool, uint256 usdcNotional, uint256 minAirUsdOut)` | Open short via router — pulls USDC from caller, NFT minted to caller |
| `swap(address pool, uint256 amountIn, uint256 minAmountOut, bool tokenToUsdc)` | Swap via router — pulls input token from caller, output sent to caller |
| `factory()` | Factory address (immutable) |
| `usdc()` | USDC address (immutable) |

## LpNFT

| Function | Description |
|---|---|
| `poolOf(uint256 tokenId)` | Get pool address for LP token |
| `ownerOf(uint256 tokenId)` | Current LP holder |
