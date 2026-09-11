---
description: "Function reference for EXNIHILOPool, Factory, Router and the NFT contracts — access control, parameters and events for every external call."
---

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
| `renewPosition(uint256 nftId, uint256 maxFee)` | Position owner | Pay the dynamic renewal fee (quote via `quoteRenewFee`) to extend the deadline by one period; reverts if the fee exceeds `maxFee`. Extends from the existing deadline, so renewals stack — reverts `RenewalExceedsHorizon` if the result would land more than 60 days out, or `RenewalExceedsCloseDate` past a closing pool's `closeDate` |
| `closePositionAfterDeadline(uint256 nftId, uint256 minPayout)` | Anyone | Settle an expired position (profitable: payout credited to holder's claimable balance; underwater: collateral returns to LP). Reverts `AutoRenewActive` if an executable auto-renewal exists, `SettlementGuardActive` for non-holders within 5 blocks of a swap ≥ 1% of USDC depth |
| `settleExpired(uint256 nftId, uint256 minPayout)` | Anyone | Settle an expired position; auto-renews from position equity instead of closing when the holder opted in via `PositionNFT.setAutoRenew`. The caller is not paid. Same `SettlementGuardActive` window as above |
| `claimPayout(address to)` | Credited holder | Withdraw payouts credited by expired-position settlements |
| `addLiquidity(uint256 tokenAmount, uint256 usdcAmount)` | LP only | Add liquidity (must match reserve ratio) |
| `removeLiquidity()` | LP only | Withdraw all liquidity (requires zero open positions) |
| `claimFees(address to)` | LP only | Claim accrued LP fees (fees are pull payments) |
| `claimProtocolFees(address to)` | Treasury only | Claim accrued protocol fees |
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
| `currentMaxPositionBps()` | Current position cap in bps (100 at creation → 2000 after 24h) |
| `effectiveLeverageCap()` | That cap applied to live reserves, in USDC |
| `createdAt()` | Market creation timestamp — anchors the cap ramp |
| `swapFeeBps()` | Swap fee in bps — always 100 (1%), a constant |
| `openPositionCount()` | Number of open positions |
| `quoteOpenFee(uint256 notional, bool isLong)` | Total USDC fee to open a position now |
| `quoteRenewFee(uint256 nftId)` | Total USDC fee to renew a position now (dynamic: mark value + OI slice) |
| `quoteRenewDeadline(uint256 nftId)` | `(newDeadline, allowed)` — the deadline `renewPosition` would write right now, and whether it would be accepted. `allowed` is false once the position is extended to the 60-day horizon, or past `closeDate` on a closing pool. `newDeadline` is reported either way, so a caller can show how far the position must run down |
| `quoteClose(uint256 nftId)` | `(ready, pnl)` — close quote mirroring settlement math, priced for the **next** block: it applies the same 5-block clamp a close mined then would face, so it never reports more than the pool will pay. When `ready` is false the position cannot be settled at all and `pnl` carries the *estimated* shortfall (negative, display-only) |
| `settlementGuardedUntilBlock()` | First block at which a third party may settle an expired position; `0` = unguarded now, which includes any pool that is closing (the guard yields to a wind-down). Keepers should poll this instead of discovering the window through reverts |
| `settlementGuardBps()` | Displacement threshold that arms the settlement guard, in bps (100 = 1% move of either settlement price within one block) |
| `lastLargeSwapBlock()` | Block the guard was last armed in; `0` = never armed. Named for the swap-only rule it originally had — any reserve-moving call can arm it |
| `currentPositionDuration()` | Lifetime a position opened now would receive (1h → 8h → 24h → 7d → 30d by market age) |
| `closeDate()` / `isClosing()` | Wind-down state |
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
// Spot swaps (SWAP-1). Carries post-swap backed reserves so a consumer can
// derive price and depth without a follow-up read. Deliberately NOT shaped like
// a Uniswap V2 Swap: one input and one output per call, no token0/token1
// ordering, and reserves that describe only the backed side — leveraged opens
// and closes move the supply counters without emitting here.
// Note: when routed, `sender` is the router. Attribute users via `recipient`.
event Swap(
    address indexed sender,
    address indexed recipient,
    bool    tokenToUsdc,
    uint256 amountIn,
    uint256 amountOut,
    uint256 backedAirToken,
    uint256 backedAirUsd
);

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
| `createMarket(address tokenAddress, uint256 usdcAmount, uint256 tokenAmount)` | Deploy a new market (token decimals read on-chain). Position caps and position duration are both automatic and take no arguments. |
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
