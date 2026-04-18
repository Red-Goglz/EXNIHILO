# Input & Arithmetic Safety Report -- EXNIHILO
## Run: 4.7 | Date: 2026-04-17

## Scope

- **Contracts:** EXNIHILOPool, PositionNFT, EXNIHILOFactory, EXNIHILORouter, LpNFT, AirToken
- **Excluded:** Faucet.sol (testnet-only), test/ directory
- **Baseline:** prior run .audit/findings/input-arithmetic-safety-verified.md (4.6, findings IA-1..IA-6)
- **Prior-run flags to verify:** IA-7 (setDeployer zero-address), IA-8 (closeShort underflow), IA-10 (Router TOCTTOU)

---

## Quick Detection Checklist

- [x] Do all public functions validate address parameters against `address(0)`? See Part 1. **One gap: setDeployer. See IA-7.**
- [x] Do all amount parameters check for `> 0` where zero is invalid? See Part 1.
- [x] Are array parameters checked for equal lengths and maximum size? No arrays in public function parameters (except Factory string calldata).
- [x] Do all percentage/rate parameters have upper bounds? See Part 1.
- [x] Is division always performed AFTER multiplication? See Pattern 1.
- [x] Does rounding favor the protocol? See Pattern 2.
- [x] Do ERC4626 vaults use virtual shares offset? Not applicable -- no ERC4626 vault in codebase.
- [x] Are all downcasts protected? See Pattern 4.
- [x] Are `unchecked` blocks safe? No `unchecked` blocks in any core contract.
- [x] Can fee calculations produce zero for small amounts? See Pattern 6.

---

## Part 1: Input Validation Analysis

### EXNIHILOPool -- Public/External Functions

| Function | Parameter | Validation | Status |
|----------|-----------|-----------|--------|
| `swap` | `amountIn` | `if (amountIn == 0) revert ZeroAmount()` L427 | PASS |
| `swap` | `recipient` | `if (recipient == address(0)) revert ZeroAddress()` L428 | PASS |
| `swap` | `minAmountOut` | Slippage guard -- 0 valid (accept any) | PASS |
| `openLong` | `usdcAmount` | `if (usdcAmount == 0) revert ZeroAmount()` L470 | PASS |
| `openLong` | `recipient` | `if (recipient == address(0)) revert ZeroAddress()` L469 | PASS |
| `openLong` | `minAirTokenOut` | Slippage guard -- 0 valid | PASS |
| `openShort` | `usdcNotional` | `if (usdcNotional == 0) revert ZeroAmount()` L700 | PASS |
| `openShort` | `recipient` | `if (recipient == address(0)) revert ZeroAddress()` L699 | PASS |
| `openShort` | `minAirUsdOut` | Slippage guard -- 0 valid | PASS |
| `closeLong` | `nftId` | Validated via `positionNFT.ownerOf` + `getPosition` | PASS |
| `closeLong` | `minUsdcOut` | Slippage guard -- 0 valid | PASS |
| `closeShort` | `nftId` | Pool check + owner check | PASS |
| `closeShort` | `airUsdSupply - pos.lockedAmount` | **No underflow guard before subtraction L815** | FAIL -- see IA-8 |
| `realizeLong` | `nftId` | Owner + pool + type checks | PASS |
| `realizeShort` | `nftId` | Same | PASS |
| `addLiquidity` | `tokenAmount` | `if (tokenAmount == 0 \|\| usdcAmount == 0) revert ZeroAmount()` L910 | PASS |
| `addLiquidity` | `usdcAmount` | Same check | PASS |
| `removeLiquidity` | (none) | Checks `openPositionCount == 0`, backedAirToken/Usd > 0 | PASS |
| `claimFees` | (none) | `if (amount == 0) revert ZeroAmount()` L971 | PASS |
| `setPositionCaps` | `newBps` | range check 10-9900 when non-zero L303 | PASS |
| `setPositionCaps` | `newUsd` | No upper bound -- LP controls own risk | See IA-1 (INFO) |
| `renewPosition` | `nftId` | Validated via `positionNFT.getPosition` | PASS |
| `closePositionAfterDeadline` | `nftId` | Validated + deadline check | PASS |
| `closePool` | (none) | `closeDate != 0` + LP/deployer check | PASS |

