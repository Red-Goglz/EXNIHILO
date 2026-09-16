---
description: "Function reference for EXNIHILOPool, the factory, router, NFTs and launchpad contracts — access control, parameters and events."
---

# Contract Reference

## EXNIHILOPool

### Trading and positions

| Function | Access | Description |
|---|---|---|
| `swap(amountIn, minAmountOut, tokenToUsdc, recipient)` | Anyone | Spot swap on SWAP-1 |
| `openLong(usdcAmount, minAirTokenOut, recipient)` | Anyone | Open a long; pulls the fee, mints the NFT to `recipient` |
| `openShort(usdcNotional, minAirUsdOut, recipient)` | Anyone | Open a short |
| `closeLong(nftId, minUsdcOut, to)` / `closeShort(nftId, minUsdcOut, to)` | Holder | Close in profit; payout to `to` |
| `sweepDust(nftId)` | Anyone | Clear a position below 0.1% of its opening collateral; otherwise reverts `PositionNotDust`. A residual is credited if the sweep prices it in profit |
| `claimPayout(to)` | Credited holder | Withdraw a payout credited by a sweep |
| `pokeFunding()` | Anyone | Write accrued funding without trading |

### Liquidity and fees

| Function | Access | Description |
|---|---|---|
| `addLiquidity(tokenAmount, usdcAmount)` | LP | Add at the current reserve ratio |
| `removeLiquidity()` | LP | Withdraw everything; requires no open positions |
| `claimFees(to)` | LP | Claim LP fees |
| `claimProtocolFees(to)` | Treasury | Claim protocol fees |
| `closePool()` | LP | Irreversible. Blocks opens now; after `closeDate` (now + 7 days) funding doubles daily |

### Views

| Function | Returns |
|---|---|
| `spotPrice()` / `longPrice()` / `shortPrice()` | USDC per whole token (6 dec): spot, marginal long entry, marginal short entry |
| `backedAirToken()` / `backedAirUsd()` / `airTokenSupply()` / `airUsdSupply()` | The four reserve counters |
| `longOpenInterest()` / `shortOpenInterest()` | Live notional per side, as last written; a long's notional is its debt |
| `totalLongCollateral()` / `totalShortCollateral()` / `totalShortDebt()` | Aggregates behind the reserve identities |
| `openPositionCount()` | Number of open positions |
| `quoteOpenFee(notional, isLong)` | The exact open fee now |
| `quoteClose(nftId)` | `(ready, pnl)` for a close in the next block, clamp included; `pnl` is net of the close fee, negative when underwater (an estimate when `ready` is false) |
| `quoteCloseUnclamped(nftId)` | The same at live reserves, without the clamp. Not what a close pays: in profit here but not in `quoteClose` means a recent price move is holding the close back — retry within a few blocks |
| `liveAmountsOf(nftId)` | `(locked, debt, notional)` now, net of funding |
| `effectiveLockedOf(nftId)` / `remainingSizeBps(nftId)` | Live collateral; what is left of the opening size, in bps |
| `fundingRatePerSecond(isLong)` | Current rate in RAY per second, including any wind-down multiplier |
| `fundingWindow()` / `windDownShift()` | Current window in seconds; times the wind-down has doubled the rate |
| `fundingIndexLong()` / `fundingIndexShort()` | Indices as last written — the live views project; these do not |
| `currentMaxPositionBps()` / `effectiveLeverageCap()` | Position cap in bps and in USDC |
| `lpFeesAccumulated()` / `protocolFeesAccumulated()` | Unclaimed fees |
| `lpFeesPaidTotal()` / `protocolFeesPaidTotal()` | Claimed fees; `accumulated + paidTotal` only grows |
| `claimable(address)` / `totalClaimable()` | Credited payouts |
| `closeDate()` / `isClosing()` | Wind-down state |
| `createdAt()` / `tokenDecimals()` / `swapFeeBps()` | Market creation time, token decimals, the 1% fee |
| `indexerState()` | Reserves, prices, lifetime fees, and projected funding indices and rates, in one call |

### Events

