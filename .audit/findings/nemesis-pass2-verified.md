# EXNIHILO Nemesis Audit -- Pass 2 (Verified)

**Auditor:** Claude Opus 4.6 (Nemesis methodology)
**Date:** 2026-04-02
**Scope:** EXNIHILOPool.sol, EXNIHILOFactory.sol, EXNIHILORouter.sol, PositionNFT.sol, LpNFT.sol, AirToken.sol
**Methodology:** Full 8-phase Nemesis audit (Phase 0 through 7). Every line of every production contract was read and traced. All 6 exit paths were cross-traced for state consistency. Multi-transaction attack sequences were explored. USDC solvency was verified across every operation. The N-1 fix was independently validated. Router fee replication was verified formula-by-formula.

---

## Summary of New Findings

| ID | Severity | Title |
|----|----------|-------|
| N2-M1 | Medium | Router has no mechanism to recover ERC-20 tokens sent to it accidentally |
| N2-L1 | Low | `closeShort` proportional cost approximation systematically overcharges short holders |
| N2-L2 | Low | `renewPosition` callable by anyone enables third-party grief of expiry-based liquidation |
| N2-L3 | Low | `LongClosed` event under-reports total airUsd burned |
| N2-L4 | Low | `PositionNFT._readLive` short PnL display can show positive PnL for zero-profit positions |
| N2-I1 | Informational | `openPositionCount` does not distinguish longs from shorts |
| N2-I2 | Informational | No on-chain view function for quoting position-open fees (including impact) |
| N2-I3 | Informational | `setPositionCaps` emits event even when values are unchanged |

---

## Phase 0: Invariant Identification and Verification

Five core invariants were identified. Every code path (13 state-changing operations) was traced to confirm they hold.

### Invariant 1 -- Reserve Ceiling

```
backedAirToken <= airToken.totalSupply()
backedAirUsd   <= airUsdToken.totalSupply()
```

Enforced by `_assertReserveInvariant()` at the end of every state-changing function. **Verified: Holds across all 13 code paths.**

### Invariant 2 -- USDC Solvency

The pool's actual USDC balance >= `backedAirUsd + lpFeesAccumulated`.

| Operation | USDC delta | backedAirUsd delta | lpFees delta | Balanced? |
|-----------|------------|--------------------|--------------|-----------|
| addLiquidity | +usdcAmount | +usdcAmount | 0 | Yes |
| swapTokenToUsdc | -netOut | -netOut | 0 | Yes |
| swapUsdcToToken | +amountIn | +amountIn | 0 | Yes |
| openLong | +lpFee | 0 | +lpFee | Yes |
| openShort | +lpFee | -airUsdOut | +lpFee | Creates excess = airUsdOut |
| closeLong | -surplus | -surplus | 0 | Yes |
| closeShort | -surplus | +costForDebt | 0 | Consumes excess |
| realizeLong | +airUsdMinted | +airUsdMinted | 0 | Yes |
| realizeShort | -lockedAmount | 0 | 0 | Consumes excess |
| forceRealizeLong | +airUsdMinted | +airUsdMinted | 0 | Yes |
| forceRealizeShort | -lockedAmount | 0 | 0 | Consumes excess |
| liqExpLong (profit) | -surplus | -surplus | 0 | Yes |
| liqExpLong (underwater) | 0 | 0 | 0 | Yes |
| liqExpShort (profit) | -surplus | +costForDebt | 0 | Consumes excess |
| liqExpShort (underwater) | 0 | +lockedAmount | 0 | Consumes excess |
| claimFees | -amount | 0 | -amount | Yes |

The "excess" from openShort corresponds to the locked airUsd in PositionNFT. It is always consumed by exactly one of the short's exit paths. **Verified: Holds in all cases.**

### Invariant 3 -- Position Counter Consistency

Every `openPositionCount++` at open is matched by exactly one `openPositionCount--` in one of the 6 exit paths: closeLong (line 623), closeShort (line 855), realizeLong (line 674), realizeShort (line 897), forceRealize (lines 1263/1295), liquidateExpired (lines 1324/1366). **Verified.**

### Invariant 4 -- Open Interest Tracking

`longOpenInterest` incremented by `usdcAmount` at openLong, decremented by `pos.airUsdMinted` (= usdcAmount) at all long exits. `shortOpenInterest` incremented by `usdcNotional` at openShort, decremented by `pos.usdcIn` (= usdcNotional) at all short exits. **Verified across all exit paths.**