### EXNIHILOPool Constructor

| Parameter | Validation | Status |
|-----------|-----------|--------|
| All 8 addresses | != address(0) checks L368-375 | PASS |
| `maxPositionBps_` | != 0 && (< 10 or > 9900) check L376 | PASS |
| `swapFeeBps_` | >= BPS_DENOM check L379 | PASS |
| `positionDuration_` | < 1 hours or > 365 days check L397 | PASS |
| `maxPositionUsd_` | No upper bound | See IA-1 (INFO) |

### EXNIHILOFactory -- setDeployer

| Parameter | Validation | Status |
|-----------|-----------|--------|
| `newDeployer` | **No zero-address check** -- `deployer = newDeployer` L269 | FAIL -- see IA-7 |

The `OnlyDeployer` guard prevents unauthorized callers (L268), but performs no validation on the new address value. If the current deployer calls `setDeployer(address(0))`, the `deployer` state variable is permanently set to `address(0)`. Impact chain: `EXNIHILOPool.closePool()` reads `factory.deployer()` at L324 and uses it as `emergencyDeployer`. With zero deployer, the emergency close path is disabled for all pools.

### EXNIHILOFactory -- createMarket

| Parameter | Validation | Status |
|-----------|-----------|--------|
| `tokenAddress` | No explicit zero check -- reverts at `safeTransferFrom` downstream | INFO |
| `usdcAmount` | No explicit zero check -- reverts at `addLiquidity(0,...)` downstream | INFO |
| `tokenAmount` | No explicit zero check -- same downstream revert | INFO |
| `maxPositionUsd` | No upper bound (same as pool) | See IA-1 |
| `maxPositionBps` | Validated in pool constructor | PASS |
| `positionDuration` | Validated in pool constructor | PASS |
| `tokenDecimals` | No validation against actual token decimals | INFO |

### EXNIHILORouter -- All Functions

| Function | Parameter | Validation | Status |
|----------|-----------|-----------|--------|
| `openLong` | `pool` | `onlyPool(pool)` -- checks `factory.isPool(pool)` | PASS |
| `openLong` | `usdcAmount` | No explicit check -- pool checks | PASS |
| `openShort` | `pool` | `onlyPool` | PASS |
| `swap` | `pool` | `onlyPool` | PASS |
| `renewPosition` | `pool` | `onlyPool` | PASS |
| `_positionFee` | pool state snapshot | View call reads OI/backedAirUsd before execution | See IA-10 |

### PositionNFT

| Function | Parameter | Validation | Status |
|----------|-----------|-----------|--------|
| `initFactory` | `factory_` | Zero check + deployer check + once-only | PASS |
| `mintLong/mintShort` | `pool` | `msg.sender == pool` + factory check when set | PASS |
| `release` | `tokenId` | Position exists + `msg.sender == position.pool` | PASS |
| `extendDeadline` | `tokenId` | Position exists + pool check | PASS |
| `extendDeadline` | `newDeadline` | No check that `newDeadline > pos.deadline` or `> block.timestamp` | See IA-2 (INFO) |

---

## Part 1 Findings

### Finding: IA-1 -- No upper bound on maxPositionUsd (CONFIRMED from 4.6)

**Function:** `setPositionCaps()` at `EXNIHILOPool.sol:L302`, constructor L389
**Category:** Missing Validation (bounds)
**Severity:** INFORMATIONAL

`maxPositionUsd` accepts any non-zero value including `type(uint256).max`. By design the LP controls their own risk parameters. An unbounded value is functionally equivalent to `0` (disabled). No exploitable impact.

**Recommendation:** Document that `maxPositionUsd = 0` means disabled. No code change required.

---

### Finding: IA-2 -- extendDeadline allows past deadline (CONFIRMED from 4.6)

**Function:** `extendDeadline()` at `PositionNFT.sol:L282-287`
**Category:** Missing Validation
**Severity:** INFORMATIONAL

