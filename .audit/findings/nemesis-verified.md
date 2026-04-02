# NEMESIS Audit Report -- EXNIHILO Protocol

**Auditor**: Nemesis Pipeline (Feynman + State-Inconsistency Fusion)
**Date**: 2026-04-02
**Scope**: All production contracts in `packages/blockchain/contracts/`
**Commit**: HEAD of `main`

---

## Executive Summary

This report covers findings from the full Nemesis audit pipeline (Phase 0--7) applied to the EXNIHILO protocol. All previously-reported and fixed issues (M-1 through I-4) are excluded. The audit traced every state-variable mutation, every coupled-state pair, every AMM formula application, and every exit path in the position lifecycle (open, renew, close, realize, forceRealize, liquidateExpired) across all six contracts.

**Two new findings** were identified:

| ID | Severity | Title |
|----|----------|-------|
| N-1 | **Medium** | Short close/liquidate SWAP-2 reserve double-counts locked airUsd, systematically undervaluing short positions |
| N-2 | **Low** | `renewPosition` uses `lockedAmount` instead of `usdcIn` for short notional, undercharging renewal fees |

---

## N-1: Short Close Reserve Double-Counts Locked airUsd (Medium)

### Summary

When closing or liquidating a short position, the SWAP-2 inverse computation includes the position's own locked airUsd in the `reserveIn` denominator. This is asymmetric with the long-close path, which correctly excludes the locked airToken from the reserve. The bug causes short positions to receive less value than they should, making shorts systematically harder to close profitably and easier to declare underwater.

### Severity Justification

Medium. This directly affects user funds: profitable short positions receive less USDC on close than the AMM math warrants. Positions that should be profitable may incorrectly appear underwater, blocking voluntary close and enabling premature force-realization or underwater liquidation (zero payout to the holder). The magnitude scales with position size relative to `airUsdToken.totalSupply()`.

### Root Cause

The AMM defines three modes:

```
SWAP-2:  reserveIn = airUsd.totalSupply(),  reserveOut = backedAirToken
SWAP-3:  reserveIn = airToken.totalSupply(), reserveOut = backedAirUsd
```

When closing a long (SWAP-3), the code correctly recognizes that the position's locked airToken is in the PositionNFT, not in the pool's trading reserve, and subtracts it:

```solidity
// closeLong (line 611-614) -- CORRECT
uint256 airUsdOut = _cpAmountOut(
    pos.lockedAmount,
    airTokenSupply - pos.lockedAmount,  // <-- excludes locked from reserve
    backedAirUsd
);
```

This gives the correct denominator: `(supply - locked) + locked = supply`.

When closing a short (SWAP-2 inverse), the code does NOT exclude the locked airUsd:

```solidity
// closeShort (line 836-840) -- BUG
uint256 totalBuyable = _cpAmountOut(
    pos.lockedAmount,
    airUsdToken.totalSupply(),  // <-- includes locked airUsd!
    backedAirToken
);
```

This gives an inflated denominator: `totalSupply() + lockedAmount` instead of `totalSupply()`.

The same incorrect formula appears in:

1. **`closeShort`** -- line 836-840
2. **`_shortIsUnderwater`** -- line 1417-1421
3. **`_liquidateExpiredShort`** (profitable branch) -- line 1366-1370
4. **`PositionNFT._readLive`** (short PnL display) -- line 322

### Affected Code Locations

| File | Function | Line(s) |
|------|----------|---------|
| `EXNIHILOPool.sol` | `closeShort` | 836-840 |
| `EXNIHILOPool.sol` | `_shortIsUnderwater` | 1415-1422 |
| `EXNIHILOPool.sol` | `_liquidateExpiredShort` | 1366-1370 |
| `PositionNFT.sol` | `_readLive` | 322 |

### Mathematical Proof

Let `L = pos.lockedAmount`, `S = airUsdToken.totalSupply()`, `B = backedAirToken`.

**Correct CP output** (what closeLong does for its side):
```
reserveIn = S - L      (exclude locked from reserve)
amountIn  = L          (locked being returned)
denominator = (S - L) + L = S
amountOut = L * B / S
```

**Current code** (what closeShort does):
```
reserveIn = S          (includes locked -- WRONG)
amountIn  = L
denominator = S + L
amountOut = L * B / (S + L)
```

**Ratio of current to correct**:
```
(L * B / (S + L)) / (L * B / S) = S / (S + L)
```

The current code returns `S / (S + L)` fraction of the correct value. For a position where locked collateral is 10% of total airUsd supply, the short holder receives ~91% of correct value. For 50% of supply, only ~67%.

### Trigger Sequence

1. LP creates a pool with 1,000,000 USDC and equivalent tokens.
2. Trader opens a short with `usdcNotional = 100,000`. This locks, say, 95,000 airUsd in the NFT.
3. Token price drops (short becomes profitable).
4. Trader calls `closeShort`. The `totalBuyable` is computed with `airUsdToken.totalSupply()` (which includes the 95,000 locked), giving a smaller output than the correct `totalSupply() - 95,000` would.
5. Trader receives less USDC profit than the symmetric long-close formula would provide.

