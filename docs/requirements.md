## 1. Overview

EXNIHILO is a permissionless meme/USDC trading platform. Anyone can create a pool for any ERC-20 meme token. Pools support:

1. **Spot swaps** — constant-product AMM between meme and USDC
2. **Leveraged longs** — buy meme exposure without upfront collateral; pay only a 5% open fee
3. **Leveraged shorts** — sell synthetic meme exposure; collateral locked in USDC
4. **LP management** — single LP per pool (LP NFT holder), adds/removes liquidity, collects fees, and liquidates underwater positions

### 1.1 Contracts

| Contract | Role |
|---|---|
| `EXNIHILOFactory` | Deploys pools; owns global `PositionNFT` and `LpNFT` registries |
| `EXNIHILOPool` | Per-market AMM + leverage engine |
| `AirToken` | Synthetic ERC-20 wrapper; mint/burn restricted to its owning pool |
| `PositionNFT` | ERC-721 (ERC721Enumerable); one token per open position; custodies locked collateral |
| `LpNFT` | ERC-721; one token per pool; ownerOf = LP authority |

### 1.2 Token Decimal Conventions

| Token | Decimals | Notes |
|---|---|---|
| Meme / airMeme | 18 | airMeme always 18 dec regardless of underlying |
| USDC / airUsd | 6 | |
| LP NFT | — | ERC-721 |
| Position NFT | — | ERC-721 (ERC721Enumerable) |

`spotPrice()` formula assumes 18-decimal meme tokens.

---

## 2. Actors & Roles

| ID | Actor | Description |
|---|---|---|
| ACTOR-01 | Market Creator | Any wallet that calls the factory to deploy a new token market. Provides the initial token ratio (meme token + USDC). Becomes the initial LP owner. |
| ACTOR-02 | LP Owner | Holder of the LP NFT for a given pool. Earns trading fees, can add more liquidity (same wallet only) |
| ACTOR-03 | Trader (Long) | Opens a leveraged long position on a meme token by paying USDC. Receives a Long Position NFT. |
| ACTOR-04 | Trader (Short) | Opens a leveraged short position on a meme token by paying USDC fees. Receives a Short Position NFT. |
| ACTOR-05 | Protocol | Contract that collects protocol fees (2%) on every position open. |
| ACTOR-06 | NFT Holder | Any wallet holding a Position NFT (Long or Short) — position NFTs are transferable, so holder may differ from opener. |

---

## 3. Smart Contract Architecture

### 3.1 Wrapper Tokens (ERC-20)

Two wrapper token contracts are deployed for each market. They follow the ERC-20 standard and implement a permissioned mint/burn interface callable only by the pool contract.

| ID | Component | Requirement |
|---|---|---|
| WRP-01 | airToken (airMeme) | ERC-20 wrapper for the meme token. Name pattern: `air[TokenSymbol]`. Minted 1:1 against deposited meme tokens. Burns 1:1 on redemption. |
| WRP-02 | airTokenUsd (airUsd) | ERC-20 wrapper for USDC. Name pattern: `air[TokenSymbol]Usd`. Minted 1:1 against deposited USDC. Burns 1:1 on redemption. |
| WRP-03 | Mint parity | Both wrappers are minted exactly 1:1 with the underlying asset deposited. No fee or slippage is applied at the wrap/unwrap layer. |
| WRP-04 | Access control | Only the owning pool contract may call `mint()` and `burn()` on the wrapper tokens. |
| WRP-05 | Metadata | Wrapper tokens expose `name()`, `symbol()`, and `decimals()` matching the underlying asset (or 6 for the USDC-side). |

---

### 3.2 Factory Contract

The factory is the single entry point for market creation. It is permissionless: any wallet can call it with approved token balances.

