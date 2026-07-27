# Contract Reference

## EXNIHILOPool

### State-changing functions

| Function | Access | Description |
|---|---|---|
| `swap(uint256 amountIn, uint256 minAmountOut, bool tokenToUsdc, address recipient)` | Anyone | Swap tokens via SWAP-1, output sent to `recipient` |
| `openLong(uint256 usdcAmount, uint256 minAirTokenOut, address recipient)` | Anyone | Open a long position, NFT minted to `recipient` |
| `openShort(uint256 usdcNotional, uint256 minAirUsdOut, address recipient)` | Anyone | Open a short position, NFT minted to `recipient` |
| `closeLong(uint256 nftId, uint256 minUsdcOut)` | Position owner | Close long via AMM, receive USDC profit directly |
| `closeShort(uint256 nftId, uint256 minUsdcOut)` | Position owner | Close short via AMM, receive USDC profit directly |
| `renewPosition(uint256 nftId, uint256 maxFee)` | Position owner | Pay the dynamic renewal fee (quote via `quoteRenewFee`) to extend the deadline by one period; reverts if the fee exceeds `maxFee` |
| `closePositionAfterDeadline(uint256 nftId, uint256 minPayout)` | Anyone | Settle an expired position (profitable: payout credited to holder's claimable balance; underwater: collateral returns to LP). Reverts `AutoRenewActive` if an executable auto-renewal exists |
| `settleExpired(uint256 nftId, uint256 minPayout)` | Anyone | Settle an expired position with a 0.05 USDC caller bounty; auto-renews from position equity instead of closing when the holder opted in via `PositionNFT.setAutoRenew` |
| `claimPayout(address to)` | Credited holder | Withdraw payouts credited by expired-position settlements |
| `addLiquidity(uint256 tokenAmount, uint256 usdcAmount)` | LP only | Add liquidity (must match reserve ratio) |
| `removeLiquidity()` | LP only | Withdraw all liquidity (requires zero open positions) |
| `claimFees(address to)` | LP only | Claim accrued LP fees (fees are pull payments) |
| `claimProtocolFees(address to)` | Treasury only | Claim accrued protocol fees |
| `setPositionCaps(uint256 newUsd, uint256 newBps)` | LP only | Set position size caps |
| `closePool()` | LP or deployer | Start pool wind-down (no new positions; all expire by closeDate) |

### View functions

| Function | Returns |
|---|---|
| `spotPrice()` | Current token price in raw USDC units per whole token |
| `longPrice()` / `shortPrice()` | Effective entry prices (SWAP-2 / SWAP-3 marginal rates) |
| `airTokenSupply()` / `airUsdSupply()` | Total accounting-unit supplies (virtual reserves) |
| `backedAirToken()` / `backedAirUsd()` | Backed reserves (real collateral) |
| `tokenDecimals()` | Underlying token decimals |
| `longOpenInterest()` / `shortOpenInterest()` | Aggregate open interest per side |
| `lpFeesAccumulated()` / `protocolFeesAccumulated()` | Accrued unclaimed fees (USDC) |
| `lpFeesPaidTotal()` / `protocolFeesPaidTotal()` | Fees already withdrawn. `accumulated + paidTotal` is the monotonic lifetime accrual — use it to diff between two points in time |
| `claimable(address)` | Credited payout awaiting withdrawal |
| `totalClaimable()` | Sum of all outstanding credited payouts |
| `totalShortCollateral()` | Sum of `lockedAmount` across open shorts. USDC the pool holds but owes to traders; included in the reserve invariant |
| `maxPositionUsd()` / `maxPositionBps()` | Position caps |
| `swapFeeBps()` | Swap fee in bps |
| `openPositionCount()` | Number of open positions |
| `effectiveLeverageCap()` | Effective position cap in USDC |
| `quoteOpenFee(uint256 notional, bool isLong)` | Total USDC fee to open a position now |
| `quoteRenewFee(uint256 nftId)` | Total USDC fee to renew a position now (dynamic: mark value + OI slice) |
| `quoteClose(uint256 nftId)` | `(ready, pnl)` — live close quote mirroring settlement math |
| `positionDuration()` / `closeDate()` / `isClosing()` | Expiry / wind-down state |
| `indexerState()` | `(backedAirToken, backedAirUsd, longPrice, shortPrice, lpFeesLifetime, protocolFeesLifetime)` in one call — see below |

#### `indexerState()`

Bundles the six values an off-chain indexer needs on every pool event into a
single `eth_call`. Fetching them separately cost eight calls per event, which
made RPC volume the dominant cost of a sync and is the first thing a
rate-limited provider punishes.

Fees are returned as **lifetime** totals (`accumulated + paidTotal`) because
that is the only monotonic form: collecting fees zeroes the accumulator and adds
the same amount to the paid total, so the sum never decreases and a consumer can
safely diff it between events.

Prefer extending this function over adding a second read. Bundling
contract-side works on every chain, unlike Multicall3, which is not deployed on
a bare Hardhat node.

### Events

```solidity
event PositionOpened(uint256 indexed nftId, address indexed holder, bool isLong);
event PositionRenewed(uint256 indexed nftId, address indexed caller, uint256 feePaid, uint256 newDeadline, bool autoRenewed);
event PositionClosed(uint256 indexed nftId, address indexed holder, uint256 payout);
event PositionClosedAfterDeadline(uint256 indexed nftId, address indexed caller, uint256 payout);
event PayoutCredited(address indexed recipient, uint256 amount);
event PayoutClaimed(address indexed recipient, address indexed to, uint256 amount);
event PoolClosed(address indexed closedBy, uint256 closeDate);
event LpFeesPaid(address indexed to, uint256 amount);
event ProtocolFeesPaid(address indexed to, uint256 amount);
```

## EXNIHILOFactory

| Function | Description |
|---|---|
| `createMarket(address tokenAddress, uint256 usdcAmount, uint256 tokenAmount, uint256 maxPositionUsd, uint256 maxPositionBps, uint256 positionDuration)` | Deploy a new market (positionDuration: 0 = 7-day default; token decimals read on-chain) |
| `allPools(uint256 index)` | Get pool address by index |
| `allPoolsLength()` | Total number of deployed pools |
| `isPool(address)` | Whether an address is a factory-deployed pool |

## PositionNFT

| Function | Description |
|---|---|
| `getPosition(uint256 tokenId)` | Read position data |
| `tokenURI(uint256 tokenId)` | On-chain SVG metadata |
| `balanceOf(address owner)` | Number of positions held |
| `tokenOfOwnerByIndex(address owner, uint256 index)` | Enumerate positions |
| `setAutoRenew(uint256 tokenId, bool enabled, uint256 maxFee)` | Holder only — opt into keeper-driven auto-renewal at expiry, with `maxFee` capping the fee chargeable against the position's equity. **Cleared on every transfer.** |
| `getAutoRenew(uint256 tokenId)` | `(enabled, maxFee)` — current auto-renew configuration |
| `applyRenewal(uint256 tokenId, ...)` | Pool only — records a renewal (deadline, fees, and any equity charge) |

```solidity
event AutoRenewSet(uint256 indexed tokenId, bool enabled, uint256 maxFee);
```

## EXNIHILORouter

The router allows users to approve USDC (and underlying tokens) once, then trade on any pool without per-pool approvals. LP operations and holder-only position operations (close, renew, claimPayout) are called directly on the pool.

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