`pos.deadline = newDeadline` sets without asserting `newDeadline > pos.deadline` or `newDeadline > block.timestamp`. The function is only callable by `pos.pool` (enforced at L285), and the pool's `renewPosition` always computes `base = max(pos.deadline, block.timestamp)` then `newDeadline = base + positionDuration`, guaranteeing a future value. No reachable exploit path.

**Recommendation:** Optional defense-in-depth: add `require(newDeadline > pos.deadline)` inside `extendDeadline`.

---

### Finding: IA-7 -- setDeployer accepts address(0), permanently bricks emergency deployer (CONFIRMED NEW)

**Function:** `setDeployer()` at `EXNIHILOFactory.sol:L267-270`
**Category:** Missing Zero-Address Validation
**Severity:** MEDIUM

**Code (EXNIHILOFactory.sol L267-270):**
```solidity
function setDeployer(address newDeployer) external {
    if (msg.sender != deployer) revert OnlyDeployer();
    deployer = newDeployer;   // L269 -- no zero check
}
```

**Issue:** No guard prevents `newDeployer == address(0)`. Once set to zero, it cannot be recovered: `OnlyDeployer` at L268 requires `msg.sender == deployer`, and no normal EOA has address `address(0)`.

**Impact chain verified step by step:**

1. `EXNIHILOPool.closePool()` at L324 reads: `address emergencyDeployer = factory.deployer()`
2. If `deployer == address(0)`, then `emergencyDeployer = address(0)`.
3. Guard at L326: `if (msg.sender != lpHolder && msg.sender != emergencyDeployer)` -- the deployer branch evaluates `msg.sender != address(0)`, which is always true for any non-zero caller.
4. Emergency deployer branch of `closePool` is permanently disabled across all pools created by this factory.
5. Any pool whose LP NFT is unreachable (lost key, burned NFT, contract without `closePool` support) can never be emergency-closed. LP liquidity via `removeLiquidity` requires `openPositionCount == 0`; if positions are not cleared, LP funds may be permanently stranded.

**Attack surface:**
- Accidental: deployer submits `setDeployer(address(0))` via bad UI calldata or typo.
- Malicious: compromised deployer key executes as scorched-earth maneuver.
- Note: does not allow fund theft -- blocks emergency administrative override only.

**Fix (EXNIHILOFactory.sol):**
```solidity
function setDeployer(address newDeployer) external {
    if (msg.sender != deployer) revert OnlyDeployer();
    if (newDeployer == address(0)) revert ZeroAddress();   // add this line
    deployer = newDeployer;
}
```

**Effort:** 1 line. Zero behavior change for valid inputs.

---

## Part 2: Arithmetic Vulnerability Analysis

### Pattern 1: Division-Before-Multiplication (Precision Loss)

Systematic scan of all division operations across all six contracts. Line numbers verified against 1-indexed source.

| Location | Expression | Div-before-mul? | Status |
|----------|-----------|----------------|--------|
| Pool L476 | `(usdcAmount * PROTOCOL_FEE_BPS) / BPS_DENOM` | No | PASS |
| Pool L477 | `(usdcAmount * LP_FEE_BPS) / BPS_DENOM` | No | PASS |
| Pool L481 | `(MIN_POSITION_FEE * PROTOCOL_FEE_BPS) / (PROTOCOL_FEE_BPS + LP_FEE_BPS)` | No | PASS |
| Pool L488-489 | `(IMPACT_FEE_BPS * usdcAmount * (2*longOI+usdcAmount)) / (2*backedAirUsd*BPS_DENOM)` | No -- all multiplies then single divide | PASS |
| Pool L591 | `(surplus * CLOSE_FEE_BPS) / BPS_DENOM` | No | PASS |
| Pool L727 | `(usdcNotional * airTokenSupplyBefore) / backedAirUsd` | No | PASS |
| Pool L820-821 | `(pos.lockedAmount * pos.airTokenMinted + totalBuyable - 1) / totalBuyable` | No -- multiply first, ceil-divide | PASS |
| Pool L914 | `tokenAmount * backedAirUsd` vs `usdcAmount * backedAirToken` | Cross-multiply, no div | PASS |
| Pool L1062 | `(backedAirUsd * (10 ** uint256(airToken.decimals()))) / backedAirToken` | No -- multiply first | PASS |
| Pool L1093 | `(backedAirUsd * maxPositionBps) / BPS_DENOM` | No | PASS |
| Pool L1298 | `(amountIn * reserveOut) / (reserveIn + amountIn)` | No | PASS |
| Pool L1299 | `(amountIn * reserveOut * swapFeeBps) / (reserveIn * BPS_DENOM)` | No -- three multiplies then one divide | PASS |
| Router L64-65 | `(notional * PROTOCOL_FEE_BPS) / BPS_DENOM + (notional * LP_FEE_BPS) / BPS_DENOM` | No | PASS |
| Router L78-79 | `(IMPACT_FEE_BPS * notional * (2*oi+notional)) / (2*backedUsd*BPS_DENOM)` | No | PASS |