| ID | Component | Requirement |
|---|---|---|
| FAC-01 | Permissionless deployment | Any wallet may call `createMarket(tokenAddress, usdcAmount, tokenAmount, maxPositionUsd, maxPositionBps)` to deploy a new market. |
| FAC-02 | Initial ratio | The caller sets the initial meme:USDC ratio by providing both amounts. The factory respects this ratio exactly; no normalisation is applied. |
| FAC-03 | Wrapper deployment | The factory deploys one airMeme wrapper and one airUsd wrapper, both owned exclusively by the new pool contract. |
| FAC-04 | Pool deployment | The factory deploys the custom AMM pool contract, wires it to both wrappers, and seeds it with the caller's deposited tokens. |
| FAC-05 | LP NFT mint | The factory mints a single LP NFT to the caller's address, encoding the pool address and initial liquidity amounts. |
| FAC-06 | One LP per pool | Each pool supports exactly one LP NFT. Only the holder of that NFT may add liquidity to the pool (see LP-03). |
| FAC-07 | Event emission | The factory emits a `MarketCreated(poolAddress, tokenAddress, lpNftId)` event on success. |
| FAC-08 | Max position — absolute USD cap | The market creator sets `maxPositionUsd`: the maximum USDC notional allowed for any single position open in this pool. Value is in USDC with 6 decimals. Set to `0` to disable this cap. Mutable post-deployment (see CAPS-01). |
| FAC-09 | Max position — liquidity % cap | The market creator sets `maxPositionBps`: the maximum position size expressed as a percentage of the pool's current backed airUsd reserves at the moment of position open. Expressed in basis points; valid range **10–9900** (0.1 %–99 %). Set to `0` to disable this cap. Mutable post-deployment (see CAPS-01). |

---

### 3.3 Custom AMM (DEX)

The pool implements a constant-product AMM (`x·y = k`) with three distinct swap modes. Each mode uses different reserve values, enabling synthetic leverage without external collateral.

#### Constant-Product Formula

All three modes use the same formula with a **spot-price fee**:

```
rawOut  = amountIn × reserveOut / (reserveIn + amountIn)
fee     = amountIn × reserveOut × swapFeeBps / (reserveIn × 10_000)
netOut  = rawOut − fee                          (0 if rawOut ≤ fee)
```

The fee is a true percentage of the **spot value** of the input, not the price-impact-adjusted output. For a 1% fee the maximum trade size before `netOut = 0` is 99× the reserve.

#### Swap Mode Definitions

| Mode | Name | Reserve Formula | Used For |
|---|---|---|---|
| SWAP-1 | Normal Swap | x = actual **backed** reserves of airMeme; y = actual **backed** reserves of airUsd | Regular USDC ↔ Meme trades. Internally wraps/unwraps tokens for the caller. |
| SWAP-2 | Long-open / Short-close Swap | x = actual **backed** reserves of airMeme; y = **total supply** of airUsd (backed + synthetic) | Opening a LONG (airUsd → airMeme) and closing a SHORT (airUsd → airMeme). |
| SWAP-3 | Short-open / Long-close Swap | x = **total supply** of airMeme (backed + synthetic); y = actual **backed** reserves of airUsd | Opening a SHORT (airMeme → airUsd) and closing a LONG (airMeme → airUsd). |

#### Spot Price

```
spotPrice() = backedAirUsd × 1e18 / backedAirMeme
```

Returns raw USDC units (6 dec) per whole meme token (18 dec). Divide by 1e6 for a USD price. Only valid for 18-decimal meme tokens.

#### AMM Math Reference

**`_cpAmountOut(amountIn, reserveIn, reserveOut)`** — exact formula above; max trade before `netOut = 0` is `reserveIn × (10_000 − swapFeeBps) / swapFeeBps` (= 99× for 1% fee).

**`_cpAmountIn(amountOut, reserveIn, reserveOut)`** — conservative approximation of the input needed to receive at least `amountOut`:

```
rawOut   = amountOut × 10_000 / (10_000 − swapFeeBps)
amountIn = rawOut × reserveIn / (reserveOut − rawOut)
```

Error bound: ≈ `feeBps² / 10_000` (~0.004% at 2%). Callers receive at least `amountOut`. Returns `type(uint256).max` if the trade would drain the reserve.

#### DEX Requirements

| ID | Component | Requirement |
|---|---|---|
| DEX-01 | Invariant | All swaps enforce `x·y = k` using the specified reserves for that mode. `k` is recalculated after each swap. |
| DEX-02 | Reserve tracking | The pool tracks separately: (a) actual backed reserves (deposits backing minted wrappers) and (b) total wrapper supply including synthetic mints. Backed reserves can never exceed total supply. |
| DEX-03 | Auto wrap/unwrap | SWAP-1 accepts raw ERC-20 tokens (USDC or meme token), wraps them internally before the swap, and unwraps the output before returning to the caller. |
| DEX-04 | Slippage protection | All swap functions accept a `minAmountOut` parameter; the transaction reverts if output < `minAmountOut`. |
| DEX-05 | Swap fee on all modes | The swap fee (`swapFeeBps`, default **100 bps = 1%**, immutable per pool) is applied by `_cpAmountOut` in all three AMM modes. Position fees (5% notional) are collected separately before the AMM is called and do not stack with the swap fee. |
| DEX-06 | Leverage cap enforcement | Before minting synthetic tokens to open any long or short position, the pool computes the effective cap: `min(maxPositionUsd if non-zero, (backedAirUsdReserves × maxPositionBps / 10000) if non-zero)`. If any cap is active and `positionNotionalUsd > effectiveCap`, the transaction reverts with `"Exceeds leverage cap"`. If both caps are zero the check is skipped. |

