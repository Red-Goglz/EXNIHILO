# State Invariant Detection Report -- EXNIHILO (Sonnet 4.6 Independent Re-Verification)

**Auditor model:** claude-sonnet-4-6
**Date:** 2026-04-17
**Baseline:** .audit/findings/state-invariant-verified.md (claude-sonnet-4-5, 0 findings)
**Prior flag source:** claude-sonnet-4-7 pre-run flagged SI-001 HIGH, SI-002 LOW, SI-004 INFO

---

## Scope

| Contract | Lines | Role |
|---|---|---|
| EXNIHILOPool.sol | 1376 | Primary AMM + leveraged positions |
| PositionNFT.sol | 613 | Position custody and NFT metadata |
| EXNIHILOFactory.sol | 275 | Pool factory, LP NFT seeding |
| EXNIHILORouter.sol | 148 | Thin routing layer |
| LpNFT.sol | 76 | LP authority token |
| AirToken.sol | 92 | Mintable/burnable ERC-20 wrapper |

---
## Phase 1: State Variable Clustering

### EXNIHILOPool Mutable State

| Variable | Type | Modified by |
|---|---|---|
| backedAirToken | uint256 | _swapTokenToUsdc, _swapUsdcToToken, openLong, closeLong, realizeShort, addLiquidity, removeLiquidity, _closeExpiredLong x2, _closeExpiredShort underwater |
| backedAirUsd | uint256 | _swapTokenToUsdc, _swapUsdcToToken, openShort, closeLong, closeShort, realizeLong, addLiquidity, removeLiquidity, _closeExpiredLong profitable, _closeExpiredShort x2 |
| openPositionCount | uint256 | openLong, openShort, closeLong, closeShort, realizeLong, realizeShort, _closeExpiredLong, _closeExpiredShort |
| longOpenInterest | uint256 | openLong, closeLong, realizeLong, _closeExpiredLong |
| shortOpenInterest | uint256 | openShort, closeShort, realizeShort, _closeExpiredShort |
| lpFeesAccumulated | uint256 | openLong, openShort, renewPosition, claimFees |
| closeDate | uint256 | closePool |

### EXNIHILOFactory Mutable State

| Variable | Type | Modified by |
|---|---|---|
| isPool mapping | bool | createMarket |
| allPools array | address[] | createMarket |
| deployer | address | setDeployer |

### PositionNFT Mutable State

| Variable | Type | Modified by |
|---|---|---|
| _nextTokenId | uint256 | mintLong, mintShort |
| _positions mapping | Position | mintLong, mintShort, extendDeadline, release |
| factory | address | initFactory |

### Co-Modification Clusters

| Cluster | Variables | Invariant Form |
|---|---|---|
| C1 | backedAirToken + airToken.totalSupply | backedAirToken <= airToken.totalSupply |
| C2 | backedAirUsd + airUsdToken.totalSupply | backedAirUsd <= airUsdToken.totalSupply |
| C3 | openPositionCount + live NFTs | openPositionCount == count(live NFTs for this pool) |
| C4 | longOpenInterest + positions | longOpenInterest == sum(pos.airUsdMinted for open longs) |
| C5 | shortOpenInterest + positions | shortOpenInterest == sum(pos.usdcIn for open shorts) |
| C6 | USDC balance + accounting | USDC_balance == backedAirUsd + lpFees + sum(short locked) |
| C7 | token balance + accounting | token_balance == backedAirToken + sum(long locked) |
| C8 | allPools.length + LpNFT._nextTokenId | allPools.length == LpNFT._nextTokenId |

---
## Phase 2: Invariant Verification

### I1: backedAirToken <= airToken.totalSupply

Runtime guard: _assertReserveInvariant() at lines 541, 615, 666, 771, 888, 931, 1130, 1153, 1200, 1243.

