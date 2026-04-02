# Nemesis Audit -- Pass 3 (Final Convergence)

**Protocol:** EXNIHILO
**Contracts:** EXNIHILOPool.sol, EXNIHILOFactory.sol, EXNIHILORouter.sol, PositionNFT.sol, LpNFT.sol, AirToken.sol
**Auditor:** Nemesis (combined Feynman + State Inconsistency + Fusion)
**Date:** 2026-04-02
**Status:** CONVERGENCE CONFIRMED -- No new findings
**Test Suite:** 442/442 passing

---

## Executive Summary

This is the third and final Nemesis audit pass. Passes 1 and 2 identified a total of
~20 findings across severity levels (M, L, N, I), all of which have been fixed. This pass
performed a complete line-by-line review of every production contract to verify:

1. No regression bugs were introduced by any fix
2. No multi-transaction attack sequences exploit the interaction between fixes
3. No new vulnerabilities were missed by the prior two passes
4. All state counters remain perfectly synchronized

**Result: The protocol has converged. Zero new findings.**

---

## Verification of Prior Fixes

### Fix N-1: closeShort subtracts lockedAmount from airUsd totalSupply

**All four locations verified correct:**

| Location | Code | Status |
|---|---|---|
| `closeShort` (line 854) | `airUsdSupply - pos.lockedAmount` | CORRECT |
| `_liquidateExpiredShort` profitable (line 1413) | `airUsdToken.totalSupply() - pos.lockedAmount` | CORRECT |
| `_shortIsUnderwater` (line 1467) | `airUsdSupply - pos.lockedAmount` | CORRECT |
| `PositionNFT._readLive` short branch (line 323) | `airUsdSup > pos.lockedAmount ? airUsdSup - pos.lockedAmount : 0` | CORRECT |

**Regression check:** The subtraction cannot underflow because:
- `closeShort` and `_liquidateExpiredShort` are only reachable when the position exists (NFT check), and the locked airUsd was minted from the pool's backed supply, so totalSupply always >= lockedAmount.
- `_shortIsUnderwater` adds an explicit `if (airUsdSupply < pos.lockedAmount) return true` guard (line 1464).
- `PositionNFT._readLive` uses a ternary guard against underflow (line 323).

No regression introduced.

### Fix N2-I1: longPositionCount + shortPositionCount

**All 10 mutation paths verified synchronized:**

| Path | openPositionCount | longPositionCount | shortPositionCount |
|---|---|---|---|
| `openLong` (541-542) | ++ | ++ | -- |
| `openShort` (777-778) | ++ | -- | ++ |
| `closeLong` (631-632) | -- | -- | -- |
| `closeShort` (866-867) | -- | -- | -- |
| `realizeLong` (683-684) | -- | -- | -- |
| `realizeShort` (909-910) | -- | -- | -- |
| `_forceRealizeLong` (1298-1299) | -- | -- | -- |
| `_forceRealizeShort` (1331-1332) | -- | -- | -- |
| `_liquidateExpiredLong` (1361-1362) | -- | -- | -- |
| `_liquidateExpiredShort` (1404-1405) | -- | -- | -- |

**Invariant:** `openPositionCount == longPositionCount + shortPositionCount` holds across ALL paths. No path modifies one counter without its counterpart. No regression.

### Fix N2-I2: quotePositionFee view function

Verified line-by-line against the actual fee calculation in `openLong` and `openShort`:
- Base fee formula: identical (separate protocolFee + lpFee divisions, MIN_POSITION_FEE floor)
- Impact fee formula: identical constants, identical OI reads, identical formula
- Only difference: view function returns 0 impact when `backedAirUsd == 0` (graceful) vs. actual functions revert with `InsufficientBackedReserves` (correct for state-changing calls)

No accuracy issue.

### Fix N2-I3: setPositionCaps no-op

Line 367: `if (maxPositionUsd == newUsd && maxPositionBps == newBps) return;`

Correctly avoids emitting a redundant event and saves gas when values are unchanged. No side effects.

### Fix N2-L3: LongClosed event reports pos.airUsdMinted + surplus

Line 653: `emit LongClosed(nftId, holder, netSurplus, pos.airUsdMinted + surplus);`