---

### 3.4 Position NFT Contract

A single NFT contract manages both Long and Short position tokens. Each token is transferable and stores all data needed to settle the position without additional on-chain lookups.

| ID | Component | Requirement |
|---|---|---|
| NFT-01 | ERC-721 | Position NFTs conform fully to ERC-721, including `safeTransferFrom`, `transferFrom`, `approve`, and `setApprovalForAll`. |
| NFT-02 | Transferability | Long and Short Position NFTs are fully transferable. The current holder is the only party authorised to close the position. |
| NFT-03 | Long NFT data | Stores: pool address, USDC amount used to open (`usdcIn`), airUsd minted amount (`airUsdMinted`), airMeme amount locked (`airMemeLocked`), fees paid (USDC), block timestamp of open. |
| NFT-04 | Short NFT data | Stores: pool address, airMeme minted amount at open rate (`airMemeMinted`), airUsd amount locked (`airUsdLocked`), fees paid (USDC), block timestamp of open. |
| NFT-05 | Token custody | The NFT contract holds custody of the locked wrapper tokens (airMeme for longs, airUsd for shorts) for the duration of the position. |
| NFT-06 | LP forced realization flag | The NFT records whether it was force-closed by the LP owner, for event logging purposes. |

---

## 4. Core User Flows

### 4.1 Normal Swap (USDC ↔ Meme Token)

| ID | Step | Requirement |
|---|---|---|
| NS-01 | Entry | Caller approves USDC (or meme token) to the pool contract and calls `swap(amountIn, minAmountOut, direction)`. |
| NS-02 | Wrap | Pool wraps the input token into its respective wrapper (airUsd or airMeme) using SWAP-1 backed reserves. |
| NS-03 | AMM calculation | Output is calculated via `x·y = k` using SWAP-1 (both backed reserves). |
| NS-04 | Unwrap & deliver | Pool burns the output wrapper and transfers the raw token to the caller. |
| NS-05 | No position minted | A normal swap does not create a Position NFT. |

---

### 4.2 Open Long Position

*The user believes the meme token price will rise relative to USDC.*

| ID | Step | Requirement                                                                                                                                                                                                |
|---|---|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| OL-01 | Input | Caller specifies `usdcAmount` (e.g. 10 USDC) and pays fees upfront in USDC (e.g. 50 cents) before any mint (see FEE-01).                                                                                   |
| OL-02 | Fee deduction | 5% of `usdcAmount` is taken: 3% to LP, 2% to protocol. Only the fees are transferred out from the user to the protocol immediately.                                                                        |
| OL-03 | airUsd mint | The pool mints airUsd equal to the 100% `usdcAmount` (pre-fee, eg. 10$) — the mint represents the user's collateral commitment.                                                                            |
| OL-04 | SWAP-2 execution | The 10 airUsd are swapped via **SWAP-2** (x = backed airMeme, y = total airUsd supply) to receive airMeme.                                                                                                 |
| OL-05 | NFT lock | The received airMeme tokens are transferred to the Position NFT contract. A Long NFT is minted to the caller with fields: `usdcIn=10`, `airUsdMinted=10`, `airMemeLocked=<SWAP-2 output>`, `feesPaid=0.5`. |
| OL-06 | State update | Total airUsd supply increases by 10. Backed airUsd reserves remain unchanged (no new USDC was deposited).                                                                                                  |

---

### 4.3 Close Long Position