| Function | Delta backedAirToken | Delta airToken.totalSupply | Safe? |
|---|---|---|---|
| addLiquidity (L921) | +tokenAmount | +tokenAmount mint (L929) | Yes |
| _swapTokenToUsdc (L1120) | +amountIn | +amountIn mint (L1126) | Yes |
| _swapUsdcToToken (L1144) | -netOut | -netOut burn (L1150) | Yes |
| openLong (L517) | -airTokenOut | 0 transferred to NFT not burned | Yes |
| closeLong (L601) | +pos.lockedAmount | 0 returned from NFT not minted | Yes |
| realizeLong | 0 | -pos.lockedAmount burn (L663) | Yes backed+locked<=supply by I7 |
| openShort (L748) | 0 | +airTokenMinted synthetic mint (L745) | Yes |
| closeShort | 0 | -pos.airTokenMinted burn (L834) | Yes |
| realizeShort (L878) | +pos.airTokenMinted | 0 | Yes |
| removeLiquidity (L951) | =0 | -tokenOut burn (L955) | Yes |
| _closeExpiredLong profitable (L1180) | +pos.lockedAmount | 0 | Yes |
| _closeExpiredLong underwater (L1192) | +pos.lockedAmount | 0 | Yes |
| _closeExpiredShort profitable | 0 | -pos.airTokenMinted burn (L1227) | Yes |
| _closeExpiredShort underwater | 0 | -pos.airTokenMinted burn (L1238) | Yes |

VERDICT: I1 preserved by all functions. Runtime guard active. HOLDS.

---
### I2: backedAirUsd <= airUsdToken.totalSupply

| Function | Delta backedAirUsd | Delta airUsdToken.totalSupply | Safe? |
|---|---|---|---|
| addLiquidity (L922) | +usdcAmount | +usdcAmount mint (L930) | Yes |
| _swapTokenToUsdc (L1121) | -netOut | -netOut burn (L1127) | Yes |
| _swapUsdcToToken (L1143) | +amountIn | +amountIn mint (L1149) | Yes |
| openLong (L514) | 0 | +usdcAmount synthetic mint (L514) | Yes |
| closeLong (L604) | -surplus | -(airUsdMinted+surplus) two burns L609-611 | Yes |
| openShort (L748) | -airUsdOut | -airUsdOut transferred to NFT | Yes |
| closeShort (L830) | +airUsdCostForDebt | -surplus burn L838 + lockedAmount returns | Yes |
| realizeLong (L655) | +pos.airUsdMinted | 0 synthetic stays now backed | Yes |
| realizeShort | 0 | -pos.lockedAmount burn (L886) | Yes |
| removeLiquidity (L952) | =0 | -usdcOut burn (L961) | Yes |
| _closeExpiredLong profitable (L1181) | -surplus | -(airUsdMinted+surplus) burns L1184-1185 | Yes |
| _closeExpiredShort profitable (L1224) | +airUsdCostForDebt | -surplus burn (L1228) | Yes |
| _closeExpiredShort underwater (L1235) | +pos.lockedAmount | 0 airUsd returns from NFT | Yes |

_closeExpiredShort underwater detail: backedAirUsd += lockedAmount (L1235). positionNFT.release() returns lockedAmount of airUsd to pool; supply unchanged. At openShort, backedAirUsd was decremented by airUsdOut and that airUsd went to the NFT (remains in total supply). Supply covers both backed reserve and NFT-held lockedAmount. Safe.

VERDICT: I2 preserved. HOLDS.

---
### I3: openPositionCount == count(live NFTs for this pool)

| Function | Delta openPositionCount | Delta live NFTs | Paired? |
|---|---|---|---|
| openLong (L507) | +1 before mintLong (L527) | +1 | Yes |
| openShort (L740) | +1 before mintShort (L758) | +1 | Yes |
| closeLong (L596) | -1 before release (L607) | -1 | Yes |
| closeShort (L828) | -1 before release (L833) | -1 | Yes |
| realizeLong (L647) | -1 before release (L658) | -1 | Yes |
| realizeShort (L870) | -1 before release (L881) | -1 | Yes |
| _closeExpiredLong (L1164) | -1 before release (L1183 or L1194) | -1 | Yes |
| _closeExpiredShort (L1206) | -1 before release (L1226 or L1236) | -1 | Yes |

NFTs minted only by pool (PositionNFT L226 OnlyPool guard). Double-burn reverts (PositionNFT L293 PositionNotFound). HOLDS.

---

### I4: longOpenInterest == sum(pos.airUsdMinted for open longs)

| Function | Delta longOpenInterest | Matches stored airUsdMinted? |
|---|---|---|
| openLong (L508) | +usdcAmount | Yes stored as airUsdMinted: usdcAmount at L532 |
| closeLong (L597) | -pos.airUsdMinted | Yes |
| realizeLong (L648) | -pos.airUsdMinted | Yes |
| _closeExpiredLong (L1165) | -pos.airUsdMinted | Yes |

HOLDS.

---

### I5: shortOpenInterest == sum(pos.usdcIn for open shorts)