### Invariant 5 -- Pool airToken/airUsd Token Balance Sufficiency

The pool must hold enough airToken and airUsd ERC-20 tokens to execute any burn. Verified by tracing the pool's token balance through all operations:

- For airUsd burn at closeLong (`pos.airUsdMinted + surplus`): the pool holds at least `pos.airUsdMinted` (from synthetic mint at openLong) plus sufficient backed airUsd for the surplus (because surplus < backedAirUsd, and swap-driven burns are bounded by backedAirUsd underflow protection). **Verified.**
- For airToken burn at closeShort/liquidateExpiredShort (`pos.airTokenMinted`): the pool holds at least `pos.airTokenMinted` (from synthetic mint at openShort). Swap-driven burns are bounded by backedAirToken underflow protection. **Verified.**

---

## Phase 1: N-1 Fix Verification

The N-1 fix subtracts `pos.lockedAmount` from `airUsdToken.totalSupply()` in four locations: `closeShort` (line 842), `_shortIsUnderwater` (line 1428), `_liquidateExpiredShort` (line 1374), and `PositionNFT._readLive` (line 323).

### Why the fix is correct

The SWAP-2 constant-product formula for closeShort is:

```
totalBuyable = cpOut(lockedAmount, reserveIn, backedAirToken)
```

The locked airUsd held by PositionNFT is the **amountIn** being fed into the swap. It must NOT be counted as part of **reserveIn** (the existing pool liquidity). Before the fix, `reserveIn = airUsdToken.totalSupply()` incorrectly included the amountIn itself, making the pool appear deeper than it is and underpricing the cost of debt buyback.

This is symmetric with closeLong's SWAP-3, which subtracts `pos.lockedAmount` from `airToken.totalSupply()` (line 613).

### Edge case analysis

| Question | Answer |
|----------|--------|
| Can `airUsdSupply - pos.lockedAmount` underflow? | No. PositionNFT holds pos.lockedAmount of airUsd tokens as part of totalSupply. |
| Should other shorts' locked airUsd also be subtracted? | No. Only the current position's lock is the amountIn. Other locks are part of the supply context, same as closeLong not subtracting other longs' locked airToken. |
| Is the fix applied consistently? | Yes. All 4 locations apply the same subtraction. |
| Does the fix introduce any new invariant violation? | No. Post-subtraction values are always non-negative, and the reserve ceiling invariant holds. |

**Verdict: N-1 fix is correct and complete. No new edge cases introduced.**

---

## Phase 2--3: Cross-Function State Consistency and Attack Sequences

### Exit Path Matrix

All state variables traced per exit path:

| Exit Path | posCount | OI delta | backedAirToken | backedAirUsd | airToken burn | airUsd burn |
|-----------|----------|----------|----------------|--------------|---------------|-------------|
| closeLong | -1 | long -= debt | += locked | -= surplus | none | debt + surplus |
| closeShort | -1 | short -= usdcIn | none | += costForDebt | debt | surplus |
| realizeLong | -1 | long -= debt | none | += debt | locked | none |
| realizeShort | -1 | short -= usdcIn | += debt | none | none | locked |
| forceRealizeLong | -1 | long -= debt | none | += debt | locked | none |
| forceRealizeShort | -1 | short -= usdcIn | += debt | none | none | locked |
| liqExpLong (profit) | -1 | long -= debt | += locked | -= surplus | none | debt + surplus |
| liqExpLong (underwater) | -1 | long -= debt | += locked | none | none | debt only |
| liqExpShort (profit) | -1 | short -= usdcIn | none | += costForDebt | debt | surplus |
| liqExpShort (underwater) | -1 | short -= usdcIn | none | += locked | debt | none |

**All paths are internally consistent.** No cross-function state desynchronization found.

### Multi-Transaction Attack Sequences Explored

**Sequence 1: Open long A, open long B, swap to tank price, close B, close A.**
Each close uses the current `airToken.totalSupply()` which includes both positions' locked tokens. Pricing is correct per SWAP-3 model. No exploit.

**Sequence 2: Open short A, open short B, close A.**
Short A's close subtracts only its own lock from airUsd supply. Short B's lock remains counted in the reserve. This is by design -- the reserves include all supply except the amountIn.