| ID | Step | Requirement |
|---|---|---|
| CL-01 | Authorisation | Only the current ERC-721 holder of the Long NFT may call `closeLong(nftId)`. |
| CL-02 | SWAP-3 execution | The locked airMeme (from NFT data) is swapped via **SWAP-3** (x = total airMeme supply, y = backed airUsd) to produce airUsd. |
| CL-03 | Profitability check | If returned airUsd < `airUsdMinted` (stored in NFT), the transaction **REVERTS** with `"Position underwater"`. The position remains open. |
| CL-04 | airUsd burn | The exact `airUsdMinted` amount of airUsd is burned (synthetic debt repaid). |
| CL-05 | Profit delivery | The surplus airUsd (`returned − airUsdMinted`) is unwrapped 1:1 to USDC. A **1% close fee on the surplus** is sent to `protocolTreasury`; the remaining 99% is transferred to the NFT holder. |
| CL-06 | NFT burn | The Long Position NFT is burned on successful close. |
| CL-07 | airMeme not burned | The airMeme wrappers are **not burned** at profitable close. The underlying meme stays in the pool; burning wrappers without withdrawing underlying would permanently orphan those meme tokens. |

---

### 4.4 Open Short Position

*The user believes the meme token price will fall relative to USDC.*

| ID | Step | Requirement |
|---|---|---|
| OS-01 | Input | Caller specifies the notional USDC value of the short and pays fees upfront in USDC (see FEE-01). |
| OS-02 | Fee deduction | 5% fee taken: 3% LP, 2% protocol. Paid in USDC upfront before any mint. |
| OS-03 | airMeme mint | The pool calculates the current meme/USDC rate using SWAP-1 backed reserves and mints the equivalent airMeme for the specified USDC notional (e.g. 10 USDC notional → mint N airMeme at current rate). |
| OS-04 | SWAP-3 execution | The minted airMeme is swapped via **SWAP-3** (x = total airMeme supply, y = backed airUsd) to produce airUsd. |
| OS-05 | NFT lock | The airUsd received is locked in the Position NFT contract. A Short NFT is minted to the caller with fields: `airMemeMinted=N`, `airUsdLocked=<SWAP-3 output>`, `feesPaid=<fees>`. |
| OS-06 | State update | Total airMeme supply increases by N. Backed airMeme reserves remain unchanged. |

---

### 4.5 Close Short Position

| ID | Step | Requirement                                                                                                                                                                                      |
|---|---|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| CS-01 | Authorisation | Only the current ERC-721 holder of the Short NFT may call `closeShort(nftId)`.                                                                                                                   |
| CS-02 | SWAP-2 execution | The locked airUsd (from NFT data) is swapped via **SWAP-2** (x = backed airMeme, y = total airUsd supply) to produce airMeme, but only the required amount of airMeme, the surplus is kept as usd. |
| CS-03 | Profitability check | If returned airMeme < `airMemeMinted` (stored in NFT), the transaction **REVERTS** with `"Position underwater"`.                                                                                 |
| CS-04 | airMeme burn | The exact `airMemeMinted` amount of airMeme is burned (synthetic debt repaid).                                                                                                                   |
| CS-05 | Profit delivery | The surplus airUsd is unwrapped 1:1 to USDC. A **1% close fee on the surplus** is sent to `protocolTreasury`; the remaining 99% is transferred to the NFT holder.                               |
| CS-06 | NFT burn | The Short Position NFT is burned on successful close.                                                                                                                                            |

---

### 4.6 Realize Long Position

*The holder takes physical delivery of the locked meme tokens by repaying the synthetic USD debt. No AMM is involved; the exchange rate is the one locked in at open.*

| ID | Step | Requirement |
|---|---|---|
| RL-01 | Authorisation | Only the current ERC-721 holder of the Long NFT may call `realizeLong(nftId)`. |
| RL-02 | Input | Caller approves and pays exactly `airUsdMinted` USDC (stored in the NFT) to the pool. |
| RL-03 | Debt repayment | The pool accepts the USDC payment and burns `airUsdMinted` of synthetic airUsd, clearing the position's debt. Backed airUsd reserves increase by `airUsdMinted` (the incoming USDC now backs the supply). |
| RL-04 | Meme delivery | The `airMemeLocked` airMeme held by the NFT contract is released, unwrapped 1:1 to the underlying meme token, and transferred to the NFT holder. |
| RL-05 | NFT burn | The Long Position NFT is burned on successful realization. |
| RL-06 | No AMM, no slippage | Realization does not pass through any swap formula. No `minAmountOut` parameter is required. No close fee applies. |

---

### 4.7 Realize Short Position