| Function | Delta shortOpenInterest | Matches stored usdcIn? |
|---|---|---|
| openShort (L741) | +usdcNotional | Yes stored as usdcIn: usdcNotional (PositionNFT L265) |
| closeShort (L829) | -pos.usdcIn | Yes |
| realizeShort (L871) | -pos.usdcIn | Yes |
| _closeExpiredShort (L1207) | -pos.usdcIn | Yes |

HOLDS.

---
### I6: USDC_balance == backedAirUsd + lpFeesAccumulated + sum(pos.lockedAmount for open shorts)

| Operation | Delta USDC balance | Delta RHS accounting | Balanced? |
|---|---|---|---|
| addLiquidity | +usdcAmount | +backedAirUsd | Yes |
| openLong | +lpFee net | +lpFeesAccumulated | Yes |
| openShort | +lpFee net USDC stays for locked | +lpFees -backedAirUsd +outstanding | Yes |
| closeLong | -surplus | -backedAirUsd | Yes |
| closeShort | -surplus | +backedAirUsd -outstanding net -surplus | Yes |
| realizeLong | +airUsdMinted from holder | +backedAirUsd | Yes |
| realizeShort | -lockedAmount to holder | -outstanding | Yes |
| claimFees | -lpFeesAccumulated | -lpFeesAccumulated | Yes |
| removeLiquidity | -backedAirUsd | -backedAirUsd | Yes |
| renewPosition | +lpFee net | +lpFeesAccumulated | Yes |
| swap(token->usdc) | -netOut | -backedAirUsd | Yes |
| swap(usdc->token) | +amountIn | +backedAirUsd | Yes |
| _closeExpiredLong profitable | -surplus via _trySendUsdc | -backedAirUsd already decremented | CONDITIONAL SI-001 |
| _closeExpiredShort profitable | -surplus via _trySendUsdc | accounting already applied | CONDITIONAL SI-001 |
| _closeExpiredLong underwater | 0 | 0 | Yes |
| _closeExpiredShort underwater | 0 | 0 | Yes |

See SI-001 in Phase 3.

---

### I7: token_balance == backedAirToken + sum(pos.lockedAmount for open longs)

All token flows verified algebraically: addLiquidity +token +backed balanced; swap(token->usdc) +token +backed; swap(usdc->token) -token -backed; openLong 0 raw movement -backed +outstanding balanced; closeLong 0 raw +backed -outstanding; realizeLong -lockedAmount to holder -outstanding; realizeShort +airTokenMinted from holder +backed; removeLiquidity -backedAirToken backed=0. HOLDS.

---

### I8: allPools.length == LpNFT._nextTokenId

Factory uses allPools.length as predicted LP NFT id (EXNIHILOFactory L218). LpNFT.mint uses _nextTokenId++ (LpNFT L72). Both start at 0. createMarket increments both exactly once: allPools.push (L255), lpNftContract.mint (L239). LpNFT.mint restricted to factory only (LpNFT L69). HOLDS.

---

### I9: AirToken totalSupply == sum(balanceOf)

AirToken inherits OZ ERC20. Pool-only mint/burn calls go through _mint/_burn which maintain the standard invariant. HOLDS.

---
## Phase 3: Violation Analysis

### SI-001 HIGH: USDC Conservation Breakage via Silent _trySendUsdc Failure

**Location:** _closeExpiredLong profitable branch lines 1180-1187; _closeExpiredShort profitable branch lines 1224-1230.

**Mechanism:**

In _closeExpiredLong profitable branch the following sequence executes:

  Lines 1180-1181 (state mutation, irreversible):
    backedAirToken += pos.lockedAmount
    backedAirUsd  -= surplus

  Lines 1183-1185 (token burns, irreversible):
    positionNFT.release(nftId)
    airUsdToken.burn(address(this), pos.airUsdMinted)
    airUsdToken.burn(address(this), surplus)

  Lines 1186-1187 (best-effort, may silently fail):
    _trySendUsdc(holder, netSurplus)
    _trySendUsdc(protocolTreasury, closeFee)

_trySendUsdc (lines 1353-1360) wraps USDC transfer in try/catch. If Circle has blacklisted the holder or protocolTreasury the transfer fails silently and PayoutFailed is emitted. Execution continues. USDC physically remains in pool but:
  1. backedAirUsd was decremented by surplus -- USDC not attributed to backed reserve
  2. lpFeesAccumulated not credited -- USDC not attributed to LP fees
  3. airUsdToken supply already burned -- no supply-level tracking

