# EXNIHILO Security Audit Summary

**Date:** 2026-04-04
**Scope:** EXNIHILOPool, PositionNFT, EXNIHILOFactory, EXNIHILORouter, LpNFT, AirToken
**Passes:** 11 independent analyses (see table below)

## Aggregate Tally (deduplicated)

```
0 CRITICAL | 0 HIGH | 0 MEDIUM (fixed) | 7 LOW | 6 INFO
```

## DoS-2 Fix Status

The only MEDIUM finding (DoS-2: blacklisted holder blocks LP exit) has been **FIXED** in `EXNIHILOPool.sol` via `_trySendUsdc()` try/catch wrapper on expired-position close paths. 9 dedicated tests in `test/BlacklistResilience.ts` confirm the fix. Contract size impact: +264 bytes (68.6% of 24,576 limit).

## Findings

| ID | Severity | Status | Title |
|----|----------|--------|-------|
| DoS-2 | ~~MEDIUM~~ | **FIXED** | Blacklisted position holder blocks LP exit |
| NM-001 | LOW | Open | PositionNFT mint accessible before initFactory |
| NM-002 | LOW | Open | Factory residual approvals not revoked after addLiquidity |
| NM-003 | LOW | Open | No caller incentive for closePositionAfterDeadline |
| NM-004 | LOW | Open | Anyone-can-renew enables LP exit griefing (mitigated by closePool) |
| ECS-1 | LOW | Open | Rebasing tokens silently break pool accounting |
| IA-3 | LOW | Open | Position open fees round down (mitigated by MIN_POSITION_FEE) |
| IA-6 | LOW | Open | Extreme-decimal tokens (>38) can overflow _cpAmountOut |
| OFL-1 | LOW | Accepted | Cross-AMM flash loan manipulation (uneconomical with fees) |
| OFL-2 | LOW | Accepted | Atomic open-manipulate-close via flash loan (unprofitable) |
| RE-1 | LOW | Accepted | Read-only reentrancy window with ERC-777 underlying (theoretical) |
| DoS-1 | LOW | Accepted | Blacklisted treasury blocks pool operations |
| NM-005 | INFO | Open | Factory createMarket missing explicit input validation |
| IA-1 | INFO | N/A | No upper bound on maxPositionUsd (LP's own parameter) |
| IA-2 | INFO | N/A | extendDeadline allows past deadline (pool is sole caller) |
| IA-4 | INFO | N/A | airTokenMinted rounds down in openShort (1 wei, offset at close) |
| IA-5 | INFO | N/A | Zero swap fee on dust amounts (gas-prohibitive) |
| SGA-1 | INFO | N/A | _assertReserveInvariant skipped where correct by design |

## Audit Pass Coverage

| Pass | File | C | H | M | L | I |
|------|------|---|---|---|---|---|
| Nemesis (Feynman + State) | nemesis-verified.md | 0 | 0 | 0 | 4 | 1 |
| Behavioral State Analysis | bsa-verified.md | 0 | 0 | 0 | 4 | 1 |
| DoS & Griefing | dos-griefing-verified.md | 0 | 0 | 1 | 2 | 0 |
| External Call Safety | external-call-safety-verified.md | 0 | 0 | 0 | 1 | 0 |
| Input & Arithmetic | input-arithmetic-safety-verified.md | 0 | 0 | 0 | 2 | 4 |
| Oracle & Flash Loan | oracle-flashloan-verified.md | 0 | 0 | 0 | 2 | 0 |
| Proxy & Upgrade | proxy-upgrade-safety-verified.md | 0 | 0 | 0 | 0 | 0 |
| Reentrancy | reentrancy-verified.md | 0 | 0 | 0 | 1 | 0 |
| Semantic Guard | semantic-guard-verified.md | 0 | 0 | 0 | 0 | 1 |
| Signature & Replay | signature-replay-verified.md | 0 | 0 | 0 | 0 | 0 |
| State Invariant | state-invariant-verified.md | 0 | 0 | 0 | 0 | 0 |

## Conclusion

No critical or high severity issues. The single medium (DoS-2) is fixed and tested. Remaining lows are either mitigated by existing protocol mechanisms, uneconomical to exploit, or require pathological token choices by the market creator.