*The holder takes physical delivery of the locked USDC by repaying the synthetic meme debt. No AMM is involved; the exchange rate is the one locked in at open.*

| ID | Step | Requirement |
|---|---|---|
| RS-01 | Authorisation | Only the current ERC-721 holder of the Short NFT may call `realizeShort(nftId)`. |
| RS-02 | Input | Caller approves and pays exactly `airMemeMinted` meme tokens (stored in the NFT) to the pool. |
| RS-03 | Debt repayment | The pool accepts the meme tokens and burns `airMemeMinted` of synthetic airMeme, clearing the position's debt. Backed airMeme reserves increase by `airMemeMinted` (the incoming meme tokens now back the supply). |
| RS-04 | USDC delivery | The `airUsdLocked` airUsd held by the NFT contract is released, unwrapped 1:1 to USDC, and transferred to the NFT holder. |
| RS-05 | NFT burn | The Short Position NFT is burned on successful realization. |
| RS-06 | No AMM, no slippage | Realization does not pass through any swap formula. No `minAmountOut` parameter is required. No close fee applies. |

---

## 5. Fee Structure

| ID | Component | Requirement                                                                                                            |
|---|---|------------------------------------------------------------------------------------------------------------------------|
| FEE-01 | Upfront payment | All position-open fees are paid in USDC at the time of position open, **before** any minting or swapping occurs. Fees do not enter the AMM. |
| FEE-02 | LP fee | 3% of the position notional (in USDC) is transferred directly to the LP fee accumulator (claimable by LP NFT holder via `claimFees()`). |
| FEE-03 | Protocol fee | 2% of the position notional (in USDC) is transferred immediately to the protocol treasury address. |
| FEE-04 | Total open fee | **5% total** on every position open. Minimum total fee: **$0.05 USDC** (split: $0.03 LP + $0.02 protocol). Applies when notional < $1.00. |
| FEE-05 | Swap fee (all modes) | All three AMM modes (SWAP-1, SWAP-2, SWAP-3) apply a swap fee per pool (default **100 bps = 1%**, set at pool creation, immutable). Retained in pool as passive LP yield. Separate from the 5% position open fee. |
| FEE-06 | Fee claim | LP owner calls `claimFees()` to sweep accumulated LP fees to their wallet at any time. |
| FEE-07 | Close fee | On profitable `closeLong` or `closeShort`: **1% of the profit surplus** is sent to `protocolTreasury` before the holder receives funds. Formula: `closeFee = surplus × 1%`; holder receives `surplus × 99%`. No close fee on `realizeLong` or `realizeShort`. |

---

## 6. Liquidity Provision

| ID    | Component               | Requirement                                                                                                                                                                                                                                                       |
|-------|-------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| LP-01 | LP NFT                  | Each pool has exactly one LP NFT, minted at pool creation to the market creator. It is a standard ERC-721 and is fully transferable.                                                                                                                              |
| LP-02 | Sole liquidity provider | The pool enforces that only the current LP NFT holder may add liquidity. Any call to `addLiquidity()` from a non-holder reverts.                                                                                                                                  |
| LP-03 | Same-wallet restriction | `addLiquidity()` requires `msg.sender == ownerOf(lpNftId)`. Approved operators are **not** permitted to add liquidity; must be a direct holder call.                                                                                                              |
| LP-04 | Proportional deposit    | When adding liquidity, the caller must deposit both assets in the current pool ratio (total supply, including the unbacked tokens). The pool calculates required amounts; caller must approve both tokens. The pool updates both backed reserve values afterwards. |
| LP-05 | Withdrawal restriction  | Liquidity can only be withdrawn when there are **zero open positions** (`openPositionCount == 0`) in the pool. |
| LP-06 | Full withdrawal only    | Liquidity withdrawal is all-or-nothing in v1. The LP withdraws 100% and receives the underlying backed reserves of both assets.                                                                                                                                   |
| LP-07 | LP NFT transfer         | Transfer of the LP NFT transfers all rights: fee claims, liquidity add/withdraw, and LP forced realization authority.                                                                                                                                                    |

---

## 7. LP Forced Realization of Stuck Positions

Because LP withdrawal requires zero open positions, the LP owner must be able to force-close positions that are underwater (where the normal close would revert). This prevents LP funds from being locked indefinitely.