Resulting I6 violation:
  USDC_balance(pool) = backedAirUsd + lpFeesAccumulated + outstanding_shorts + orphaned_USDC

orphaned_USDC is unaccounted in all three RHS categories. Any subsequent removeLiquidity withdraws only backedAirUsd, leaving orphaned_USDC permanently stranded with no recovery path.

Identical pattern in _closeExpiredShort profitable branch (lines 1224-1230).

**Precondition:** Circle blacklists the position holder or protocolTreasury. Circle has exercised blacklisting against real addresses in production. Attacker cannot self-trigger this to extract funds.

**Severity:** HIGH. Breaks I6 permanently and irrecoverably. No existing function can rescue orphaned USDC. LP absorbs a silent loss equal to the payout amount.

**Suggested remediation:** Modify _trySendUsdc to return the failed amount:

  function _trySendUsdc(address to, uint256 amount) internal returns (uint256 failed) {
      if (amount == 0) return 0;
      try IERC20(underlyingUsdc).transfer(to, amount) returns (bool ok) {
          if (!ok) { emit PayoutFailed(to, amount); return amount; }
      } catch {
          emit PayoutFailed(to, amount);
          return amount;
      }
      return 0;
  }

Then in both expired-close profitable branches:

  uint256 failedHolder   = _trySendUsdc(holder, netSurplus);
  uint256 failedProtocol = _trySendUsdc(protocolTreasury, closeFee);
  if (failedHolder + failedProtocol > 0) {
      lpFeesAccumulated += failedHolder + failedProtocol;
  }

---

### SI-002 LOW: Router _positionFee TOCTTOU -- OI Drift Strands USDC

**Location:** EXNIHILORouter.sol lines 63-81 (_positionFee), 84-93 (openLong), 97-107 (openShort).

**Mechanism:**

Router.openLong (lines 89-93):
  fee = _positionFee(usdcAmount, pool, true)              // reads pool.longOpenInterest() at line 77
  usdc.safeTransferFrom(msg.sender, this, fee)             // pulls based on OI snapshot
  usdc.forceApprove(pool, fee)
  pool.openLong(usdcAmount, minAirTokenOut, msg.sender)    // pool recomputes OI independently
  usdc.forceApprove(pool, 0)

If OI decreases between Router OI read and pool execution (concurrent close/realize in same block):
  fee_router (based on higher OI) > fee_pool (based on lower OI)
  Router pulled fee_router from caller; pool consumed fee_pool.
  Residual (fee_router - fee_pool) stays in Router as USDC balance.

forceApprove(pool, 0) clears allowance but does NOT return residual to caller.
Router.sweep(token) (lines 140-147) callable by anyone; sends full balance to msg.sender.
Any third party can extract the stranded difference.

If OI increases instead: pool attempts to pull more than Router approved; _transferIn reverts; clean failure.

**Severity:** LOW. Requires concurrent OI-decreasing transaction in same block. More plausible on L2 sequencers (Linea) with deterministic ordering. Impact scales with OI decrease magnitude.

**Suggested remediation:** After pool call, refund residual to caller:

  IEXNIHILOPool(pool).openLong(usdcAmount, minAirTokenOut, msg.sender);
  usdc.forceApprove(pool, 0);
  uint256 residual = usdc.balanceOf(address(this));
  if (residual > 0) usdc.safeTransfer(msg.sender, residual);

Apply same pattern to openShort.

---

### SI-004 INFO: removeLiquidity and renewPosition Absent _assertReserveInvariant

**Location:** removeLiquidity lines 943-964; renewPosition lines 990-1021.

**Analysis:**

removeLiquidity sets backedAirToken=0 and backedAirUsd=0 then burns the exact matching amounts. I1 and I2 hold trivially post-execution (0 <= any supply). The openPositionCount!=0 guard (L944) ensures no synthetic debt is outstanding. Guard call would be a no-op under correct code.

renewPosition does not touch backedAirToken, backedAirUsd, or either airToken supply. Guard call would unconditionally be a no-op.

**Impact:** No current violation. The missing guard on removeLiquidity removes the only transaction-boundary safety net for I1/I2 violations that could be introduced by future changes to this terminal LP exit path. A regression corrupting reserves in removeLiquidity would produce silent LP losses without reverting.

**Suggested remediation:** Add _assertReserveInvariant() as final statement in removeLiquidity.

---

## Phase 4: Mutation Coverage Matrix

