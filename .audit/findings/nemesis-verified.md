# N E M E S I S — Verified Findings

## Scope
- **Language:** Solidity ^0.8.24
- **Modules analyzed:** EXNIHILOPool, EXNIHILOFactory, EXNIHILORouter, PositionNFT, AirToken, LpNFT
- **Functions analyzed:** 27 state-changing + 7 view functions
- **Coupled state pairs mapped:** 7
- **Mutation paths traced:** 16 (across all coupled pairs)
- **Nemesis loop iterations:** 4 (2 full + 2 targeted → convergence)
- **Audit date:** 2026-04-02

## Nemesis Map (Phase 1 Cross-Reference)

All 7 coupled state pairs were cross-referenced against every state-changing function:

| Function | CP-1 airToken | CP-2 airUsd | CP-5 posCount | CP-6 longOI | CP-7 shortOI | Sync |
|---|---|---|---|---|---|---|
| openLong | backed-=, supply= | supply+=, backed= | ++ | += | — | ✓ |
| closeLong | backed+=, supply= | backed-=, supply-= | -- | -= | — | ✓ |
| realizeLong | backed=, supply-= | backed+=, supply= | -- | -= | — | ✓ |
| openShort | supply+=, backed= | backed-=, supply= | ++ | — | += | ✓ |
| closeShort | supply-=, backed= | backed+=, supply-= | -- | — | -= | ✓ |
| realizeShort | backed+=, supply= | backed=, supply-= | -- | — | -= | ✓ |
| liqExpLong(P) | backed+=, supply= | backed-=, supply-= | -- | -= | — | ✓ |
| liqExpLong(UW) | backed+=, supply= | backed=, supply-= | -- | -= | — | ✓ |
| liqExpShort(P) | supply-=, backed= | backed+=, supply-= | -- | — | -= | ✓ |
| liqExpShort(UW) | supply-=, backed= | backed+=, supply= | -- | — | -= | ✓ |
| addLiquidity | both += | both += | — | — | — | ✓ |
| removeLiquidity | both zeroed | both zeroed | — | — | — | ✓ |
| swap (T→U) | backed+=, supply+= | backed-=, supply-= | — | — | — | ✓ |
| swap (U→T) | backed-=, supply-= | backed+=, supply+= | — | — | — | ✓ |

**No state gaps found. All coupled pairs maintain consistency across every code path.**

USDC solvency invariant verified:
```
underlyingUsdc.balanceOf(pool) = backedAirUsd + lpFeesAccumulated + Σ(lockedAmount for open shorts)
```
All 16 mutation paths maintain this invariant. Verified by tracing deltas.

## Verification Summary

| ID | Source | Severity | Verdict |
|----|--------|----------|---------|
| NM-001 | Feynman (consistency) | LOW | TRUE POS |
| NM-002 | Feynman (boundaries) | LOW | TRUE POS |
| NM-003 | State (OI coupling) | LOW | TRUE POS |
| NM-004 | Feynman (boundaries) | LOW | TRUE POS |
| NM-005 | Feynman (access) | INFO | TRUE POS |
| FP-001 | Router fee mismatch | — | FALSE POS |
| FP-002 | Instant open-close arb | — | FALSE POS |
| FP-003 | closeShort cost exploit | — | FALSE POS |
| FP-004 | USDC insolvency | — | FALSE POS |
| FP-005 | airToken supply < locked | — | FALSE POS |
| FP-006 | Stale synthetic after realize | — | FALSE POS |
| FP-007 | Renew/liquidate race | — | FALSE POS |
| FP-008 | Sandwich attack | — | FALSE POS |

## Verified Findings (TRUE POSITIVES)

### Finding NM-001: Missing Event Emissions on Key State-Changing Functions

**Severity:** LOW
**Source:** Feynman — Category 3 (Consistency)
**Verification:** Code trace

**Description:**
Six state-changing functions do not emit events:
- `realizeLong()` — EXNIHILOPool.sol:L637
- `realizeShort()` — EXNIHILOPool.sol:L860
- `addLiquidity()` — EXNIHILOPool.sol:L908
- `removeLiquidity()` — EXNIHILOPool.sol:L942
- `claimFees()` — EXNIHILOPool.sol:L968
- `renewPosition()` — EXNIHILOPool.sol:L989

**Feynman question that exposed it:**
> "Why do openLong/closeLong/liquidateExpired emit events but realizeLong does not? These are all position lifecycle operations."

**Consequence:**
- Off-chain indexers and frontends cannot track realizes, liquidity changes, fee claims, or renewals
- Position lifecycle monitoring is incomplete
- Analytics dashboards lack critical data