| ID | Component | Requirement                                                                                                                                                           |
|---|---|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| LIQ-01 | Eligibility | The LP NFT holder may call `forceRealize(nftId)` on any open Long or Short NFT in their pool that is underwater. |
| LIQ-02 | Collateral requirement | To force-close a **Long NFT**, the LP must pay `airUsdMinted` USDC. To force-close a **Short NFT**, the LP must pay `airMemeMinted` raw meme tokens.    |
| LIQ-03 | Settlement | On forced realization, the locked wrapper tokens are released, the synthetic debt is converted to backed (real) debt, and the position owner recovers locked collateral at a loss. |
| LIQ-04 | Position holder protection | Forced realization is only permitted when `closeLong` / `closeShort` would revert (position genuinely underwater). The LP cannot force-close a profitable position. |
| LIQ-05 | Event | A `PositionForceRealized(nftId, lpOwner, collateralPaid)` event is emitted.                                                                                              |

---

## 8. Position Cap Administration

Both position caps (`maxPositionUsd` and `maxPositionBps`) are mutable storage variables. This allows the LP owner to adjust risk parameters over time.

| ID | Component | Requirement |
|---|---|---|
| CAPS-01 | LP owner — free update | The current LP NFT holder may call `setPositionCaps(newUsd, newBps)` at any time to freely set either cap to any valid value (including 0 to disable). `newBps` must satisfy 10–9900 when non-zero. |
| CAPS-02 | Events | Every cap update emits `PositionCapsUpdated(newMaxPositionUsd, newMaxPositionBps, by)`. |

---

## 9. Security & Risk Requirements

| ID | Component | Requirement |
|---|---|---|
| SEC-01 | Reentrancy | All state-changing functions use OpenZeppelin `ReentrancyGuard` + checks-effects-interactions pattern. |
| SEC-02 | Integer overflow | All arithmetic uses Solidity 0.8.x built-in overflow checks. |
| SEC-03 | Access control | Wrapper mint/burn callable only by pool. Pool `addLiquidity` callable only by LP NFT holder. `closeLong`/`closeShort`/`realizeLong`/`realizeShort` callable only by the respective position NFT holder. |
| SEC-04 | Reserve integrity | `backedAirMeme ≤ airMeme.totalSupply()` and `backedAirUsd ≤ airUsd.totalSupply()` after every operation. Violation reverts with `ReserveInvariantViolated()`. |
| SEC-05 | Sandwich attack mitigation | All swaps and position opens/closes accept a `minAmountOut` parameter set by the caller. No automatic slippage tolerance. |
| SEC-06 | Position cap management | The LP NFT holder may call `setPositionCaps()` to adjust position size limits at any time. |
| SEC-07 | Protocol fee receiver | `protocolTreasury` is immutable — set once at pool creation, cannot be changed post-deployment. |
| SEC-08 | Fee-on-transfer guard | `_transferIn()` verifies `balanceAfter − balanceBefore == amount` for every token pull; reverts `FeeOnTransferNotSupported()` if they differ. |

---

## 10. Events & Observability

| ID | Event | Signature |
|---|---|---|
| EVT-01 | MarketCreated | `factory: (poolAddress, tokenAddress, usdcAmount, tokenAmount, lpNftId, creator, maxPositionUsd, maxPositionBps)` |
| EVT-02 | LiquidityAdded | `pool: (provider, tokenAmount, usdcAmount, newReserves)` |
| EVT-03 | LiquidityRemoved | `pool: (provider, tokenAmount, usdcAmount)` |
| EVT-04 | Swap | `pool: (caller, mode, tokenIn, amountIn, tokenOut, amountOut)` |
| EVT-05 | LongOpened | `pool: (nftId, holder, usdcIn, airUsdMinted, airMemeLocked, feesPaid)` |
| EVT-06 | LongClosed | `pool: (nftId, holder, profit, airUsdBurned)` |
| EVT-07 | ShortOpened | `pool: (nftId, holder, airMemeMinted, airUsdLocked, feesPaid)` |
| EVT-08 | ShortClosed | `pool: (nftId, holder, profit, airMemeBurned)` |
| EVT-09 | PositionForceRealized | `pool: (nftId, lpOwner, collateralPaid)` |
| EVT-10 | FeesClaimed | `pool: (lpOwner, amount)` |
| EVT-11 | LongRealized | `pool: (nftId, holder, usdcPaid, airUsdBurned, memeDelivered)` |
| EVT-12 | ShortRealized | `pool: (nftId, holder, memePaid, airMemeBurned, usdcDelivered)` |
| EVT-13 | PositionCapsUpdated | `pool: (newMaxPositionUsd, newMaxPositionBps, by)` — emitted by `setPositionCaps` |