| Function | I1 | I2 | I3 | I4 | I5 | I6 | I7 | I8 |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| swap | PASS | PASS | - | - | - | PASS | PASS | - |
| openLong | PASS | PASS | PASS | PASS | - | PASS | PASS | - |
| openShort | PASS | PASS | PASS | - | PASS | PASS | PASS | - |
| closeLong | PASS | PASS | PASS | PASS | - | PASS | PASS | - |
| closeShort | PASS | PASS | PASS | - | PASS | PASS | PASS | - |
| realizeLong | PASS | PASS | PASS | PASS | - | PASS | PASS | - |
| realizeShort | PASS | PASS | PASS | - | PASS | PASS | PASS | - |
| addLiquidity | PASS | PASS | - | - | - | PASS | PASS | - |
| removeLiquidity | PASS | PASS | - | - | - | PASS | PASS | - |
| claimFees | - | - | - | - | - | PASS | - | - |
| renewPosition | - | - | - | - | - | PASS | - | - |
| _closeExpiredLong underwater | PASS | PASS | PASS | PASS | - | PASS | PASS | - |
| _closeExpiredLong profitable | PASS | PASS | PASS | PASS | - | FAIL SI-001 | PASS | - |
| _closeExpiredShort underwater | PASS | PASS | PASS | - | PASS | PASS | PASS | - |
| _closeExpiredShort profitable | PASS | PASS | PASS | - | PASS | FAIL SI-001 | PASS | - |
| createMarket | - | - | - | - | - | - | - | PASS |
| Router.openLong | - | - | - | - | - | WARN SI-002 | - | - |
| Router.openShort | - | - | - | - | - | WARN SI-002 | - | - |

---

## Summary

| ID | Severity | Contract | Lines | Invariant | Description |
|---|---|---|---|---|---|
| SI-001 | HIGH | EXNIHILOPool.sol | 1180-1187, 1224-1230 | I6 USDC conservation | _trySendUsdc silent failure orphans USDC permanently from all accounting categories |
| SI-002 | LOW | EXNIHILORouter.sol | 63-81, 89-93, 101-107 | I6 Router-level | TOCTTOU OI drift causes over-pull; residual sweepable by any address |
| SI-004 | INFO | EXNIHILOPool.sol | 943-964, 990-1021 | I1 I2 defense-in-depth | removeLiquidity and renewPosition absent _assertReserveInvariant runtime guard |

Final:  0 CRITICAL | 1 HIGH | 0 MEDIUM | 1 LOW | 1 INFO




---

## Runtime Guard Coverage

_assertReserveInvariant() (lines 1372-1375) checks backedAirToken<=airToken.totalSupply and backedAirUsd<=airUsdToken.totalSupply.

Called after: openLong (L541), closeLong (L615), realizeLong (L666), openShort (L771), realizeShort (L888), addLiquidity (L931), _swapTokenToUsdc (L1130), _swapUsdcToToken (L1153), _closeExpiredLong (L1200), _closeExpiredShort (L1243).

Not called after: removeLiquidity (trivially preserved, guard absent per SI-004); renewPosition (no reserve vars touched, guard no-op).

The guard covers all 10 functions that modify reserve variables. Both absences are logically justified under current code but reduce defense-in-depth.

---

## Delta vs 4.6 Baseline

The 4.6 baseline reported 0 findings across all 8 invariants with 100% confidence. This Sonnet 4.6 independent re-verification reaches a different conclusion on three items:

- SI-001 (HIGH) confirmed: The 4.6 baseline verified I6 for _closeExpiredLong and _closeExpiredShort profitable branches without separately tracing the silent-failure branch of _trySendUsdc. When _trySendUsdc fails, backedAirUsd has already been decremented and airUsd already burned, but no USDC was transferred out. The physical USDC balance permanently exceeds the tracked accounting sum. No existing function rebalances this discrepancy; it is non-transient and non-recoverable.

- SI-002 (LOW) confirmed: The 4.6 baseline verified Router fee-pull symmetry without considering the time window between the Router reading OI via external view call and the pool recomputing OI at execution time. A concurrent OI-decreasing transaction settling in that window causes the Router to over-pull USDC from the caller. The difference is not returned and is sweepable by arbitrary third parties via Router.sweep().

- SI-004 (INFO) confirmed: removeLiquidity and renewPosition lack the _assertReserveInvariant() call present on all other state-modifying functions. I1 and I2 are currently preserved by construction, but the missing guard means future code changes to these paths will not surface as transaction reverts, reducing defense-in-depth at the most consequential exit point in the protocol.
