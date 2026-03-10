# Contract Reference

## EXNIHILOPool

### State-changing functions

| Function | Access | Description |
|---|---|---|
| `swap(bool tokenToUsdc, uint256 amountIn, uint256 minOut)` | Anyone | Swap tokens via SWAP-1 |
| `openLong(uint256 usdcAmount, uint256 minOut)` | Anyone | Open a long position |
| `openShort(uint256 usdcAmount, uint256 minOut)` | Anyone | Open a short position |
| `closeLong(uint256 tokenId)` | Position owner | Close long, receive USDC |
| `closeShort(uint256 tokenId)` | Position owner | Close short, receive USDC |
| `realizeLong(uint256 tokenId)` | Position owner or LP | Realize long (value stays in pool) |
| `realizeShort(uint256 tokenId)` | Position owner or LP | Realize short (value stays in pool) |
| `addLiquidity(uint256 tokenAmt, uint256 usdcAmt)` | LP only | Add liquidity |
| `withdrawLiquidity(uint256 tokenAmt, uint256 usdcAmt)` | LP only | Withdraw liquidity |
| `claimFees()` | LP only | Claim accumulated LP fees |
| `setPositionCaps(uint256 maxUsd, uint256 maxBps)` | LP only | Set position size caps |

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

### Events

```solidity
event Swap(address indexed trader, bool tokenToUsdc, uint256 amountIn, uint256 amountOut);
event LongOpened(address indexed trader, uint256 indexed tokenId, uint256 usdcIn, uint256 airTokenLocked, uint256 feesPaid);
event ShortOpened(address indexed trader, uint256 indexed tokenId, uint256 usdcIn, uint256 airUsdLocked, uint256 feesPaid);
event LongClosed(address indexed trader, uint256 indexed tokenId, int256 pnl);
event ShortClosed(address indexed trader, uint256 indexed tokenId, int256 pnl);
event LongRealized(address indexed caller, uint256 indexed tokenId);
event ShortRealized(address indexed caller, uint256 indexed tokenId);
event LiquidityAdded(uint256 tokenAmount, uint256 usdcAmount);
event LiquidityWithdrawn(uint256 tokenAmount, uint256 usdcAmount);
event FeesClaimed(address indexed lp, uint256 amount);
event PositionCapsSet(uint256 maxPositionUsd, uint256 maxPositionBps);
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

## LpNFT

| Function | Description |
|---|---|
| `poolOf(uint256 tokenId)` | Get pool address for LP token |
| `ownerOf(uint256 tokenId)` | Current LP holder |