This matches the two burn calls at lines 645 and 647:
- `airUsdToken.burn(address(this), pos.airUsdMinted)` -- synthetic debt
- `airUsdToken.burn(address(this), surplus)` -- backed airUsd for USDC payout

Sum = `pos.airUsdMinted + surplus` = total airUsd burned. Correct.

### Fix M-2: shortOpenInterest tracks via pos.usdcIn

Verified at all 4 decrement sites (lines 868, 911, 1333, 1406): all use `pos.usdcIn`. The open site (line 779) uses `usdcNotional`, which is stored as `pos.usdcIn` in the PositionNFT (line 802). Symmetric and correct.

### Fix N2-M1: Router sweep function

Verified. The sweep function (line 128-133):
- Is callable by anyone (sends to `msg.sender`)
- Cannot be exploited mid-transaction: all router state-changing functions are `nonReentrant`, and the pool's `_transferIn` performs balance verification
- Even with malicious ERC-20 token hooks, any re-entrant call to `sweep` during a router function would cause the pool's `_transferIn` to detect a balance mismatch and revert the entire transaction
- The router never intentionally holds tokens between transactions

No vulnerability.

---

## Cross-Fix Interaction Analysis

### Scenario: N-1 fix interacting with N2-I1 counts

The lockedAmount subtraction (N-1) only affects AMM pricing calculations. The position counts (N2-I1) are pure increment/decrement counters. These two systems share no state variables and cannot create inconsistencies through interaction.

### Scenario: Multiple positions open + liquidation cascade

With per-side counts, a cascade of liquidations (e.g., market crash causing multiple longs to become underwater) will correctly decrement `longPositionCount` for each. Since `_liquidateExpiredLong` and `_forceRealizeLong` both decrement `openPositionCount` and `longPositionCount` atomically (in the same function, no intermediate external calls between the two decrements), no partial state is observable.

### Scenario: Impact fee + count desynchronization attack

An attacker opening many small positions to accumulate OI, then trying to exploit count/OI tracking through partial closes. Verified: OI is tracked by notional value (not by count), and counts are tracked independently. Both are decremented in every close path. The impact fee reads OI at transaction time, so no stale data is used.

### Scenario: Flash loan sandwich against router

An attacker could:
1. Flash borrow USDC
2. Swap to manipulate price
3. Victim's position open/close executes at worse price
4. Swap back
5. Repay flash loan

This is standard AMM sandwich risk mitigated by:
- `minAirTokenOut` / `minAirUsdOut` / `minUsdcOut` slippage guards on all operations
- Swap fees retained by the pool on every trade (attacker pays fees on both legs)
- This is by-design for any constant-product AMM and not a protocol-specific vulnerability

---

## Detailed Line-by-Line Audit Notes

### EXNIHILOPool.sol (1561 lines)

**Constructor (390-436):** All immutables validated non-zero. positionDuration defaults to 7 days. _tokenUnit correctly caches 10^decimals. No issue.

**swap / _swapTokenToUsdc / _swapUsdcToToken (456-1283):** Standard constant-product with fee. CEI pattern followed. Reserve invariant checked. No issue.

**openLong (498-579):** Fee calculation correct. SWAP-2 pricing uses `airUsdToken.totalSupply()` (inflated) as reserveIn and `backedAirToken` as reserveOut. Synthetic airUsd minted AFTER pricing but BEFORE NFT interaction. CEI preserved. Position counts and OI updated atomically. No issue.

**closeLong (606-654):** SWAP-3 pricing subtracts lockedAmount from airToken supply. Surplus calculation correct. Burns synthetic debt + surplus separately. Transfer split between holder and protocol. Reserve invariant checked. No issue.

**realizeLong (674-706):** Holder pays airUsdMinted in USDC. backedAirUsd increases. airToken burned and underlying delivered. No issue.

**openShort (731-812):** airTokenMinted calculated as `usdcNotional * airTokenSupply / backedAirUsd`. SWAP-3 pricing. Fee structure mirrors openLong. No issue.

**closeShort (833-884):** N-1 fix applied -- subtracts lockedAmount from airUsd supply for SWAP-2 pricing. Proportional cost with ceil division. Conservative by design. Burns surplus airUsd only (cost portion stays backed). No issue.

**realizeShort (900-932):** Holder delivers raw tokens. backedAirToken increases. airUsd burned and USDC delivered. No issue.