---

## 11. Frontend / UX Requirements

| ID | Component | Requirement                                                                                                                                                                                                                                                          |
|---|---|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| UX-01 | Market browser | List all deployed pools with token name, current price (SWAP-1 implied), total backed reserves, number of open positions and a star rating 1 to 5 based on liquidity and TVL. |
| UX-02 | Pool creation UI | Form to set token address, USDC amount, and meme token amount. Preview the calculated initial price ratio before confirming.                                                                                                                                         |
| UX-03 | Trade panel | Users select Long or Short, enter notional USDC amount, and preview: fee to pay, airUsd/airMeme to be minted, estimated output from the relevant swap, and net exposure.                                                                                             |
| UX-04 | Position dashboard | Displays all open Long and Short NFTs held by the connected wallet. Shows current P&L (mark-to-market using current swap output vs. minted amount). Colour-coded profit/loss. Each position shows two actions: **Close** (AMM-based, profit in USDC) and **Realize** (direct delivery — meme for longs, USDC for shorts — by paying the original synthetic debt). |
| UX-05 | LP dashboard | Shows LP NFT ID, current pool reserves, accumulated unclaimed fees, open position count, and addLiquidity / claimFees / withdraw buttons. Exposes position cap management (`maxPositionUsd` / `maxPositionBps`). |
| UX-06 | Wallet connect | Supports injected wallets (MetaMask, Rabby) via EIP-6963, WalletConnect v2, and Coinbase Wallet. Switch to Avalanche C-chain. |
| UX-07 | Transaction feedback | Pending, confirmed, and failed states shown inline. |
| UX-08 | NFT transferability | Position and LP NFTs appear in the user's connected wallet NFT gallery and can be transferred from the position dashboard. |

*See `docs/requirements-ui.md` for detailed UI/UX specifications.*

---

## 12. Storage Layout (EXNIHILOPool)

| Slot | Variable |
|---|---|
| 0 | `_status` (ReentrancyGuard) |
| 1 | `maxPositionUsd` |
| 2 | `maxPositionBps` |
| 3 | `backedAirMeme` |
| 4 | `backedAirUsd` |
| 5 | `lpFeesAccumulated` |
| 6 | `openPositionCount` |
| 7 | `longOpenInterest` |
| 8 | `shortOpenInterest` |

Immutables (`airMemeToken`, `airUsdToken`, `underlyingMeme`, `underlyingUsdc`, `positionNFT`, `lpNftContract`, `lpNftId`, `protocolTreasury`, `swapFeeBps`) are inlined into bytecode at deployment.

---

## 13. Open Questions & Decisions Needed

The following items are flagged as incomplete or requiring further design decisions before implementation:

---

## 14. Glossary

| Term | Type | Definition |
|---|---|---|
| airMeme | Wrapper token | ERC-20 wrapper for the meme (non-USDC) asset in a pool. Named `air[TokenSymbol]`. |
| airUsd | Wrapper token | ERC-20 wrapper for USDC in a pool. Named `air[TokenSymbol]Usd`. |
| Backed reserves | AMM term | The quantity of wrapper tokens that are 1:1 backed by real deposited underlying assets. Excludes synthetically minted tokens. |
| Total supply | AMM term | The full wrapper token supply including both backed and synthetically minted tokens for open positions. |
| SWAP-1 | DEX mode | Normal trade mode. Uses backed reserves for both sides of the AMM. |
| SWAP-2 | DEX mode | Long-open / short-close mode. Uses backed airMeme as x, total airUsd supply as y. |
| SWAP-3 | DEX mode | Short-open / long-close mode. Uses total airMeme supply as x, backed airUsd as y. |
| LP NFT | Token | ERC-721 token representing sole ownership of pool liquidity. One per pool. |
| Position NFT | Token | ERC-721 token representing an open long or short position. Transferable. |
| k | Math | The AMM invariant: product of reserves x and y. Recalculated after each swap. |
| maxPositionUsd | Config | Hard per-position cap in raw USDC (6 dec). 0 = disabled (unlimited). Mutable. |
| maxPositionBps | Config | Per-position cap as a % of backedAirUsd, in basis points (10–9900). 0 = disabled (unlimited). Mutable. |

---

*— End of Document —*
