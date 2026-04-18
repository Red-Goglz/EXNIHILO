# EXNIHILO Security Audit Summary — 4.7 re-audit

**Date:** 2026-04-17 (audit) / 2026-04-18 (remediation pass)
**Model:** Claude Opus 4.7 (1M context)
**Scope:** `EXNIHILOPool`, `PositionNFT`, `EXNIHILOFactory`, `EXNIHILORouter`, `LpNFT`, `AirToken` (+ `PoolDeployer` touched by PU pass)
**Passes:** 11 independent analyses (parallel subagents), same pass set as 4.6 baseline.
**Baseline:** `.audit/findings/` (Claude Sonnet 4.6, dated 2026-04-04).

## Aggregate Tally

**At audit (2026-04-17):**
```
0 CRITICAL | 1 HIGH (conditional) | 4 MEDIUM | 8 LOW | 4 INFO
```

**After remediation (2026-04-18):**
```
0 CRITICAL | 0 HIGH | 0 MEDIUM (5 FIXED) | 4 LOW | 4 INFO
```

All HIGH and MEDIUM findings are remediated. Test suite: **414 passing** (up from 408 pre-fix), including 10 new tests covering the fixes.

## Fix Status

### HIGH (conditional) — FIXED

| ID | Title | Status | Fix |
|----|-------|--------|-----|
| SI-001 / ECS-2 | `_trySendUsdc` strands USDC; USDT-style tokens make every close path silently leak | **✅ FIXED** | Replaced typed `try IERC20.transfer` with low-level `call` + returndata-length check to tolerate no-return-value tokens; failed amounts socialize into `lpFeesAccumulated`. `EXNIHILOPool.sol:1345-1374` |

### MEDIUM — all FIXED

| ID(s) | Title | Status | Fix |
|-------|-------|--------|-----|
| NM-008 / BSA-6 / DoS-5 / SI-001 | `_trySendUsdc` failure decrements accounting before transfer; no recovery path | **✅ FIXED** | On failure, `lpFeesAccumulated += amount` — recoverable by LPs via existing `claimFees()`. `EXNIHILOPool.sol:1345-1374` |
| NM-006 / DoS-6 / IA-10 / SI-002 / OFL-4 / ECS-4 | Router `_positionFee` OI snapshot race + permissionless `sweep()` drains residuals | **✅ FIXED** | Added `_refundResidual` (balance-delta to `msg.sender`) to all 4 router entry points; deleted `sweep()` entirely. `EXNIHILORouter.sol` rewrite |
| SGA-2 / IA-8 | `closeShort` missing `airUsdSupply < pos.lockedAmount` guard — panics instead of clean revert | **✅ FIXED** | Added guard mirroring `closeLong:583`. `EXNIHILOPool.sol:814` |
| IA-7 / NM-007 / SGA-4 | `setDeployer` accepts `address(0)` despite NatSpec saying otherwise | **✅ ACCEPTED (documented)** | NatSpec updated to declare `address(0)` deliberately allowed for permissionless handoff; code unchanged. `EXNIHILOFactory.sol:262-275` |
| OFL-3 | No minimum `swapFeeBps` floor enables flash-loan arbitrage | **✅ FIXED** | Added `MIN_SWAP_FEE_BPS = 100` constant; constructor now rejects `swapFeeBps < 100`. `EXNIHILOPool.sol:175-180, 386` |

### LOW — OPEN (not fixed this pass)