```solidity
event Swap(address indexed sender, address indexed recipient, bool tokenToUsdc,
           uint256 amountIn, uint256 amountOut, uint256 backedAirToken, uint256 backedAirUsd);
event PositionOpened(uint256 indexed nftId, address indexed holder, bool isLong);
event PositionClosed(uint256 indexed nftId, address indexed holder, uint256 payout);
event PositionSwept(uint256 indexed nftId, address indexed caller, uint256 payout);
event FundingAccrued(bool indexed isLong, uint256 released, uint256 debtCancelled,
                     uint256 newIndex, uint256 elapsed);
event PayoutCredited(address indexed recipient, uint256 amount);
event PayoutClaimed(address indexed recipient, address indexed to, uint256 amount);
event PoolClosed(address indexed closedBy, uint256 closeDate);
event LpFeesPaid(address indexed to, uint256 amount);
event ProtocolFeesPaid(address indexed to, uint256 amount);
```

`Swap` covers SWAP-1 only; opens and closes move the supply counters without it, and when routed
`sender` is the router. In `FundingAccrued`, `released` is collateral (airToken for longs, USDC for
shorts) and `debtCancelled` the debt burned with it (airUsd for longs, airToken for shorts) —
different units, never summed.

## EXNIHILOFactory

| Function | Description |
|---|---|
| `createMarket(tokenAddress, usdcAmount, tokenAmount)` | Deploy and seed a market; returns `(pool, lpNftId)` |
| `allPools(i)` / `allPoolsLength()` / `isPool(address)` | Enumerate and check markets |
| `usdc()` / `protocolTreasury()` / `positionNFT()` / `lpNftContract()` / `poolDeployer()` | Immutables |

The factory has no owner and no admin function. Earlier deployments exposed `deployer()` /
`setDeployer(address)`, an emergency role that could call `closePool` on any pool; it was removed.

## EXNIHILORouter

Approve USDC (or the swap input) to the router once, then trade any pool. Closes, liquidity and
`claimPayout` go directly to the pool.

| Function | Description |
|---|---|
| `openLong(pool, usdcAmount, minAirTokenOut)` | Pulls the quoted fee, opens, refunds anything unused; NFT to the caller |
| `openShort(pool, usdcNotional, minAirUsdOut)` | The same for shorts |
| `swap(pool, amountIn, minAmountOut, tokenToUsdc)` | Output to the caller |

## PositionNFT and LpNFT

| Function | Description |
|---|---|
| `PositionNFT.getPosition(tokenId)` | The position record — amounts as at open; use the pool's `liveAmountsOf` for live figures |
| `PositionNFT.tokenURI(tokenId)` | On-chain SVG and attributes |
| `PositionNFT.tokenOfOwnerByIndex(owner, i)` | Enumerate a wallet's positions |
| `LpNFT.poolOf(tokenId)` / `LpNFT.ownerOf(tokenId)` | The pool an LP NFT controls, and its LP |

## Launchpad

| Function | Description |
|---|---|
| `PreMarketFactory.createPreMarket(params)` | Seed a pre-market; with USDC as the quote it launches the real market directly |
| `PreMarketFactory.allPreMarkets(i)` / `allPreMarketsLength()` / `isPreMarket(address)` | Enumerate |
| `PreMarket.swap(amountIn, minAmountOut, tokenToQuote, to)` | Trade the token/quote AMM |
| `PreMarket.currentPrice()` / `PreMarket.buyoutCost()` | The auction price; `(usdcCost, quoteOut)` for a buyout now |
| `PreMarket.buyout(maxUsdc, minQuoteOut)` | Buy the quote reserve for USDC and launch the market |
| `LockedLpVault.pending()` | `(lpPending, integratorPending)`, including fees not yet harvested |
| `LockedLpVault.claimLpFees(to)` / `claimIntegratorFees(to)` | Harvest and claim one side's share |
| `LockedLpVault.harvest()` | Pull the pool's LP fees into the vault; permissionless |
| `LockedLpVault.setLp(address)` / `setIntegrator(address)` | Rotate a role; its accrued balance moves with it |

The [SDK](/developers/sdk) wraps all of these with pre-flight checks.