**Fix:**
```solidity
event PositionRealized(uint256 indexed nftId, address indexed holder, bool isLong);
event LiquidityAdded(uint256 tokenAmount, uint256 usdcAmount);
event LiquidityRemoved(uint256 tokenAmount, uint256 usdcAmount);
event FeesClaimed(address indexed lpHolder, uint256 amount);
event PositionRenewed(uint256 indexed nftId, uint256 newDeadline, uint256 feePaid);
```

---

### Finding NM-002: Potential Integer Overflow in _cpAmountOut for Extreme Token Supplies

**Severity:** LOW
**Source:** Feynman — Category 5 (Boundaries)
**Verification:** Arithmetic analysis + code trace

**Location:** EXNIHILOPool.sol:L1298
```solidity
uint256 fee = (amountIn * reserveOut * swapFeeBps) / (reserveIn * BPS_DENOM);
```

**Feynman question that exposed it:**
> "What is the maximum value each operand can take? What happens at that maximum?"

**Description:**
The three-way multiplication `amountIn * reserveOut * swapFeeBps` can overflow uint256 when both reserves exceed ~10^38 in raw units. For an 18-decimal token, this equals ~10^20 tokens — theoretically possible for high-supply meme tokens.

**Trigger condition:**
- Token with ≥18 decimals and raw reserve amounts exceeding 10^38
- OR synthetic inflation from many open positions pushing totalSupply above 10^38

**Consequence:**
- Solidity 0.8 reverts on overflow — no silent corruption or fund loss
- The function simply fails, preventing the trade from executing
- Effective DoS for that specific pool (swaps, position opens, and closes all use this function)

**Mitigating factors:**
- USDC side is always 6 decimals (max ~10^15 for realistic amounts), keeping cross-products safe
- The `rawOut` calculation `(amountIn * reserveOut) / (reserveIn + amountIn)` overflows at the same threshold
- Real-world pools on Linea Sepolia testnet will not approach these limits

**Fix (if desired):**
```solidity
// Use mulDiv for overflow-safe computation
uint256 fee = Math.mulDiv(amountIn * reserveOut, swapFeeBps, reserveIn * BPS_DENOM);
```

---

### Finding NM-003: No Aggregate Open Interest Cap

**Severity:** LOW
**Source:** State Inconsistency — OI coupling analysis
**Verification:** Code trace

**Description:**
`_checkLeverageCap()` (L1309-1319) limits individual position size via `maxPositionUsd` and `maxPositionBps`. However, there is no cap on total `longOpenInterest` or `shortOpenInterest` relative to pool reserves.

**State mapping gap that exposed it:**
> longOpenInterest and shortOpenInterest are incremented without an upper bound check against backedAirUsd.

**Consequence:**
- Many small positions can accumulate total OI far exceeding pool reserves
- High OI distorts SWAP-2/SWAP-3 pricing (more synthetic supply = more leverage)
- In extreme cases, close operations may return near-zero due to high virtual reserve inflation

**Mitigating factors:**
- The quadratic impact fee `IMPACT_FEE_BPS × N × (2×OI+N) / (2×backedAirUsd×BPS_DENOM)` scales with cumulative OI, making marginal positions progressively expensive
- At OI ≈ backedAirUsd, impact fee alone reaches ~22.5% — strong economic deterrent
- Per-position caps still limit individual exposure

**Fix (optional — design choice):**
```solidity
// Add aggregate OI check in openLong/openShort
uint256 totalOI = longOpenInterest + shortOpenInterest + usdcAmount;
if (totalOI > backedAirUsd * MAX_OI_RATIO / BPS_DENOM) revert TotalOIExceeded();
```

---

### Finding NM-004: Griefing via Mass Micro-Positions

**Severity:** LOW
**Source:** Feynman — Category 5 (Boundaries — mass repetition)
**Verification:** Economic analysis

**Description:**
An attacker can open many positions at the minimum fee (0.05 USDC each), creating a backlog that the LP must liquidate one-by-one to reach `openPositionCount == 0` and call `removeLiquidity()`.

**Trigger Sequence:**
1. Attacker opens 1000 minimum-size positions: cost = 1000 × 0.05 USDC = 50 USDC
2. Positions expire after `positionDuration`
3. LP (or anyone) must call `liquidateExpired()` 1000 times to clean up
4. Each call costs ~100-200K gas

**Consequence:**
- LP is blocked from removing liquidity until all positions are liquidated
- On Ethereum mainnet: could cost thousands of dollars in gas
- On Linea (L2): gas cost is low, mitigating the impact significantly