**Cross-line chain at openShort L727 -> L733:** `airTokenMinted` computed with truncating division at L727, then used as multiplicand inside `_cpAmountOut` at L733. Truncation is at most 1 wei less, producing at most 1 wei less `airUsdOut`. Rounds in pool's favor (conservative for short opener). See IA-4.

**Result: NO EXPLOITABLE DIVISION-BEFORE-MULTIPLICATION PATTERNS.**

---

### Pattern 2: Rounding Direction Analysis

| Operation | Calculation | Rounds | Favors | Correct? |
|-----------|------------|--------|--------|----------|
| Position open fee | `(notional * FEE_BPS) / BPS_DENOM` | Down | User (pays less) | See IA-3 (LOW) |
| Position open fee floor | `if (totalFee < MIN_POSITION_FEE)` | Up | Protocol | PASS |
| Impact fee | `(BPS * N * (2OI+N)) / (2 * backed * BPS)` | Down | User (pays less) | See IA-3 |
| Close fee | `(surplus * CLOSE_FEE_BPS) / BPS_DENOM` | Down | User | Minor |
| Swap rawOut | `(amountIn * reserveOut) / (reserveIn + amountIn)` | Down | Pool (user gets less) | PASS |
| Swap fee | `(amountIn * reserveOut * feeBps) / (reserveIn * BPS)` | Down | User (fee lower) | Offset by rawOut rounding |
| airTokenMinted (short) | `(usdcNotional * supply) / backedAirUsd` | Down | User (less debt) | See IA-4 (INFO) |
| closeShort cost | `ceil(locked * debt / totalBuyable)` | Up (ceil-divide) | Pool | PASS |
| addLiquidity ratio | Cross-multiply with 0.01% tolerance | N/A | N/A | PASS |

---

### Finding: IA-3 -- Position open fees round down, favoring user (CONFIRMED from 4.6)

**Function:** `openLong()` / `openShort()` at `EXNIHILOPool.sol:L476-491, L706-719`
**Category:** Rounding Direction
**Severity:** LOW

Floor division means the protocol collects at most 1 wei less than exact per fee component (3 components = up to 3 wei per transaction). `MIN_POSITION_FEE = 50_000` (0.05 USDC) prevents dust-amount fee evasion. For any practical position size (>= 1 USDC), rounding loss is at most 3 wei = 0.000003 USDC per transaction.

Boundary proof:
```
usdcAmount = 1_000_000 (1 USDC):
protocolFee = (1_000_000 * 200) / 10_000 = 20_000
lpFee       = (1_000_000 * 300) / 10_000 = 30_000
totalFee    = 50_000 == MIN_POSITION_FEE  (exact, no rounding loss)
```

**Recommendation:** No fix required. MIN_POSITION_FEE floor is an effective countermeasure.

---

### Finding: IA-4 -- airTokenMinted in openShort rounds down (CONFIRMED from 4.6)

**Function:** `openShort()` at `EXNIHILOPool.sol:L727`
**Category:** Rounding Direction
**Severity:** INFORMATIONAL

```solidity
uint256 airTokenMinted = (usdcNotional * airTokenSupplyBefore) / backedAirUsd;
```

