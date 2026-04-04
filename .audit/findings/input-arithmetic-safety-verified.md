# Input & Arithmetic Safety Report — EXNIHILO

## Scope

- **Contracts:** EXNIHILOPool, PositionNFT, EXNIHILOFactory, EXNIHILORouter, LpNFT, AirToken
- **Excluded:** Faucet.sol (testnet-only), test/ directory

---

## Quick Detection Checklist

- [x] Do all public functions validate address parameters against `address(0)`? See Part 1 analysis.
- [x] Do all amount parameters check for `> 0` where zero is invalid? See Part 1 analysis.
- [x] Are array parameters checked for equal lengths and maximum size? **No arrays in public function parameters** (except Factory's string calldata — safe).
- [x] Do all percentage/rate parameters have upper bounds? See Part 1 analysis.
- [x] Is division always performed AFTER multiplication? See Pattern 1 analysis.
- [x] Does rounding favor the protocol? See Pattern 2 analysis.
- [x] Do ERC4626 vaults use virtual shares offset? **No ERC4626 vault in codebase.** N/A.
- [x] Are all downcasts protected? See Pattern 4 analysis.
- [x] Are `unchecked` blocks safe? **No `unchecked` blocks in any core contract.** ✓
- [x] Can fee calculations produce zero for small amounts? See Pattern 6 analysis.

---

## Part 1: Input Validation Analysis

### EXNIHILOPool — Public/External Functions

| Function | Parameter | Validation | Status |
|----------|-----------|-----------|--------|
| `swap` | `amountIn` | `if (amountIn == 0) revert ZeroAmount()` L426 | ✓ |
| `swap` | `recipient` | `if (recipient == address(0)) revert ZeroAddress()` L427 | ✓ |
| `swap` | `minAmountOut` | Used in slippage check — 0 is valid (accept any) | ✓ |
| `openLong` | `usdcAmount` | `if (usdcAmount == 0) revert ZeroAmount()` L469 | ✓ |
| `openLong` | `recipient` | `if (recipient == address(0)) revert ZeroAddress()` L468 | ✓ |
| `openLong` | `minAirTokenOut` | Slippage guard — 0 is valid | ✓ |
| `openShort` | `usdcNotional` | `if (usdcNotional == 0) revert ZeroAmount()` L699 | ✓ |
| `openShort` | `recipient` | `if (recipient == address(0)) revert ZeroAddress()` L698 | ✓ |
| `openShort` | `minAirUsdOut` | Slippage guard — 0 is valid | ✓ |
| `closeLong` | `nftId` | Validated via `positionNFT.ownerOf` + `getPosition` | ✓ |
| `closeLong` | `minUsdcOut` | Slippage guard — 0 is valid | ✓ |
| `closeShort` | `nftId` | Same as closeLong | ✓ |
| `realizeLong` | `nftId` | Same | ✓ |
| `realizeShort` | `nftId` | Same | ✓ |
| `addLiquidity` | `tokenAmount` | `if (tokenAmount == 0 \|\| usdcAmount == 0) revert ZeroAmount()` L909 | ✓ |
| `addLiquidity` | `usdcAmount` | Same check | ✓ |
| `removeLiquidity` | (none) | Checks `openPositionCount == 0`, `backedAirToken/Usd > 0` | ✓ |
| `claimFees` | (none) | `if (amount == 0) revert ZeroAmount()` L970 | ✓ |
| `setPositionCaps` | `newBps` | `if (newBps != 0 && (newBps < 10 \|\| newBps > 9900))` L302 | ✓ |
| `setPositionCaps` | `newUsd` | No upper bound — LP can set any value | See IA-1 |
| `renewPosition` | `nftId` | Validated via `positionNFT.getPosition` | ✓ |
| `closePositionAfterDeadline` | `nftId` | Validated + deadline check | ✓ |
| `closePool` | (none) | `closeDate != 0` check | ✓ |

### EXNIHILOPool Constructor

| Parameter | Validation | Status |
|-----------|-----------|--------|
| All 8 addresses | `!= address(0)` checks L367–374 | ✓ |
| `maxPositionBps_` | `!= 0 && (< 10 \|\| > 9900)` check L375 | ✓ |
| `swapFeeBps_` | `>= BPS_DENOM` check L378 | ✓ |
| `positionDuration_` | `< 1 hours \|\| > 365 days` check L396 | ✓ |
| `maxPositionUsd_` | **No upper bound** — any value accepted | See IA-1 |

### EXNIHILOFactory — createMarket

| Parameter | Validation | Status |
|-----------|-----------|--------|
| `tokenAddress` | **No zero check** — reverts at `safeTransferFrom(address(0))` downstream | INFO (= Nemesis NM-005) |
| `usdcAmount` | **No zero check** — reverts at `addLiquidity(0, ...)` downstream | INFO |
| `tokenAmount` | **No zero check** — same downstream revert | INFO |
| `maxPositionUsd` | No upper bound (same as pool) | See IA-1 |
| `maxPositionBps` | Validated in pool constructor | ✓ |
| `positionDuration` | Validated in pool constructor | ✓ |
| `tokenDecimals` | **No validation against actual token decimals** | INFO |

### EXNIHILORouter — All Functions

| Function | Parameter | Validation | Status |
|----------|-----------|-----------|--------|
| `openLong` | `pool` | `onlyPool(pool)` modifier — checks `factory.isPool(pool)` | ✓ |
| `openLong` | `usdcAmount` | No explicit check — pool checks it | ✓ |
| `openShort` | `pool` | `onlyPool` | ✓ |
| `swap` | `pool` | `onlyPool` | ✓ |
| `renewPosition` | `pool` | `onlyPool` | ✓ |
| `renewPosition` | `fee` | **User-specified** — under-specified reverts in pool, over-specified leaves residual | INFO (= Nemesis NM-003 spirit) |

### PositionNFT

| Function | Parameter | Validation | Status |
|----------|-----------|-----------|--------|
| `initFactory` | `factory_` | Zero check + deployer check + once-only | ✓ |
| `mintLong/mintShort` | `pool` | `msg.sender == pool` + factory check (when factory set) | ⚠️ (= Nemesis NM-001) |
| `release` | `tokenId` | Position exists + `msg.sender == position.pool` | ✓ |
| `extendDeadline` | `tokenId` | Position exists + pool check | ✓ |
| `extendDeadline` | `newDeadline` | **No check that newDeadline > current deadline** | See IA-2 |

### Finding: IA-1 — No upper bound on maxPositionUsd

**Function:** `setPositionCaps()` at `EXNIHILOPool.sol:L301`, constructor L389
**Category:** Missing Validation (bounds)
**Severity:** INFORMATIONAL

**Issue:**
`maxPositionUsd` has no upper bound. The LP holder can set it to `type(uint256).max`, effectively disabling the cap. This is by design — the LP controls their own risk. However, `maxPositionBps` is bounded (10–9900) while `maxPositionUsd` is not, creating an inconsistency.

**Impact:** None — LP sets their own risk parameters. An "infinite" cap is equivalent to no cap, which is the default (0 = disabled).

**Recommendation:** No fix needed. Document that maxPositionUsd=0 means disabled, and any non-zero value is the hard cap.

---

### Finding: IA-2 — extendDeadline allows setting deadline to the past

**Function:** `extendDeadline()` at `PositionNFT.sol:L282–287`
**Category:** Missing Validation
**Severity:** INFORMATIONAL

**Issue:**
`extendDeadline` sets `pos.deadline = newDeadline` without verifying that `newDeadline > pos.deadline` or `newDeadline > block.timestamp`. However, this function is only callable by the pool (`msg.sender == pos.pool`), and the pool's `renewPosition` always computes `newDeadline = base + positionDuration` where `base >= block.timestamp`. So the pool never passes a past deadline.

**Impact:** None — the pool is the sole caller and always passes a valid future deadline. Defense-in-depth only.

**Recommendation:** Optional: add `require(newDeadline > pos.deadline)` in PositionNFT for defense-in-depth.

---

## Part 2: Arithmetic Vulnerability Analysis

### Pattern 1: Division-Before-Multiplication (Precision Loss)

**Systematic scan of all division operations in core contracts:**

| Location | Expression | Division Before Multiplication? | Status |
|----------|-----------|-------------------------------|--------|
| Pool L475 | `(usdcAmount * PROTOCOL_FEE_BPS) / BPS_DENOM` | No — multiply first | ✓ |
| Pool L476 | `(usdcAmount * LP_FEE_BPS) / BPS_DENOM` | No | ✓ |
| Pool L480 | `(MIN_POSITION_FEE * PROTOCOL_FEE_BPS) / (PROTOCOL_FEE_BPS + LP_FEE_BPS)` | No | ✓ |
| Pool L487–488 | `(IMPACT_FEE_BPS * usdcAmount * (2 * longOI + usdcAmount)) / (2 * backedAirUsd * BPS_DENOM)` | No — all multiplies before single divide | ✓ |
| Pool L590 | `(surplus * CLOSE_FEE_BPS) / BPS_DENOM` | No | ✓ |
| Pool L726 | `(usdcNotional * airTokenSupplyBefore) / backedAirUsd` | No | ✓ |
| Pool L819–820 | `(pos.lockedAmount * pos.airTokenMinted + totalBuyable - 1) / totalBuyable` | No — multiply first, ceil-divide | ✓ |
| Pool L915 | `tokenAmount * backedAirUsd` vs `usdcAmount * backedAirToken` | Cross-multiply comparison — no div | ✓ |
| Pool L1061 | `(backedAirUsd * (10 ** uint256(airToken.decimals()))) / backedAirToken` | No — multiply first (view) | ✓ |
| Pool L1092 | `(backedAirUsd * maxPositionBps) / BPS_DENOM` | No | ✓ |
| Pool L1297 | `(amountIn * reserveOut) / (reserveIn + amountIn)` | No | ✓ |
| Pool L1298 | `(amountIn * reserveOut * swapFeeBps) / (reserveIn * BPS_DENOM)` | No | ✓ |
| Router L64–65 | `(notional * PROTOCOL_FEE_BPS) / BPS_DENOM + (notional * LP_FEE_BPS) / BPS_DENOM` | No — each term multiplies first | ✓ |
| Router L78–79 | Same as Pool impact fee | No | ✓ |

**One division-before-multiplication chain to examine:**

`openShort` L726 → L732:
```solidity
uint256 airTokenMinted = (usdcNotional * airTokenSupplyBefore) / backedAirUsd;      // L726
uint256 airUsdOut = _cpAmountOut(airTokenMinted, airTokenSupplyBefore, backedAirUsd); // L732
```

`airTokenMinted` is computed with a division (truncation), then used as input to `_cpAmountOut` which multiplies. This is division-then-multiplication across two lines.

**Impact analysis:**
- Truncation in L726: `airTokenMinted` is at most 1 wei less than the exact value.
- In `_cpAmountOut`: `rawOut = (airTokenMinted * backedAirUsd) / (airTokenSupplyBefore + airTokenMinted)`.
- The 1-wei truncation in airTokenMinted leads to at most 1-wei less rawOut.
- This favors the pool (LP gets slightly more), which is the correct rounding direction for a short open.

**Verdict: Precision loss exists but rounds in the pool's favor (conservative for the short opener). SOUND.**

**Result: NO EXPLOITABLE DIVISION-BEFORE-MULTIPLICATION PATTERNS.**

### Pattern 2: Rounding Direction Analysis

| Operation | Calculation | Rounds | Favors | Correct? |
|-----------|------------|--------|--------|----------|
| **Position open fee** | `(notional * FEE_BPS) / BPS_DENOM` | Down | User (pays less) | ⚠️ See IA-3 |
| **Position open fee (min)** | `if (totalFee < MIN_POSITION_FEE)` floor | Up | Protocol | ✓ |
| **Impact fee** | `(BPS * N * (2OI+N)) / (2 * backed * BPS)` | Down | User (pays less) | ⚠️ See IA-3 |
| **Close fee** | `(surplus * CLOSE_FEE_BPS) / BPS_DENOM` | Down | User (pays less) | ⚠️ Minor |
| **Swap output** | `(amountIn * reserveOut) / (reserveIn + amountIn)` | Down | Pool (user gets less) | ✓ |
| **Swap fee** | `(amountIn * reserveOut * feeBps) / (reserveIn * BPS)` | Down | User (fee lower, user gets more) | Partially offset by rawOut rounding |
| **airTokenMinted (short)** | `(usdcNotional * supply) / backedAirUsd` | Down | User (less debt) | ⚠️ See IA-4 |
| **closeShort cost** | `ceil(locked * debt / totalBuyable)` | **Up** (ceil-divide) | Pool | ✓ |
| **addLiquidity ratio** | Cross-multiply comparison with 0.01% tolerance | N/A | N/A | ✓ |

### Finding: IA-3 — Position open fees round down, favoring user

**Function:** `openLong()` / `openShort()` at `EXNIHILOPool.sol:L475–490, L705–718`
**Category:** Rounding Direction
**Severity:** LOW

**Issue:**
The base fee calculation `(usdcAmount * FEE_BPS) / BPS_DENOM` and impact fee both use floor division, which rounds DOWN. This means the protocol (LP + treasury) collects slightly less than the exact fee percentage. For a single transaction, the loss is at most 1 wei per fee component (3 components = up to 3 wei). Over millions of transactions, this compounds.

**Mathematical Proof:**
```
Input: usdcAmount = 1 (1 wei USDC, extreme edge)
protocolFee = (1 * 200) / 10000 = 0
lpFee       = (1 * 300) / 10000 = 0
totalFee    = 0

MIN_POSITION_FEE = 50000 (0.05 USDC)
Since 0 < 50000: totalFee = 50000

So the minimum fee floor catches the extreme case.
```

```
Input: usdcAmount = 100 (100 wei USDC = 0.0001 USDC)
protocolFee = (100 * 200) / 10000 = 2
lpFee       = (100 * 300) / 10000 = 3
totalFee    = 5

MIN_POSITION_FEE = 50000
Since 5 < 50000: totalFee = 50000

Again caught by the floor.
```

```
Input: usdcAmount = 1_000_000 (1 USDC)
protocolFee = (1000000 * 200) / 10000 = 20000 (0.02 USDC)
lpFee       = (1000000 * 300) / 10000 = 30000 (0.03 USDC)
totalFee    = 50000 (0.05 USDC)

Exactly equals MIN_POSITION_FEE. No rounding loss at this amount.
```

**Impact:** The `MIN_POSITION_FEE = 50_000` (0.05 USDC) floor effectively prevents dust-amount fee evasion. For any practical position size (>= 1 USDC), the rounding loss is negligible (at most 3 wei per fee component = 0.000003 USDC).

**Recommendation:** No fix needed. The MIN_POSITION_FEE floor is an effective countermeasure. For maximum correctness, ceil-divide could be used for fees, but the impact is immaterial.

---

### Finding: IA-4 — airTokenMinted in openShort rounds down, giving user less debt

**Function:** `openShort()` at `EXNIHILOPool.sol:L726`
**Category:** Rounding Direction
**Severity:** INFORMATIONAL

**Issue:**
```solidity
uint256 airTokenMinted = (usdcNotional * airTokenSupplyBefore) / backedAirUsd;
```

This rounds DOWN. The short position's synthetic debt (`airTokenMinted`) is slightly less than exact. At close, the short needs to "buy back" fewer airTokens than the exact amount, giving the user a marginal advantage (less debt to cover = slightly more profit).

**Mathematical Proof:**
```
usdcNotional = 1_000_000 (1 USDC), airTokenSupply = 1e18, backedAirUsd = 1e6
airTokenMinted = (1_000_000 * 1e18) / 1e6 = 1e18 (exact, no truncation)

usdcNotional = 1_000_001, same reserves:
airTokenMinted = (1_000_001 * 1e18) / 1e6 = 1_000_001_000_000_000_000 (exact)

usdcNotional = 999_999, backedAirUsd = 1_000_001:
airTokenMinted = (999_999 * 1e18) / 1_000_001 = 999_998_000_001_999_998 (truncated by ~1 wei)
```

**Impact:** At most 1 wei of airToken debt reduction per position. Over the position's lifetime, the close calculation uses ceil-divide (L820) which rounds UP the cost, offsetting this advantage. Net effect: negligible.

**Recommendation:** No fix needed. The ceil-divide in closeShort (L820) provides the counterbalancing conservative rounding.

---

### Pattern 3: ERC4626 Vault Share Inflation

**Not applicable.** EXNIHILO does not use ERC4626 or any share-based vault pattern. The single-LP NFT model eliminates share inflation attacks entirely.

LP deposits are tracked by `backedAirToken` and `backedAirUsd` (absolute amounts, not shares). There is exactly one LP per pool, so no share dilution is possible.

**Result: N/A — NO VAULT SHARE PATTERN.**

### Pattern 4: Unsafe Integer Casting

**All core contracts use `uint256` for financial calculations.** The only smaller integer types are:

| Location | Cast | Direction | Safe? |
|----------|------|-----------|-------|
| Pool L1061 | `uint256(airToken.decimals())` | uint8 → uint256 | ✓ (widening) |
| Pool L1070 | Same | Same | ✓ |
| Pool L1080 | Same | Same | ✓ |
| PositionNFT L574 | `10 ** uint256(dec)` | uint8 → uint256 | ✓ (widening) |
| PositionNFT L576 | `uint8 show = dec > 4 ? 4 : dec` | uint8 → uint8 | ✓ (same) |
| PositionNFT L577 | `uint256(dec - show)` | uint8 → uint256 | ✓ (show ≤ dec, no underflow) |
| PositionNFT L598–612 | `int256` arithmetic in `_tsToYMD` | int256 only (no mixed sign) | ✓ |

**No downcast (uint256 → smaller) in any core contract.** All casts are widening (safe) or same-size.

The `int256` usage in PositionNFT's `_tsToYMD` (timestamp-to-date converter) is a pure view function for SVG rendering. It operates on calendar math with values well within int256 range.

**Result: NO UNSAFE CASTING.**

### Pattern 5: Unchecked Blocks

**Zero `unchecked` blocks in any core contract.** All arithmetic uses Solidity 0.8.24's default checked math. Overflow/underflow reverts are automatic.

**Result: NO UNCHECKED BLOCK RISK.**

### Pattern 6: Dust Amount Exploitation

**Fee calculations with potential zero-fee outcomes:**

**Position open fees:**
```
protocolFee = (usdcAmount * 200) / 10000
lpFee       = (usdcAmount * 300) / 10000
```

For `usdcAmount < 50` (50 wei = 0.00005 USDC): `protocolFee = 0`, `lpFee = 0`, `totalFee = 0`.

**But:** `MIN_POSITION_FEE = 50_000` (0.05 USDC) kicks in:
```
if (totalFee < MIN_POSITION_FEE) totalFee = MIN_POSITION_FEE;
```

So the minimum fee is **always** at least 0.05 USDC regardless of position size. A 1-wei position would pay 50,000 wei (0.05 USDC) in fees. This makes dust-amount positions economically irrational.

**Swap fees:**
```
fee = (amountIn * reserveOut * swapFeeBps) / (reserveIn * BPS_DENOM)
```

For very small `amountIn`, `fee` can be 0. The user gets a fee-free swap. However:
- `rawOut` is also very small (proportional to `amountIn`)
- Gas cost for the swap transaction vastly exceeds any fee savings
- No compounding: each swap is independent, no accumulation attack

**Close fees:**
```
closeFee = (surplus * CLOSE_FEE_BPS) / BPS_DENOM
```

For `surplus < 100` (100 wei = 0.0001 USDC): `closeFee = 0`. The holder pays zero close fee on tiny profits. Impact: negligible — 0.0001 USDC lost to protocol per position.

**Impact fee with zero OI:**
```
impactFee = (1500 * N * N) / (2 * backedAirUsd * 10000)
```

For the first position (OI = 0), impactFee is quadratic in N. For small N relative to backedAirUsd, impactFee rounds to 0. But MIN_POSITION_FEE already catches this (total fee floored at 0.05 USDC).

### Finding: IA-5 — Zero swap fee for dust-amount swaps

**Function:** `_cpAmountOut()` at `EXNIHILOPool.sol:L1298`
**Category:** Dust Amount Exploitation
**Severity:** INFORMATIONAL

**Issue:**
For sufficiently small `amountIn`, the swap fee rounds to 0:
```
fee = (amountIn * reserveOut * swapFeeBps) / (reserveIn * BPS_DENOM)
```

Example with 1% fee (swapFeeBps=100), reserveIn=1e18, reserveOut=1e6:
```
amountIn = 1e12 (small swap):
fee = (1e12 * 1e6 * 100) / (1e18 * 10000) = 1e20 / 1e22 = 0
rawOut = (1e12 * 1e6) / (1e18 + 1e12) ≈ 1e18/1e18 ≈ 1 (basically zero output)
```

**Impact:** The swap output for dust amounts is also essentially zero, making fee-free dust swaps economically pointless. Gas cost (~$0.01+) far exceeds any fee savings. No viable attack vector.

**Recommendation:** No fix needed. The economic cost of transaction gas prevents dust swap exploitation.

---

### Additional Arithmetic Checks

**Overflow analysis for multiplication chains:**

| Expression | Max Values | Max Product | Within uint256? |
|-----------|-----------|-------------|-----------------|
| `IMPACT_FEE_BPS * usdcAmount * (2 * OI + usdcAmount)` | 1500 × 1e15 × 2e15 | 3e33 | ✓ (limit: ~1.15e77) |
| `amountIn * reserveOut * swapFeeBps` | 1e36 × 1e36 × 1e4 | 1e76 | ✓ (tight but within) |
| `reserveIn * BPS_DENOM` | 1e36 × 1e4 | 1e40 | ✓ |
| `pos.lockedAmount * pos.airTokenMinted` (closeShort) | 1e15 × 1e36 | 1e51 | ✓ |
| `tokenAmount * backedAirUsd` (addLiquidity ratio) | 1e36 × 1e15 | 1e51 | ✓ |

**Edge case: can `amountIn * reserveOut * swapFeeBps` overflow?**

With 18-decimal tokens: `amountIn` up to ~1e30 (1 trillion tokens), `reserveOut` up to ~1e30, `swapFeeBps` up to 9999:
```
1e30 * 1e30 * 9999 ≈ 1e64
```
Within uint256. ✓

With extreme values (e.g., someone creates a pool with a 36-decimal token):
```
1e54 * 1e54 * 9999 ≈ 1e112 > 1.15e77 → OVERFLOW
```

However, such extreme decimals are unrealistic. The factory passes `tokenDecimals` as uint8, capping at 255 decimals. For any token with decimals > ~38, multiplication chains overflow.

### Finding: IA-6 — Extreme-decimal tokens can cause overflow in _cpAmountOut

**Function:** `_cpAmountOut()` at `EXNIHILOPool.sol:L1298`
**Category:** Overflow
**Severity:** LOW

**Issue:**
If a market is created with a token having extremely high decimals (>38), the multiplication `amountIn * reserveOut * swapFeeBps` in `_cpAmountOut` can overflow uint256, reverting the transaction.

**Mathematical Proof:**
```
Token with 45 decimals, reserves of 1e45 each:
amountIn = 1e45, reserveOut = 1e45, swapFeeBps = 100:
1e45 * 1e45 * 100 = 1e92 > ~1.15e77 → overflow → revert
```

**Impact:** The pool would be non-functional for swaps and position opens. But the market creator chose this token — they created an unusable pool. No fund loss (addLiquidity would succeed but swaps would revert).

**Practical concern:** Standard tokens use 0–18 decimals. Even 36-decimal tokens (rare) would work fine (1e36 * 1e36 * 1e4 = 1e76 < 1.15e77). Only pathological tokens with 39+ decimals trigger this.

**Recommendation:** Optional: add a check in `createMarket` that `tokenDecimals <= 36` or similar reasonable bound.

---

## Summary

| ID | Finding | Category | Severity |
|----|---------|----------|----------|
| IA-1 | No upper bound on maxPositionUsd | Missing Validation | INFO |
| IA-2 | extendDeadline allows past deadline (pool never sends one) | Missing Validation | INFO |
| IA-3 | Position open fees round down (mitigated by MIN_POSITION_FEE) | Rounding | LOW |
| IA-4 | airTokenMinted in openShort rounds down (offset by ceil-divide at close) | Rounding | INFO |
| IA-5 | Zero swap fee for dust amounts (gas cost prevents exploitation) | Dust Amount | INFO |
| IA-6 | Extreme-decimal tokens overflow in _cpAmountOut | Overflow | LOW |

```
Final:  0 CRITICAL | 0 HIGH | 0 MEDIUM | 2 LOW | 4 INFORMATIONAL
```

**Assessment:** The EXNIHILO codebase demonstrates strong arithmetic safety:
- **No `unchecked` blocks** — full Solidity 0.8.24 checked math
- **No unsafe downcasts** — all casts are widening (uint8 → uint256)
- **No division-before-multiplication** in any exploitable context
- **MIN_POSITION_FEE floor** prevents dust-amount fee evasion on positions
- **Ceil-divide in closeShort** (L820) provides conservative rounding for the pool
- **Cross-multiply ratio check** in addLiquidity avoids precision loss entirely
- **No ERC4626 vault** — single-LP model eliminates share inflation attack surface