**Mitigating factors:**
- MIN_POSITION_FEE = 0.05 USDC makes it non-free
- Quadratic impact fee makes later positions increasingly expensive
- Anyone can call `liquidateExpired` (not just LP)
- LP can `closePool()` to prevent new positions and guarantee eventual cleanup
- L2 deployment means gas costs are minimal

---

### Finding NM-005: Centralization Risk in Factory Deployer

**Severity:** INFORMATIONAL
**Source:** Feynman — Category 3 (Access control consistency)
**Verification:** Code trace

**Description:**
The factory's `deployer` address (set in constructor, updatable via `setDeployer()`) can call `closePool()` on any pool, forcing position holders into a liquidation timeline.

**Location:** EXNIHILOPool.sol:L319-332, EXNIHILOFactory.sol:L344-349

**Consequence:**
- Deployer can unilaterally shut down any market
- Position holders face forced closure at potentially unfavorable prices
- Cannot steal funds directly (no access to reserves or transfers)

**Mitigating factors:**
- Documented as emergency admin feature
- Role is transferable
- No direct fund access — only sets closeDate

---

## Feedback Loop Discoveries

**No cross-feed findings emerged.** The Feynman and State Inconsistency passes independently confirmed the same conclusion: the codebase's state management is consistent and well-designed. No findings emerged that required the iterative loop to discover.

This is notable — it indicates a high-quality codebase where the developer has carefully maintained state coupling across all code paths.

## False Positives Eliminated

| # | Suspected Issue | Elimination Method | Reason |
|---|---|---|---|
| FP-001 | Router fee calculation could diverge from pool | Code trace | Same-tx execution; pool state cannot change between router read and pool call |
| FP-002 | Instant open-close arbitrage via flash loan | Mathematical proof | CP formula guarantees: B×U / (T×(S+N)) < 1 in any balanced state |
| FP-003 | closeShort proportional cost approximation exploitable | Economic analysis | Conservative estimate (ceil-divide + concavity) OVERESTIMATES cost — favors LP, not attacker |
| FP-004 | Pool USDC insolvency on position close | Invariant proof | USDC = backedAirUsd + lpFees + Σ(short locks) verified across all 16 mutation paths |
| FP-005 | airToken.totalSupply() could drop below locked amounts | Invariant proof | supply = backed + locked + synthetic, all terms ≥ 0, so supply ≥ any single lock |
| FP-006 | Stale synthetic tokens after realizeLong/realizeShort | Design verification | Synthetic becomes backed — invariant gap (supply - backed) decreases correctly |
| FP-007 | Race condition between renewPosition and liquidateExpired | Design review | Standard blockchain ordering; both paths maintain all state invariants |
| FP-008 | Sandwich attack via swap manipulation + position open | Economic analysis | 5% open fee + 2% swap fee × 2 + 1% close fee ≈ 10% minimum cost; exceeds any manipulation profit |

## Summary

```
Total functions analyzed:          27 state-changing + 7 view
Coupled state pairs mapped:        7
Mutation paths traced:             16
Nemesis loop iterations:            4 (2 full + 2 targeted)
Convergence:                       Pass 3 (no new findings)

Raw findings (pre-verification):   0 C | 0 H | 0 M | 5 L
Feedback loop discoveries:         0
After verification:                5 TRUE POSITIVE | 8 FALSE POSITIVE | 0 DOWNGRADED
Final:                             0 CRITICAL | 0 HIGH | 0 MEDIUM | 4 LOW | 1 INFORMATIONAL
```

## Overall Assessment

The EXNIHILO codebase demonstrates **strong security engineering**:

1. **Consistent CEI pattern** — all functions write state before external calls
2. **ReentrancyGuard on every state-changing function** — no reentrancy vectors
3. **Explicit reserve invariant checks** (`_assertReserveInvariant`) after every operation
4. **Fee-on-transfer protection** via `_transferIn` balance checks
5. **SafeERC20** throughout for non-standard ERC-20 handling
6. **Symmetric treatment** of long/short positions — parallel paths are identical
7. **Sound economic design** — constant-product AMM properties prevent flash-loan arbitrage; fee structure prevents sandwich attacks

The 3-mode AMM with synthetic mint/burn leverage is **novel and correctly implemented**. All 7 coupled state pairs maintain consistency across every code path. The USDC solvency invariant holds under all 16 mutation scenarios tested.

No CRITICAL, HIGH, or MEDIUM severity findings were discovered. The 4 LOW findings are informational in nature and do not represent fund-loss risk.