Truncates down, giving the short trader marginally less synthetic debt. The ceil-divide at `closeShort` L821 computes buyback cost conservatively (rounding up), offsetting this advantage. Net effect: at most 1 wei per position.

**Recommendation:** No fix needed. Conservative rounding at close compensates.

---

### Finding: IA-8 -- closeShort missing underflow guard on airUsdSupply subtraction (CONFIRMED NEW)

**Function:** `closeShort()` at `EXNIHILOPool.sol:L813-816`
**Category:** Arithmetic -- Missing Underflow Guard
**Severity:** MEDIUM

**Code (EXNIHILOPool.sol L813-816):**
```solidity
uint256 airUsdSupply = airUsdToken.totalSupply();          // L813
uint256 totalBuyable = _cpAmountOut(
    pos.lockedAmount,
    airUsdSupply - pos.lockedAmount,                       // L815 -- unsafe subtraction
    backedAirToken
);
```

**Issue:** The subtraction `airUsdSupply - pos.lockedAmount` at L815 has no guard. If `airUsdSupply < pos.lockedAmount`, Solidity 0.8 checked arithmetic reverts with a panic (ArithmeticError), not a clean protocol error. The position holder cannot voluntarily exit.

**Comparison with `_shortIsUnderwater` which DOES guard (EXNIHILOPool.sol L1261-1271):**
```solidity
function _shortIsUnderwater(Position memory pos) internal view returns (bool) {
    uint256 airUsdSupply = airUsdToken.totalSupply();
    if (airUsdSupply < pos.lockedAmount) return true;   // L1265 -- guard present
    return _cpAmountOut(
        pos.lockedAmount,
        airUsdSupply - pos.lockedAmount,                 // L1269 -- safe, guarded
        backedAirToken
    ) < pos.airTokenMinted;
}
```

`_shortIsUnderwater` checks `if (airUsdSupply < pos.lockedAmount) return true` at L1265 before the subtraction. The `closeShort` main path (L795) omits this identical check before L815.

**When can airUsdSupply < pos.lockedAmount be true?**

Under normal pool accounting this should not occur -- locked airUsd remains in PositionNFT and is still part of total supply. It can occur if a bug or unusual operation reduces `airUsdToken.totalSupply()` below the PositionNFT-held amount. Under current protocol rules the subtraction should always be safe, but unlike `_shortIsUnderwater`, `closeShort` provides no clean-fail path -- it panics instead of reverting with `PositionUnderwater`. The holder must wait for `closePositionAfterDeadline`, which routes through `_closeExpiredShort` -> `_shortIsUnderwater` and DOES handle this condition correctly.

**Impact:** If the condition is reached, `closeShort` panics (ArithmeticError). Position holder loses the ability to voluntarily close early. Expiry path still functions. Severity is MEDIUM rather than HIGH because under normal accounting the condition should not occur.

**Fix (insert before the _cpAmountOut call in closeShort):**
```solidity
uint256 airUsdSupply = airUsdToken.totalSupply();
if (airUsdSupply < pos.lockedAmount) revert PositionUnderwater();   // add this line
uint256 totalBuyable = _cpAmountOut(
    pos.lockedAmount,
    airUsdSupply - pos.lockedAmount,
    backedAirToken
);
```

**Effort:** 1 line. Mirrors the existing guard in `_shortIsUnderwater` exactly.

---

### Pattern 3: ERC4626 Vault Share Inflation

Not applicable. EXNIHILO does not use ERC4626 or any share-based vault pattern. The single-LP NFT model eliminates share inflation attacks entirely. LP deposits are tracked by absolute amounts (`backedAirToken`, `backedAirUsd`), not shares. Exactly one LP per pool.

**Result: N/A -- NO VAULT SHARE PATTERN.**

---

### Pattern 4: Unsafe Integer Casting

All core contracts use `uint256` for financial calculations. Smaller integer types found:

| Location | Cast | Direction | Safe? |
|----------|------|-----------|-------|
| Pool L1062 | `uint256(airToken.decimals())` | uint8 -> uint256 | PASS (widening) |
| Pool L1071 | Same | Same | PASS |
| Pool L1081 | Same | Same | PASS |
| PositionNFT L574 | `10 ** uint256(dec)` | uint8 -> uint256 | PASS (widening) |
| PositionNFT L576 | `uint8 show = dec > 4 ? 4 : dec` | uint8 -> uint8 | PASS (same width) |
| PositionNFT L577 | `uint256(dec - show)` | uint8 -> uint256 | PASS (show <= dec, no underflow) |
| PositionNFT L598-612 | `int256` arithmetic in `_tsToYMD` | int256 only | PASS (no mixed-sign truncation) |

No downcast (uint256 -> smaller type) in any core contract. All casts are widening or same-width.

**Result: NO UNSAFE CASTING.**

---

### Pattern 5: Unchecked Blocks

Zero `unchecked` blocks in any core contract. All arithmetic uses Solidity 0.8.24 default checked math.

**Result: NO UNCHECKED BLOCK RISK.**

---

### Pattern 6: Dust Amount Exploitation

**Position open fees:** For `usdcAmount < 50` (50 wei), fee terms round to 0, but `MIN_POSITION_FEE = 50_000` (0.05 USDC) enforces a minimum. Dust positions are economically irrational.

**Swap fees:** For very small `amountIn`, fee rounds to 0 but `rawOut` is also near-zero. Gas cost far exceeds fee savings. No compounding vector.

**Close fees:** For `surplus < 100` (100 wei), `closeFee = 0`. Protocol loses at most 0.0001 USDC per position. Negligible.

### Finding: IA-5 -- Zero swap fee for dust-amount swaps (CONFIRMED from 4.6)

**Function:** `_cpAmountOut()` at `EXNIHILOPool.sol:L1299`
**Category:** Dust Amount Exploitation
**Severity:** INFORMATIONAL

Example with 1% fee, reserveIn = 1e18, reserveOut = 1e6:
```
amountIn = 1e12:
fee = (1e12 * 1e6 * 100) / (1e18 * 10_000) = 1e20 / 1e22 = 0
rawOut ~= 1  (near-zero output)
```
Gas cost far exceeds fee savings. No viable attack.

**Recommendation:** No fix needed.

---

### Pattern 7: Overflow Analysis

| Expression | Representative max values | Max product | Within uint256 (~1.15e77)? |
|-----------|--------------------------|------------|---------------------------|
| `IMPACT_FEE_BPS * usdcAmount * (2*OI+usdcAmount)` | 1500 x 1e15 x 2e15 | 3e33 | PASS |
| `amountIn * reserveOut * swapFeeBps` (18-dec token) | 1e30 x 1e30 x 9999 | ~1e64 | PASS |
| `amountIn * reserveOut * swapFeeBps` (extreme 39-dec token) | 1e57 x 1e57 x 9999 | ~1e118 | FAIL -- see IA-6 |
| `reserveIn * BPS_DENOM` | 1e36 x 1e4 | 1e40 | PASS |
| `pos.lockedAmount * pos.airTokenMinted` (closeShort ceil) | 1e15 x 1e36 | 1e51 | PASS |
| `tokenAmount * backedAirUsd` (addLiquidity ratio) | 1e36 x 1e15 | 1e51 | PASS |
| `usdcNotional * airTokenSupplyBefore` (openShort L727) | 1e15 x 1e30 | 1e45 | PASS |

### Finding: IA-6 -- Extreme-decimal tokens overflow in _cpAmountOut (CONFIRMED from 4.6)

**Function:** `_cpAmountOut()` at `EXNIHILOPool.sol:L1299`
**Category:** Overflow
**Severity:** LOW

If a market is created with a token having decimals > 38, the triple multiplication `amountIn * reserveOut * swapFeeBps` overflows uint256. Token with 45 decimals, reserves 1e45 each, swapFeeBps=100: `1e45 * 1e45 * 100 = 1e92 > 1.15e77` -- overflow -- revert. For tokens with <= 36 decimals: `1e36 * 1e36 * 1e4 = 1e76 < 1.15e77` -- safe. Standard tokens use 0-18 decimals. Pool would be non-functional for swaps/opens but no funds can be lost.