**Sequence 3: Open long, LP adds liquidity, close long.**
The surplus increases because backedAirUsd (reserveOut in SWAP-3) is larger. This benefits the long holder. The LP voluntarily added liquidity. Not exploitable.

**Sequence 4: Open 100 tiny 1-USDC positions to accumulate OI cheaply.**
Each pays MIN_POSITION_FEE (0.05 USDC) plus 5% base. Total cost for 100 USDC OI: at least 5 USDC in base fees. The impact fee on the 101st position (also 1 USDC) would be ~0.0015 USDC. Negligible manipulation benefit vs. fee cost.

**Sequence 5: Sandwich `liquidateExpired` with price manipulation.**
The minPayout parameter protects the liquidator. Standard AMM MEV concern, not a contract bug.

**Sequence 6: Open long, wait for underwater, someone renews, LP cannot liquidate.**
See finding N2-L2. LP can still use forceRealize as escape hatch.

---

## Phase 4--7: Findings

---

### N2-M1: Router lacks sweep function -- tokens sent accidentally are permanently locked

**Severity:** Medium
**File:** `EXNIHILORouter.sol` (entire contract)
**Category:** Permanent fund lock

#### Description

The Router contract handles USDC and underlying tokens via `safeTransferFrom` / `forceApprove` for each operation. After each operation, residual approvals are cleared to zero. In normal operation, no tokens remain in the Router.

