---
description: "EXNIHILO's latest audit round in full: 0 Critical, 0 High, 0 Medium, 6 Low — and the process failure that mattered more than any finding in the code."
---

# Audit Report — Opus 5 (2026-07-27)

This is the complete result of the most recent audit round, published here rather than
only in the repository so it can be read, linked and quoted without cloning anything.
The per-pass reports it summarizes live in
[`.audit/findings-opus5/`](https://github.com/Red-Goglz/EXNIHILO/tree/main/.audit/findings-opus5).

::: danger Read this before you read the result
All four audit rounds were performed by **AI models, not a human security firm**. No
formal verification and no fuzzing campaign was run. Each round has surfaced findings
its predecessors missed — including one round that materially misdescribed what it had
even looked at (see [PROCESS-001](#the-most-important-finding-was-not-a-code-defect)) —
which is the clearest possible evidence that none of them should be treated as final.

A clean result here means "eleven analysis passes did not find a way to steal funds". It
does not mean the protocol is safe.
:::

## Scope and result

**Date:** 2026-07-27
**Contracts:** `EXNIHILOPool`, `PositionNFT`, `EXNIHILOFactory`, `EXNIHILORouter`,
`LpNFT`, `PoolDeployer`, `Faucet`
**Passes:** 11 independent analyses
**Primary question:** can LP funds be drained, or value stolen?

```
0 CRITICAL | 0 HIGH | 0 MEDIUM | 6 LOW | 8 INFO | 1 PROCESS
```

No path was found by which LP funds can be drained or value stolen.

## Pass coverage

| Pass | C | H | M | L | I |
|------|---|---|---|---|---|
| Nemesis (Feynman + State Inconsistency, iterated) | 0 | 0 | 0 | 2 | 0 |
| Behavioral State Analysis | 0 | 0 | 0 | 1 | 2 |
| DoS & Griefing | 0 | 0 | 0 | 2 | 0 |
| External Call Safety | 0 | 0 | 0 | 1 | 1 |
| Input & Arithmetic | 0 | 0 | 0 | 3 | 2 |
| Oracle & Flash Loan | 0 | 0 | 0 | 2 | 0 |
| Proxy & Upgrade | 0 | 0 | 0 | 0 | 0 |
| Reentrancy | 0 | 0 | 0 | 1 | 1 |
| Semantic Guard | 0 | 0 | 0 | 0 | 2 |
| Signature & Replay | 0 | 0 | 0 | 0 | 0 |
| State Invariant | 0 | 0 | 0 | 0 | 0 |

## The most important finding was not a code defect

**PROCESS-001 — the prior audit reports did not describe the deployed code.**

The preceding round (Fable 5, 2026-07-09) asserted that the only change since the round
before it was `PositionNFT` display code, and that it "does not touch pool accounting,
custody, or any value-moving code".

At the time of this audit, `git diff --stat HEAD` reported **1,171 changed lines in
`EXNIHILOPool.sol`**, a deleted `AirToken.sol`, `EXNIHILOFactory` +77 and
`EXNIHILORouter` +57 — all uncommitted.

The entire renewal / auto-renew / keeper / claim subsystem had **never been audited by
any prior pass**, and had been deployed to Fuji on the strength of that assertion.

The lesson generalizes past this protocol: an audit delta must be derived from version
control, never asserted in prose. A clean report against the wrong baseline is worse
than no report, because it manufactures confidence.

## Changes made during the audit

| Change | Why | Verification |
|---|---|---|
| `totalShortCollateral` added to `_assertReserveInvariant` | `openShort` moves USDC out of `backedAirUsd` into a position's `lockedAmount`, where the invariant had stopped tracking it — so it could not have detected a leak of short collateral | Exhaustive mutation proof across 3 sites; conservation algebra per branch; `slack = 0` empirically |
| `if (netOut == 0) revert InsufficientOutput();` on both swap paths | A trade large enough that the fee outgrew raw output took the caller's input and returned nothing | Both directions revert; no value taken on revert; `minAmountOut` still honoured |

Neither change had shipped with tests. Both now have them, and **both suites were
mutation-tested** — a passing test proves nothing until you have watched it fail.

| Mutation introduced | Tests that caught it |
|---|---|
| `openShort` increments by half the collateral | 4 / 7 ✓ |
| `_tryAutoRenew` short decrement removed | 2 / 7 ✓ |
| `netOut == 0` guard removed (both paths) | 3 / 5 ✓ |

The auto-renew mutation initially *escaped*. The first version of that test used an
`if/else` that passed whether or not auto-renew actually fired, and the short could not
pay the fee, so it silently settled instead. It was rewritten to force the position
profitable and to assert `openPositionCount == 1` unconditionally. This is exactly the
class of weak test that mutation testing exists to catch, and it is recorded here rather
than quietly fixed.

## Open findings

| ID | Severity | Status | Title |
|----|----------|--------|-------|
| NM-OP5-001 | LOW | **Fixed** | `swap()` accepted a zero-output trade |
| NM-OP5-002 | LOW | Open | `factory.deployer()` can force-close every pool |
| LOW-BSA-1 | LOW | Mitigated | LP exit requires all positions settled (bounded by `closePool`) |
| LOW-DOS-1 | LOW | Narrowed | Blacklisted treasury blocks its own fee claims (`to` param mitigates) |
| ECS-1 | LOW | Half-closed | Rebasing tokens; inbound half now impossible via `_transferIn` |
| IA-3 | LOW | Mitigated | Open fees round down (`MIN_POSITION_FEE` floor) |
| IA-6 | LOW | Open | Tokens with >38 decimals can overflow `_cpAmountOut` |
| OFL-1 / OFL-2 | LOW | Accepted | Flash-loan manipulation — uneconomical, now harder still |
| RE-1 | LOW | Accepted | Read-only reentrancy with an ERC-777 underlying |
| NM-001 | LOW | Open | `PositionNFT` mint reachable before `initFactory` (one-tx window) |
| NM-002 | LOW | Open | Factory residual approvals not revoked |
| INFO-SGA-1 | INFO | Open | `setPositionCaps` lacks `nonReentrant` (no value movement) |
| NM-005 | INFO | Open | `createMarket` lacks explicit token validation |

## Closed since prior rounds

- **NM-003** — no keeper incentive → closed by `KEEPER_BOUNTY`.
- **NM-004** — anyone-can-renew LP griefing → closed; `renewPosition` now requires
  `positionNFT.ownerOf(nftId) == msg.sender`.
- **DoS-2** — blacklisted holder blocks LP exit → closed more strongly than before:
  `_trySendUsdc`'s try/catch was replaced by the `_creditPayout` pull payment, so funds
  are never pushed at all.
- **ECS-1 inbound** — `_transferIn` now reverts `FeeOnTransferNotSupported`.

## Structural properties

These eliminate whole vulnerability classes rather than individual bugs, which is why
several passes came back empty:

- **No loops** in any contract → unbounded-loop and gas-limit DoS are impossible.
- **No `unchecked` blocks** → an accounting desync fails closed (revert), not open (wrap).
- **No `delegatecall`, no proxies** → no upgrade or storage-collision surface.
- **No signatures** → no replay surface of any kind.
- **No oracles** → pricing is self-referential, so oracle manipulation collapses into AMM
  manipulation, which is fee-bounded.
- **No shares** (one LP per pool) → no dilution, inflation, or first-depositor vector.
- **Pull payments** for all fees and third-party payouts.

## Test suite

**414 passing, 0 failing.**

Eight `Coverage.ts` "storage-forced" tests had been failing against a hardcoded slot map
invalidated by OpenZeppelin 5.6: `ReentrancyGuard` no longer declares a sequential
`uint256 private _status` (it uses a namespaced ERC-7201 slot), so every pool variable
sits one slot lower. The map was corrected against live storage and both documenting
comment blocks rewritten so it cannot mislead again.

New suites for this round's changes: `test/ShortCollateralInvariant.ts` (7 tests) and
`test/ZeroOutputSwap.ts` (5 tests).

## Recommendations, in priority order

1. **Commit the contracts.** PROCESS-001 is the finding most likely to cause a real
   incident, because it makes every other assurance unverifiable.
2. **Decide the emergency-deployer policy** — timelock, multisig, or zero it after launch.
3. **Fix the `Coverage.ts` slot map** so regressions stay visible. *(Done — suite is green.)*
4. **Bound `tokenDecimals` in `createMarket`** (closes IA-6).
5. Add `nonReentrant` to `setPositionCaps` for consistency.

## Scope limits

**Reviewed in depth:** `EXNIHILOPool` custody, accounting conservation, access control,
keeper and auto-renew value flows, swap math; `PositionNFT`'s position-mutation surface;
`EXNIHILORouter`'s approval and fee-quoting paths; `Faucet`'s value paths.

**Reviewed at surface level only:** `PositionNFT`'s SVG and metadata rendering (a `view`
path wrapped in try/catch), `LpNFT`, `PoolDeployer`, and `EXNIHILOFactory.createMarket`
input validation beyond the `decimals()` fallback.

No formal verification and no fuzzing campaign was run. The manipulation-safety and
parametric grids in `test/` are the strongest economic evidence available here, and they
are scenario-based rather than exhaustive.

## Earlier rounds

The three preceding rounds, their findings and their remediations are summarized on the
[Security](./security#audit-status) page. All reports:
[`.audit/`](https://github.com/Red-Goglz/EXNIHILO/tree/main/.audit).