**addLiquidity (951-976):** Ratio check with cross-multiplication and tolerance. Both sides updated. Reserve invariant checked. No issue.

**removeLiquidity (986-1008):** Requires openPositionCount == 0. All-or-nothing by design. No issue.

**claimFees (1013-1022):** Simple accumulator drain. No issue.

**forceRealize paths (1041-1352):** Underwater check before force-realize. LP pays debt. Original holder receives collateral at a loss. Counts decremented. No issue.

**liquidateExpired paths (1111-1443):** Deadline check. Profitable branch mirrors closeLong/closeShort. Underwater branch returns collateral to LP and burns synthetic debt. No issue.

**_longIsUnderwater / _shortIsUnderwater (1449-1470):** Both correctly use the same SWAP mode and lockedAmount subtraction as their close counterparts. No issue.

**_cpAmountOut (1491-1501):** Spot-price fee model. Overflow safe for practical token amounts. Returns 0 when fee >= rawOut. No issue.

**_transferIn (1539-1545):** Balance check before and after. Rejects fee-on-transfer tokens. No issue.

**_assertReserveInvariant (1556-1559):** backedAirToken <= airToken.totalSupply() and backedAirUsd <= airUsdToken.totalSupply(). Checked after every state-changing operation. No issue.

### EXNIHILOFactory.sol (388 lines)

No admin functions. All immutables. createMarket flow: deploy, wire, mint LP NFT, seed, transfer. ReentrancyGuard. Fee-on-transfer rejection. Residual approval clearing. No issue.

### EXNIHILORouter.sol (135 lines)

Thin wrapper. Fee replication matches pool exactly. NonReentrant on all state-changing functions. Sweep is safe (no tokens held between transactions, cannot be exploited mid-transaction due to pool's _transferIn balance checks). No issue.

### PositionNFT.sol (565 lines)

Factory-gated minting. Pool-gated release. Correct custody model (tokens live in NFT contract). On-chain SVG with live PnL using same AMM math as pool. _cpOut matches pool's _cpAmountOut. _fmtToken handles variable decimals. No issue.

### LpNFT.sol (76 lines)

Factory-gated minting. Simple ERC-721. poolOf mapping. No issue.

### AirToken.sol (93 lines)

Pool-gated mint/burn. Factory-gated initPool (one-time). Custom decimals. No issue.

---

## Overflow/Precision Analysis

| Formula | Max bits (practical) | uint256 headroom |
|---|---|---|
| `amountIn * reserveOut / (reserveIn + amountIn)` | ~128+128 / ~128 = ~128 bits | Safe |
| `amountIn * reserveOut * swapFeeBps / (reserveIn * BPS_DENOM)` | ~128+128+14 = ~270 bits | Overflow possible for extreme reserves (>2^121) but unreachable in practice with any real token supply |
| Impact fee numerator | ~14+40+40 = ~94 bits | Safe |
| `pos.lockedAmount * pos.airTokenMinted / totalBuyable` (ceil div) | ~128+128 / ~128 = ~128 bits | Safe |
| `backedAirUsd * _tokenUnit / backedAirToken` (spotPrice) | ~40+77 = ~117 bits | Safe |

The only theoretical overflow is in `_cpAmountOut`'s fee calculation for tokens with astronomically large supplies (>10^36 on both sides), which is unreachable for any real deployment. The Solidity 0.8.24 checked arithmetic ensures a clean revert if this ever occurred, preventing any funds loss.

---

## Convergence Statement

After three complete Nemesis audit passes:

1. **Pass 1** found 7 Low, 2 Medium, and 4 Informational issues -- all fixed.
2. **Pass 2** found 1 Medium, 3 Low, and 3 Informational issues in the fixes and new code -- all fixed.
3. **Pass 3** (this report) found **zero new issues**.

The protocol has achieved audit convergence. All prior fixes are correctly implemented, introduce no regressions, and do not create exploitable interactions between them. The state accounting invariants (`openPositionCount == longPositionCount + shortPositionCount`, `backedAir* <= airAir*.totalSupply()`) are preserved across all 10 position lifecycle paths.

The EXNIHILO protocol is ready for deployment consideration, subject to the known by-design choices documented in the scope (all-or-nothing removeLiquidity, conservative short close cost, and public renewPosition).

---

*Nemesis Audit Pass 3 -- Final. No further passes required.*