However, the Router has no `sweep()` or `rescue()` function, no admin role, and no mechanism to recover ERC-20 tokens sent directly to its address. If a user or integration accidentally sends USDC or any ERC-20 to the Router via a plain `transfer()` (not through the Router's functions), those tokens are permanently locked.

This is a well-known concern for immutable router contracts. Uniswap V2 Router, for example, has the same limitation but is documented. Notable DeFi protocols that fixed this pattern include Sushiswap and Balancer V2, which include permissioned rescue functions.

#### Impact

No user funds at risk during normal operation. However:
1. Tokens sent to the Router by mistake (human error, buggy frontend, contract integration) are permanently unrecoverable.
2. If any future upgrade changes pool fee constants without updating the Router, fee mismatches could cause dust accumulation with no recovery path.

#### Proof of concept

```
// User accidentally does this:
usdc.transfer(routerAddress, 1000e6);  // 1000 USDC permanently locked
```

#### Recommendation

Add a permissioned sweep function:

```solidity
address public immutable rescuer;

constructor(address factory_, address usdc_, address rescuer_) {
    factory = IEXNIHILOFactory(factory_);
    usdc = IERC20(usdc_);
    rescuer = rescuer_;
}

function sweep(IERC20 token, address to) external {
    require(msg.sender == rescuer, "Only rescuer");
    token.safeTransfer(to, token.balanceOf(address(this)));
}
```

---

### N2-L1: `closeShort` proportional cost approximation systematically overcharges short holders

**Severity:** Low
**File:** `EXNIHILOPool.sol` lines 847--848, 1377--1378
**Category:** Economic / Precision

#### Description

The short close mechanism uses a proportional approximation to compute the airUsd cost of buying back the airToken debt:

```solidity
uint256 airUsdCostForDebt =
    (pos.lockedAmount * pos.airTokenMinted + totalBuyable - 1) / totalBuyable;
```

The code comments acknowledge this is conservative: "Because cpAmountOut is concave, the proportional estimate overestimates the true cost." The ceiling division adds further upward bias.

The exact inverse CP cost would be:
```
exactCost = reserveIn * airTokenMinted / (reserveOut - airTokenMinted)
```

The proportional approximation overestimates this, reducing the short holder's surplus (profit).

#### Quantitative analysis

The overestimation is most pronounced when `pos.airTokenMinted` approaches `totalBuyable` (barely profitable short). For a short with `lockedAmount = 1_000_000` (1 USDC) and `totalBuyable` only 0.01% above `airTokenMinted`, the cost overestimate can eat nearly all the surplus. For typical positions with healthy margins (totalBuyable >> airTokenMinted), the overestimate is a rounding-level fraction of the surplus.

#### Impact

**Low.** The overestimation always favors the pool (conservative). No exploit risk. The short holder receives slightly less than the theoretical maximum surplus. The difference is material only for positions that are barely profitable, where the surplus itself is small.

#### Recommendation

This is a documented design choice. Consider either:
1. Using the exact inverse formula for precision.
2. Documenting the maximum overestimate percentage in the natspec.

---

### N2-L2: `renewPosition` callable by anyone enables expiry-liquidation griefing

**Severity:** Low
**File:** `EXNIHILOPool.sol` lines 1053--1081
**Category:** Griefing / Economic

#### Description

`renewPosition` is deliberately callable by anyone. This enables a griefing vector where a third party can prevent `liquidateExpired` from executing by front-running it with a renewal.

#### Attack sequence

1. Position P is expired and underwater.
2. LP or keeper calls `liquidateExpired(P, 0)`.
3. Attacker front-runs with `renewPosition(P)`, paying the 5% base fee of P's notional.
4. `liquidateExpired` reverts with `PositionNotExpired()`.
5. Repeat indefinitely (attacker pays 5% per renewal period).

#### Impact

**Low.** The LP retains the `forceRealize` escape hatch for underwater positions, which cannot be blocked by renewal. The griefing cost is 5% of the position's notional per period (1 hour to 1 year). However, `forceRealize` requires the LP to pay the full synthetic debt in real tokens, which is more expensive than the free cleanup path of `liquidateExpired`. An attacker can force the LP to use the costlier exit path.

Note that the attacker's renewal fees go to the LP (3%) and protocol (2%), so the attacker is paying the LP to grief them. This limits the economic rationality of the attack.

#### Recommendation

Consider restricting renewal to the position holder and LP:

```solidity
address holder = positionNFT.ownerOf(nftId);
if (msg.sender != holder && msg.sender != lpNftContract.ownerOf(lpNftId))
    revert Unauthorized();
```

---

### N2-L3: `LongClosed` event under-reports total airUsd burned

**Severity:** Low
**File:** `EXNIHILOPool.sol` line 644
**Category:** Event accuracy

#### Description

The `LongClosed` event emits `pos.airUsdMinted` as the `airUsdBurned` field:

```solidity
emit LongClosed(nftId, holder, netSurplus, pos.airUsdMinted);
```

But closeLong actually burns `pos.airUsdMinted + surplus` of airUsd (line 636: synthetic debt burn, line 638: backed surplus burn). The event only reports the synthetic debt portion.

#### Impact

Off-chain indexers tracking airUsd supply changes from events will undercount burns by `surplus` per closeLong. The same under-reporting occurs in `_liquidateExpiredLong`'s profitable branch. Does not affect on-chain correctness.

#### Recommendation

Either emit `pos.airUsdMinted + surplus` as the burned field, or rename the event parameter to `syntheticDebtBurned` to clarify its semantics.

---

### N2-L4: `PositionNFT._readLive` short PnL display can show positive PnL for zero-profit positions

**Severity:** Low
**File:** `PositionNFT.sol` lines 325--336
**Category:** Display / UX

#### Description

When `totalBuyable` exceeds `pos.airTokenMinted` by a single unit, the ceiling-division cost is `lockedAmount - 1`, giving surplus = 1 (1 unit of airUsd = $0.000001). The close fee on surplus of 1 is 0 (truncated). The NFT displays "+$0.00" (pnlPositive = true) when the actual closeable profit is effectively zero.

This is cosmetic only and does not affect on-chain settlement. The pool would allow closing the position (netSurplus >= minUsdcOut with minUsdcOut = 0), but the holder receives $0.000001.

#### Recommendation

Add a minimum display threshold (e.g., `if (pnlAbs < 1e4) { pnlPositive = false; pnlAbs = 0; }`).

---

### N2-I1: `openPositionCount` does not distinguish longs from shorts

**Severity:** Informational
**File:** `EXNIHILOPool.sol` line 222

Only one counter tracks all positions. Off-chain consumers cannot determine the long/short split without replaying all position lifecycle events. Consider adding `openLongCount` and `openShortCount` storage variables.

---

### N2-I2: No on-chain view function for quoting position-open fees including impact

**Severity:** Informational
**File:** `EXNIHILOPool.sol`

The pool provides `quoteSwap()` for swap quotes but no equivalent for position-open fee quotes. The Router's `_positionFee()` is internal. Frontend developers must replicate the impact fee formula off-chain, which is error-prone (especially the OI-integral formula).

**Recommendation:** Add a public view:
```solidity
function quotePositionFee(uint256 notional, bool isLong)
    external view returns (uint256 totalFee, uint256 protocolFee, uint256 lpFee, uint256 impactFee);
```

---

### N2-I3: `setPositionCaps` emits event even when values are unchanged

**Severity:** Informational
**File:** `EXNIHILOPool.sol` lines 359--364

No check for whether `newUsd == maxPositionUsd && newBps == maxPositionBps`. Emits `PositionCapsUpdated` unconditionally. This creates event noise for unchanged calls.

---

## Phase 5: Router Fee-Replication Verification

The Router's `_positionFee` (lines 62--79) was compared formula-by-formula against the Pool's fee computation in `openLong` (lines 502--518) and `openShort` (lines 732--746):

| Component | Router formula | Pool formula | Match? |
|-----------|----------------|--------------|--------|
| Protocol fee | `(N * 200) / 10000` | `(N * 200) / 10000` | Exact |
| LP fee | `(N * 300) / 10000` | `(N * 300) / 10000` | Exact |
| MIN clamp | `if sum < 50000: sum = 50000` | `if sum < 50000: sum = 50000` | Exact |
| Impact fee | `1500*N*(2*OI+N) / (2*B*10000)` | `1500*N*(2*OI+N) / (2*B*10000)` | Exact |
| OI source | `isLong ? longOI : shortOI` | `longOI` (openLong) / `shortOI` (openShort) | Correct |

All 5 constant values match: `BPS_DENOM=10000`, `LP_FEE_BPS=300`, `PROTOCOL_FEE_BPS=200`, `MIN_POSITION_FEE=50000`, `IMPACT_FEE_BPS=1500`.

The Router reads `backedAirUsd()` and OI via external view calls, then the Pool reads the same storage variables internally. Since both execute in the same atomic transaction with no state changes between the reads, the values are guaranteed identical. **No fee mismatch is possible in normal operation.**

---

## Phase 6: CP AMM Math Verification

### `_cpAmountOut` correctness

```
rawOut = amountIn * reserveOut / (reserveIn + amountIn)
fee    = amountIn * reserveOut * swapFeeBps / (reserveIn * BPS_DENOM)
netOut = rawOut - fee   (or 0 if rawOut <= fee)
```

Verified properties:
- `rawOut < reserveOut` always (cannot drain entire reserve).
- Fee is a true percentage of notional at spot price. Sound fee model.
- Returns 0 for very large trades (when amountIn > reserveIn * (BPS - fee) / fee). Documented.
- Division by zero: guarded by `reserveIn == 0 || reserveOut == 0` check.
- Overflow: worst realistic case `1e36 * 1e15 * 9999 ~= 1e55`, safely within uint256.

### `quoteSwap` consistency with actual swap

Both use identical computation paths. `quoteSwap.grossOut` = `rawOut`, `quoteSwap.fee` = `fee`, `quoteSwap.netOut` = `netOut`. **Exact match. No view/execution discrepancy.**

---

## Phase 7: Conclusion

The EXNIHILO protocol is well-engineered with strong accounting invariants that hold across all code paths. The N-1 fix is correct and introduces no new edge cases. The Router's fee replication exactly matches the Pool's formula. The CP AMM math is sound. USDC solvency is maintained through all 13 state-changing operations.

**No critical or high-severity findings.** One medium finding (Router token recovery) addresses a standard pattern for immutable router contracts. The low findings are documentation-level (event accuracy), display-level (NFT PnL rounding), and design-level (closeShort cost approximation, renewal griefing).

The protocol's main systemic risk is inherent to its design: the single-LP model gives the LP holder significant control over pool pricing via addLiquidity and swaps. This is documented and by-design, not a bug.

### Verification checklist (addressed per audit scope):

- [x] N-1 fix analysis -- correct, no new edge cases
- [x] Cross-function state consistency across all 6 exit paths -- verified
- [x] Multi-transaction attack sequences -- no exploitable sequences found
- [x] Fee accounting across many operations -- invariant 2 (USDC solvency) holds
- [x] Rounding/precision in CP AMM math -- sound, overflow-safe
- [x] backedAirToken/backedAirUsd underflow analysis -- protected by invariant checks
- [x] LP fee claim interaction with position lifecycle -- USDC always available
- [x] quoteSwap view vs actual execution -- exact match
- [x] Position renewal + liquidation race conditions -- finding N2-L2
- [x] Router fee replication vs Pool fee computation -- algebraically identical

---

*Audit performed by Claude Opus 4.6 using the Nemesis methodology (8 phases). All findings were verified by manual line-by-line code tracing. No automated tools were used.*