**Recommendation:** Optional: add `require(tokenDecimals <= 36)` in `createMarket`.

---

### Pattern 8: Deadline Arithmetic Edge Cases

`renewPosition` (EXNIHILOPool.sol L1006-1010): `base = max(pos.deadline, block.timestamp); newDeadline = base + positionDuration`. `block.timestamp` is within uint32 range (~1.7e9 in 2026). `positionDuration` bounded to <= 365 days = 31,536,000. Max `newDeadline` << uint256.max. No overflow. PASS.

`closePool` (EXNIHILOPool.sol L330): `closeDate = block.timestamp + positionDuration`. Same analysis. No overflow. PASS.

Position deadline at open (EXNIHILOPool.sol L535): `block.timestamp + positionDuration`. No overflow. PASS.

---

### Finding: IA-10 -- Router _positionFee TOCTTOU snapshot leaves USDC sweepable (CONFIRMED NEW)

**Function:** `_positionFee()` at `EXNIHILORouter.sol:L63-81`, called by `openLong` L89, `openShort` L102
**Category:** Time-of-Check-to-Time-of-Use (TOCTTOU) / State Snapshot Race
**Severity:** LOW

**Mechanism:** The router reads `backedAirUsd` and open interest as a view call (T1). The pool independently re-reads the same values during `openLong`/`openShort` execution (T2). Another transaction can change pool state between T1 and T2.

**Case A -- Router overestimates (pool OI decreased between T1 and T2):**
- Router pulls more USDC from caller than pool needs.
- Pool consumes only actual fee; residual stays in router contract.
- `forceApprove(pool, 0)` revokes pool allowance but USDC remains in router.
- Anyone can call `sweep(usdc)` at L142 to claim the residual.
- Original caller loses the fee difference permanently unless they sweep before a bot does.

**Case B -- Router underestimates (OI increased between T1 and T2):**
- Router pulls less USDC than pool needs.
- Pool's `_transferIn` calls `safeTransferFrom(router, pool, totalFee)` but router approved only the smaller amount -- call reverts.
- Transaction fails. No funds lost in this case.

**Severity rationale -- LOW rather than MEDIUM:**
- Fund loss (Case A) requires another position opening on the same pool in the same block (MEV scenario).
- Only the OI-integral impact fee is sensitive to state changes; the base 5% fee is unaffected by TOCTTOU.
- For small positions relative to pool OI, impact fee is negligible and the race error is tiny.
- `renewPosition` wrapper accepts user-specified `fee` with no on-chain computation, creating similar but more explicit caller responsibility.

**Fix -- refund residual USDC to msg.sender after pool call (apply to both openLong and openShort):**
```solidity
function openLong(address pool, uint256 usdcAmount, uint256 minAirTokenOut)
    external nonReentrant onlyPool(pool)
{
    uint256 fee = _positionFee(usdcAmount, pool, true);
    usdc.safeTransferFrom(msg.sender, address(this), fee);
    usdc.forceApprove(pool, fee);
    IEXNIHILOPool(pool).openLong(usdcAmount, minAirTokenOut, msg.sender);
    usdc.forceApprove(pool, 0);
    // Refund any residual left by fee overestimate
    uint256 residual = usdc.balanceOf(address(this));
    if (residual > 0) usdc.safeTransfer(msg.sender, residual);
}
```

This eliminates the griefing vector atomically without changing the caller interface.

---

## Summary