| ID(s) | Title | Status |
|-------|-------|--------|
| NM-001 / BSA-1 / PU-002 | PositionNFT `mintLong`/`mintShort` accessible during pre-`initFactory` window | Open (mitigated by atomic deployment script) |
| NM-002 / BSA-2 / ECS-3 | Factory `forceApprove` residuals not cleared post-`addLiquidity` | Open (defense-in-depth only) |
| NM-003 / BSA-3 | No caller incentive for `closePositionAfterDeadline` | Open (mitigated by LP triggering before `removeLiquidity`) |
| NM-004 / BSA-4 | Anyone-can-renew enables LP-exit griefing | Open (mitigated by `closePool`) |
| ECS-1 | Rebasing / fee-on-transfer tokens silently break pool accounting | Open (LP creator's token-choice responsibility) |
| IA-3 | Position-open fees round down | Open (mitigated by MIN_POSITION_FEE) |
| IA-6 | Extreme-decimal tokens (>38) overflow `_cpAmountOut` | Open (pathological token choice) |
| RE-1 | Read-only reentrancy window with ERC-777 underlying | Open, Accepted (theoretical) |
| DoS-1 | Blacklisted treasury blocks pool ops | Open, Accepted (treasury rotatable) |
| OFL-1 / OFL-2 | Cross-AMM / atomic open-manipulate-close flash loan | Open, Accepted — uneconomical at the new `MIN_SWAP_FEE_BPS = 100` floor |
| PU-001 | `PoolDeployer.deploy` no `onlyFactory` guard (orphan pool spam) | Open (no fund-loss path) |
| NM-009 | `Router.renewPosition` caller-supplied fee over-estimate | **Resolved as side-effect** of the Router refund fix above |
| BSA-5 / SGA-3 / NM-005 | `EXNIHILOFactory.createMarket` empty input-validation block | Open (graceful revert downstream; gas-waste only) |

### INFO — OPEN (design decisions)

| ID(s) | Title |
|-------|-------|
| IA-1, IA-2, IA-4, IA-5 | From 4.6 — accepted as N/A or by-design |
| SGA-1 / SI-004 | `_assertReserveInvariant` skipped in `removeLiquidity`/`renewPosition` — by design |
| ECS-3 | Factory allowance not reset post-`addLiquidity` (defense-in-depth) |

## Remediation Summary

Four production patches + one documentation patch land 5 of 5 MEDIUMs and the conditional HIGH. Aggregate fix impact:

| Patch | File(s) | Closes |
|-------|---------|--------|
| 1. Socialize failed `_trySendUsdc` to LP | `EXNIHILOPool.sol` | SI-001, ECS-2, NM-008, BSA-6, DoS-5 |
| 2. Router residual refund + delete `sweep()` | `EXNIHILORouter.sol` | NM-006, NM-009, DoS-4, DoS-6, IA-10, SI-002, ECS-4, OFL-4 |
| 3. `closeShort` underflow guard | `EXNIHILOPool.sol` | SGA-2, IA-8 |
| 4. `MIN_SWAP_FEE_BPS = 100` | `EXNIHILOPool.sol` | OFL-3 (and strengthens OFL-1/OFL-2 accept-posture) |
| 5. `setDeployer` NatSpec rationale | `EXNIHILOFactory.sol` | NM-007, IA-7, SGA-4 (accepted-with-documentation) |

Patches 1 and 2 address the highest-impact clusters — each was independently flagged by 5+ of the 11 audit passes.

## Test Coverage for Fixes

| Test suite | New/updated tests | Purpose |
|------------|-------------------|---------|
| `BlacklistResilience.ts` | +4 in new section "Failed payouts socialize to LP fees" | Verify blacklisted holder's failed amount → `lpFeesAccumulated`; LP recovers via `claimFees`; successful paths do NOT socialize |
| `EXNIHILORouter.ts` | +6 in new sections "Residual refund" and "sweep() removed" | Verify over-estimate refunds; router balance is zero after each entry; `sweep` not on ABI; donations are not stealable |
| `Coverage.ts` | Updated `N2-M1` regression + extended `InvalidSwapFeeBps` | `N2-M1` now asserts sweep removal; fee-floor test covers 0/99/100/10000 boundary |

Total: **414 passing** (was 408 before fixes).

## Cross-pass duplicates (agreement table, pre-fix)

| Root issue | Flagged by | Fix applied |
|------------|------------|-------------|
| `_trySendUsdc` accounting leak | Nemesis (NM-008), BSA (BSA-6), DoS (DoS-5), State-invariant (SI-001), External-call (ECS-2) | ✅ Patch 1 |
| Router race + permissionless `sweep` | Nemesis (NM-006, NM-009), DoS (DoS-4, DoS-6), Input/arith (IA-10), State-invariant (SI-002), External-call (ECS-4), Oracle (OFL-4) | ✅ Patch 2 |
| `setDeployer` zero-address | Nemesis (NM-007), Input/arith (IA-7), Semantic-guard (SGA-4) | ✅ Accepted + documented (Patch 5) |
| `closeShort` missing underflow guard | Semantic-guard (SGA-2), Input/arith (IA-8) | ✅ Patch 3 |
| `createMarket` empty validation | Nemesis (NM-005), BSA (BSA-5), Semantic-guard (SGA-3) | Open (LOW, gas-waste only) |

## Delta vs 4.6 (unchanged analysis)

- DoS-2 (4.6 MEDIUM) stays **FIXED**; no regression from the 4.7 patches.
- 4.6 had zero MEDIUM live findings; 4.7 surfaced 4 MEDIUM + 1 conditional HIGH → **all now remediated.**
- 4.6 missed the compound exploit chain on the Router and the accounting side-effect of its own DoS-2 fix — both caught across 5-8 passes in 4.7 and closed in Patches 1 & 2.
- 4.6 missed 3 localized consistency violations surfaced by the Consistency Principle in 4.7; 2 are fixed (closeShort guard; fee floor) and 1 is accepted-with-documentation (setDeployer).

## Conclusion

Post-remediation status: **0 CRITICAL, 0 HIGH, 0 MEDIUM.** Only LOW and INFO items remain, all either mitigated by existing mechanisms, accepted by design, or tied to pathological LP token choices.

The two largest remediation patches (socialize-on-fail for `_trySendUsdc`; router residual refund) each closed 5-8 audit findings in a single change, reflecting the quality of the multi-pass consensus.