Alternatively:
1. Same setup. Token price moves slightly against the short.
2. `_shortIsUnderwater` uses the inflated denominator, declaring the position underwater when it would be profitable under the correct formula.
3. LP calls `forceRealize`, force-realizing a position that should not be eligible.

### Recommended Fix

Apply the same exclusion pattern used in `closeLong` to all short close paths:

```solidity
// closeShort -- fix
uint256 airUsdSupply = airUsdToken.totalSupply();
uint256 totalBuyable = _cpAmountOut(
    pos.lockedAmount,
    airUsdSupply - pos.lockedAmount,  // <-- exclude locked from reserve
    backedAirToken
);

// _shortIsUnderwater -- fix
function _shortIsUnderwater(Position memory pos) internal view returns (bool) {
    uint256 airUsdSupply = airUsdToken.totalSupply();
    return _cpAmountOut(
        pos.lockedAmount,
        airUsdSupply - pos.lockedAmount,  // <-- exclude locked from reserve
        backedAirToken
    ) < pos.airTokenMinted;
}

// _liquidateExpiredShort -- fix (profitable branch)
uint256 airUsdSupply = airUsdToken.totalSupply();
uint256 totalBuyable = _cpAmountOut(
    pos.lockedAmount,
    airUsdSupply - pos.lockedAmount,  // <-- exclude locked from reserve
    backedAirToken
);
```

And in `PositionNFT._readLive`:
```solidity
// Short PnL -- fix
uint256 totalBuyable = _cpOut(
    pos.lockedAmount,
    airUsdSup - pos.lockedAmount,  // <-- exclude locked from reserve
    bam,
    swapFee
);
```

### Verification

After the fix, the symmetry between long and short close paths should be verified:
- `closeLong` uses `airTokenSupply - pos.lockedAmount` as reserveIn. CHECK.
- `closeShort` uses `airUsdSupply - pos.lockedAmount` as reserveIn. CHECK.
- Both result in a CP denominator equal to the total supply of the respective token.
- All test cases for short close/liquidation should be updated to reflect the corrected output values.

---

## N-2: Short Renewal Fee Uses `lockedAmount` Instead of `usdcIn` (Low)

### Summary

`renewPosition` computes the renewal fee as 5% of the position's "notional." For longs, it correctly uses `pos.airUsdMinted` (which equals the original `usdcAmount`). For shorts, it uses `pos.lockedAmount` (the airUsd actually locked in the NFT), which is always less than `pos.usdcIn` (the original USDC notional) due to AMM slippage and swap fees during the open.

### Severity Justification

Low. This is a fee under-collection issue, not a loss-of-funds vulnerability. Short position holders pay less to renew than the equivalent long position of the same notional size. The LP and protocol receive less revenue than intended. The magnitude is proportional to the AMM slippage at open time, typically 1--5% depending on position size relative to reserves.

### Root Cause

```solidity
// renewPosition (line 1053)
uint256 notional = pos.isLong ? pos.airUsdMinted : pos.lockedAmount;
```

For a long position opened with `usdcAmount`:
- `pos.airUsdMinted = usdcAmount` (the synthetic debt equals the notional). Correct.

For a short position opened with `usdcNotional`:
- `pos.usdcIn = usdcNotional` (the original notional)
- `pos.lockedAmount = airUsdOut` (the CP output of SWAP-3, always < `usdcNotional`)

The code uses `pos.lockedAmount` instead of `pos.usdcIn`. The comment says "5% of original notional" but the short path does not use the original notional.

### Affected Code Location

| File | Function | Line |
|------|----------|------|
| `EXNIHILOPool.sol` | `renewPosition` | 1053 |

### Numerical Example

- Pool: 1,000,000 USDC / 1,000,000 tokens, 1% swap fee.
- Long opened with `usdcAmount = 100,000`. `pos.airUsdMinted = 100,000`.
  - Renewal fee: 5% of 100,000 = 5,000 USDC.
- Short opened with `usdcNotional = 100,000`. SWAP-3 yields `airUsdOut ~ 89,000` (after slippage + fee).
  - `pos.usdcIn = 100,000`, `pos.lockedAmount = 89,000`.
  - Renewal fee: 5% of 89,000 = 4,450 USDC (11% less than the long).

Both positions have the same notional exposure, but the short pays less to renew.

### Recommended Fix

```solidity
// renewPosition -- fix line 1053
uint256 notional = pos.isLong ? pos.airUsdMinted : pos.usdcIn;
```

This uses the original USDC notional for both sides, matching the comment's intent ("5% of original notional") and creating symmetry with the long path.

---

## Additional Observations (Informational, No Action Required)

### I-1: Position NFT `feesPaid` Not Updated on Renewal

When `renewPosition` is called, the position's `feesPaid` field in the PositionNFT is not updated. The on-chain NFT metadata always shows only the initial open fee, not cumulative fees including renewals. This affects display only and has no impact on settlement math. The actual fee is captured in the `PositionRenewed` event.