| ID | Finding | Category | Severity | Contract | Line(s) | Status vs 4.6 |
|----|---------|----------|----------|----------|---------|---------------|
| IA-1 | No upper bound on maxPositionUsd | Missing Validation | INFORMATIONAL | EXNIHILOPool | L302, L389 | Confirmed |
| IA-2 | extendDeadline allows past deadline (pool never sends one) | Missing Validation | INFORMATIONAL | PositionNFT | L282-287 | Confirmed |
| IA-3 | Position open fees round down (MIN_POSITION_FEE mitigates) | Rounding | LOW | EXNIHILOPool | L476-491 | Confirmed |
| IA-4 | airTokenMinted in openShort rounds down (ceil-divide at close offsets) | Rounding | INFORMATIONAL | EXNIHILOPool | L727 | Confirmed |
| IA-5 | Zero swap fee for dust swaps (gas cost prevents exploitation) | Dust Amount | INFORMATIONAL | EXNIHILOPool | L1299 | Confirmed |
| IA-6 | Extreme-decimal tokens overflow in _cpAmountOut | Overflow | LOW | EXNIHILOPool | L1299 | Confirmed |
| IA-7 | setDeployer accepts address(0), permanently bricks emergency deployer | Missing Zero-Address Check | MEDIUM | EXNIHILOFactory | L267-270 | NEW |
| IA-8 | closeShort missing airUsdSupply < lockedAmount underflow guard | Arithmetic / Missing Guard | MEDIUM | EXNIHILOPool | L815 | NEW |
| IA-10 | Router _positionFee TOCTTOU snapshot leaves USDC sweepable | TOCTTOU / State Race | LOW | EXNIHILORouter | L63-81, L90, L103 | NEW |

```
Final:  0 CRITICAL | 0 HIGH | 2 MEDIUM | 3 LOW | 4 INFORMATIONAL
```

**Assessment:** The EXNIHILO codebase maintains strong arithmetic safety overall. The two new MEDIUM findings (IA-7, IA-8) are independently reachable but each requires a specific precondition (IA-7: deployer key error or compromise; IA-8: accounting invariant drift). All three new findings are single-line or two-line fixes. The TOCTTOU (IA-10) is low-severity because the race window is narrow and economic loss is bounded by the impact-fee component of the position fee.

Fixes in priority order:
1. **IA-8** -- `closeShort` L815: add `if (airUsdSupply < pos.lockedAmount) revert PositionUnderwater();` (mirrors `_shortIsUnderwater` L1265)
2. **IA-7** -- `setDeployer` L269: add `if (newDeployer == address(0)) revert ZeroAddress();`
3. **IA-10** -- Router: refund residual USDC to `msg.sender` after pool call in `openLong` and `openShort`

---

## Delta vs 4.6

### Confirmed from 4.6 Baseline (IA-1..IA-6)

All six prior findings independently verified against current source with fresh line-number reads. Minor line-number drift of +/-1 in a few places due to source edits between runs. No findings were invalidated or reduced in severity.

### New Findings Added in 4.7 Run

**IA-7 (MEDIUM)** -- `setDeployer` in `EXNIHILOFactory.sol:L269` accepts `address(0)` without revert. Permanently eliminates the emergency deployer path in every pool deployed by this factory once triggered. One-line fix; zero behavior change for valid inputs.

**IA-8 (MEDIUM)** -- `closeShort` in `EXNIHILOPool.sol:L815` computes `airUsdSupply - pos.lockedAmount` without the `airUsdSupply < pos.lockedAmount` guard that `_shortIsUnderwater` applies at L1265. If the subtraction underflows, the position holder's voluntary close path panics with an arithmetic error. The expiry path (`closePositionAfterDeadline` -> `_shortIsUnderwater`) still functions correctly. One-line fix mirrors the existing guard.

**IA-10 (LOW)** -- Router `_positionFee` snapshots pool state (`backedAirUsd`, open interest) as a view call before executing the pool call. Pool state changes between snapshot and execution cause the router to over-pull or under-pull USDC. Residual from over-pull stays in the router and is sweepable by anyone via the public `sweep` function, meaning the caller loses the delta to whichever address calls `sweep` first. Recommended fix: refund residual USDC to `msg.sender` atomically after the pool call.

### Severity Progression (4.6 -> 4.7)

| Severity | 4.6 Count | 4.7 Count | Delta |
|----------|-----------|-----------|-------|
| CRITICAL | 0 | 0 | 0 |
| HIGH | 0 | 0 | 0 |
| MEDIUM | 0 | 2 | +2 (IA-7, IA-8) |
| LOW | 2 | 3 | +1 (IA-10) |
| INFORMATIONAL | 4 | 4 | 0 |
| **Total** | **6** | **9** | **+3** |