### I-2: Close Fee Entirely to Protocol

The 1% close fee on profitable position exits (`CLOSE_FEE_BPS = 100`) goes entirely to `protocolTreasury`. The LP receives no share of this fee. This is a design choice, not a bug, but worth noting since the LP bears the price risk that makes positions profitable.

---

## Audit Methodology

### Phase 0: Scope Enumeration
All six production contracts read in full:
- `EXNIHILOPool.sol` (1512 lines) -- Core AMM + leveraged position engine
- `EXNIHILOFactory.sol` (388 lines) -- Permissionless pool deployer
- `EXNIHILORouter.sol` (124 lines) -- Fee-forwarding router
- `PositionNFT.sol` (560 lines) -- Position collateral custody as ERC-721
- `LpNFT.sol` (76 lines) -- LP ownership NFT
- `AirToken.sol` (93 lines) -- Pool-controlled ERC-20 wrapper

### Phase 1: Feynman Audit (Line-by-Line Questioning)
Every line of every function was questioned:
- Why is this guard present? Is it sufficient?
- What happens if this value is 0, max, or adversarial?
- Does this computation match its documentation?
- Is this the same formula used in the symmetric counterpart function?

The Feynman pass surfaced the asymmetric reserve treatment between `closeLong` (subtracts locked) and `closeShort` (does not subtract locked).

### Phase 2: State-Inconsistency Audit
All coupled state pairs traced through every mutation path:
- `backedAirToken` / `airToken.totalSupply()` -- 14 mutation points, all consistent
- `backedAirUsd` / `airUsdToken.totalSupply()` -- 16 mutation points, all consistent
- `openPositionCount` -- 12 mutation points (6 increments, 6 decrements), all paired
- `longOpenInterest` -- 6 mutation points, all consistent (add at open = subtract at close)
- `shortOpenInterest` -- 6 mutation points, all consistent
- `lpFeesAccumulated` -- 3 increment points, 1 decrement point, USDC solvency verified

### Phase 3: Cross-Function Interaction Analysis
Every pair of state-changing functions analyzed for interference:
- openLong + closeShort (shared `backedAirToken` dependency)
- openShort + closeLong (shared `backedAirUsd` dependency)
- Multiple concurrent positions (open/close ordering effects)
- addLiquidity during open positions
- claimFees solvency with outstanding positions
- renewPosition + liquidateExpired race conditions

### Phase 4: AMM Math Verification
All three AMM modes verified for:
- Correct reserve selection per mode definition
- Consistent denominator computation (reserveIn + amountIn)
- Fee application symmetry
- Overflow/underflow safety for realistic parameter ranges
- Rounding direction (truncation favors pool in all cases)

This phase identified the N-1 denominator asymmetry.

### Phase 5: Position Lifecycle End-to-End
Every exit path for both longs and shorts:
- open -> close (profitable)
- open -> close (underwater revert)
- open -> realize
- open -> forceRealize (underwater)
- open -> liquidateExpired (profitable)
- open -> liquidateExpired (underwater)
- open -> renew -> close
- open -> renew -> liquidateExpired

All paths verified for:
- backedAirToken/backedAirUsd net-zero round-trip
- airToken/airUsd totalSupply net-zero round-trip
- USDC balance solvency
- openPositionCount correct decrement
- OI correct decrement (using same value that was added)

### Phase 6: Fee Accounting Verification
- Position open fee: pull totalFee, send protocolFee, accumulate lpFee. USDC retained = lpFee. Correct.
- Position close fee: deducted from surplus. Goes to protocolTreasury. Not accumulated as LP fee. Correct by design.
- Renewal fee: pull totalFee, send protocolFee, accumulate lpFee. But short notional uses lockedAmount instead of usdcIn (N-2).
- Swap fee: retained passively in backedAirUsd/backedAirToken. Not accumulated separately. Correct.
- Impact fee: integral formula verified as split-proof. Added to lpFee. Correct.

### Phase 7: Fusion & Verification
The Feynman finding (N-1) was cross-validated against:
- The state-inconsistency audit (confirmed the asymmetry is not compensated elsewhere)
- The AMM math verification (confirmed the denominator error)
- The position lifecycle analysis (confirmed all four affected code paths)
- The PositionNFT display logic (confirmed the same bug in PnL computation)

---

## Files Reviewed

| File | Path |
|------|------|
| EXNIHILOPool.sol | `packages/blockchain/contracts/EXNIHILOPool.sol` |
| EXNIHILOFactory.sol | `packages/blockchain/contracts/EXNIHILOFactory.sol` |
| EXNIHILORouter.sol | `packages/blockchain/contracts/EXNIHILORouter.sol` |
| PositionNFT.sol | `packages/blockchain/contracts/PositionNFT.sol` |
| LpNFT.sol | `packages/blockchain/contracts/LpNFT.sol` |
| AirToken.sol | `packages/blockchain/contracts/AirToken.sol` |
