# EXNIHILO Security Audit Summary — Opus 5

**Date:** 2026-07-27
**Scope:** `EXNIHILOPool`, `PositionNFT`, `EXNIHILOFactory`, `EXNIHILORouter`,
`LpNFT`, `PoolDeployer`, `Faucet`
(`AirToken.sol` deleted since the prior rounds and correctly out of scope)
**Passes:** 11
**Primary question:** can LP funds be drained or value stolen?

## Aggregate tally (deduplicated)

```
0 CRITICAL | 0 HIGH | 0 MEDIUM | 6 LOW | 8 INFO | 1 PROCESS
```

**No path was found by which LP funds can be drained or value stolen.**

## Pass coverage

| Pass | File | C | H | M | L | I |
|------|------|---|---|---|---|---|
| Nemesis (Feynman + State, iterated) | `nemesis-verified.md` | 0 | 0 | 0 | 2 | 0 |
| Behavioral State Analysis | `bsa-verified.md` | 0 | 0 | 0 | 1 | 2 |
| DoS & Griefing | `dos-griefing-verified.md` | 0 | 0 | 0 | 2 | 0 |
| External Call Safety | `external-call-safety-verified.md` | 0 | 0 | 0 | 1 | 1 |
| Input & Arithmetic | `input-arithmetic-safety-verified.md` | 0 | 0 | 0 | 3 | 2 |
| Oracle & Flash Loan | `oracle-flashloan-verified.md` | 0 | 0 | 0 | 2 | 0 |
| Proxy & Upgrade | `proxy-upgrade-safety-verified.md` | 0 | 0 | 0 | 0 | 0 |
| Reentrancy | `reentrancy-verified.md` | 0 | 0 | 0 | 1 | 1 |
| Semantic Guard | `semantic-guard-verified.md` | 0 | 0 | 0 | 0 | 2 |
| Signature & Replay | `signature-replay-verified.md` | 0 | 0 | 0 | 0 | 0 |
| State Invariant | `state-invariant-verified.md` | 0 | 0 | 0 | 0 | 0 |

Feynman and State Inconsistency are run as the two halves of the Nemesis loop
rather than as standalone passes, matching the prior rounds' structure.

## The most important finding is not a code defect

**PROCESS-001 — the prior audit reports did not describe the deployed code.**

`.audit/findings-fable5/nemesis-verified.md` (2026-07-09) asserts that the only
post-audit change was `PositionNFT` display code and that it "does not touch pool
accounting, custody, or any value-moving code". At the time of this audit,
`git diff --stat HEAD` reported **1,171 changed lines in `EXNIHILOPool.sol`**,
a deleted `AirToken.sol`, `EXNIHILOFactory` +77 and `EXNIHILORouter` +57 — all
uncommitted.

The entire renewal / auto-renew / keeper / claim subsystem had never been audited
by any prior pass, and was deployed to Fuji on the strength of that assertion.

**Action:** commit the contracts so each audit has a real baseline, and derive
"delta since last audit" from git rather than asserting it.

## Changes made during this audit

| Change | Rationale | Verification |
|---|---|---|
| `totalShortCollateral` accumulator added to `_assertReserveInvariant` | `openShort` moved USDC out of `backedAirUsd` into position `lockedAmount`, where the invariant stopped tracking it — it could not detect a leak of short collateral | Exhaustive mutation proof (3 sites, all mirrored); conservation algebra per branch; `slack = 0` empirically; 394 tests pass |
| `if (netOut == 0) revert InsufficientOutput();` in both swap paths | A trade large enough that the fee outgrew raw output took the caller's input and returned nothing | 394 tests pass; manipulation harnesses updated to treat a reverting pump as "attack impossible" |

Both are in `EXNIHILOPool.sol`. Test suite before and after: **394 passing,
8 failing** — the same 8 pre-existing `Coverage.ts` storage-slot failures.

## Open findings

| ID | Severity | Status | Title |
|----|----------|--------|-------|
| NM-OP5-001 | LOW | **FIXED** | `swap()` accepted a zero-output trade |
| NM-OP5-002 / LOW-DOS-2 / INFO-BSA-1 | LOW | Open | `factory.deployer()` can force-close every pool |
| LOW-BSA-1 | LOW | Mitigated | LP exit requires all positions settled (bounded by `closePool`) |
| LOW-DOS-1 | LOW | Narrowed | Blacklisted treasury blocks its own fee claims (`to` param mitigates) |
| ECS-1 | LOW | Half-closed | Rebasing tokens; inbound half now impossible via `_transferIn` |
| IA-3 | LOW | Mitigated | Open fees round down (`MIN_POSITION_FEE` floor) |
| IA-6 | LOW | Open | Tokens with >38 decimals can overflow `_cpAmountOut` |
| OFL-1 / OFL-2 | LOW | Accepted | Flash-loan manipulation — uneconomical, now harder still |
| RE-1 | LOW | Accepted | Read-only reentrancy with an ERC-777 underlying |
| INFO-SGA-1 | INFO | Open | `setPositionCaps` lacks `nonReentrant` (no value movement) |
| NM-001 | LOW | Open | `PositionNFT` mint reachable before `initFactory` (one-tx window) |
| NM-002 | LOW | Open | Factory residual approvals not revoked |
| NM-005 / INFO-IA-1 | INFO | Open | `createMarket` lacks explicit token validation |

## Closed since the prior rounds

- **NM-003** — no keeper incentive → closed by `KEEPER_BOUNTY`.
- **NM-004** — anyone-can-renew LP griefing → closed; `renewPosition` now
  requires `positionNFT.ownerOf(nftId) == msg.sender`.
- **DoS-2** — blacklisted holder blocks LP exit → closed more strongly than
  before: `_trySendUsdc`'s try/catch was replaced by the `_creditPayout` pull
  payment, so funds are never pushed at all.
- **ECS-1 inbound** — `_transferIn` now reverts `FeeOnTransferNotSupported`.

## Structural properties worth stating

These eliminate whole vulnerability classes rather than individual bugs:

- **No loops** in any contract → unbounded-loop / gas-limit DoS impossible.
- **No `unchecked` blocks** → every accounting desync fails closed (revert)
  rather than open (wrap).
- **No `delegatecall`, no proxies** → no upgrade or storage-collision surface.
- **No signatures** → no replay surface of any kind.
- **No oracles** → pricing is self-referential; oracle manipulation collapses
  into AMM manipulation, which is fee-bounded and empirically tested.
- **No shares** (single LP per pool) → no dilution, inflation, or
  first-depositor vector.
- **Pull payments** for all fees and third-party payouts.

## Test suite — FIXED and extended

**Status: 414 passing, 0 failing.**

The 8 previously-failing `Coverage.ts` "storage-forced" tests hardcoded a slot
map invalidated by OpenZeppelin 5.6: `ReentrancyGuard` no longer declares a
sequential `uint256 private _status` (it uses a namespaced ERC-7201 slot), so
every pool variable sits one slot lower. Corrected against live storage
(slot 0 = `maxPositionUsd` = `0x989680`, slot 2 = `airTokenSupply`,
slot 4/5 = `backedAirToken`/`backedAirUsd`), and both documenting comment blocks
were rewritten so the map cannot mislead again. `totalShortCollateral` was
appended at the end of storage (slot 16) so nothing shifted further.

### New coverage added for this round's changes

Neither change shipped with tests; both now have them, and **both suites were
mutation-tested** — a passing test proves nothing unless it can fail.

`test/ShortCollateralInvariant.ts` — 7 tests:
starts at zero; longs never touch it; equals the sum of open short
`lockedAmount` (asserted after *every* open, not just at the end); returns to
zero once all shorts settle; reserve invariant stays **exactly** zero-slack
across the lifecycle; auto-renew reduces it by exactly the amount the position
lost; invariant stays exact through an auto-renew.

`test/ZeroOutputSwap.ts` — 5 tests:
both swap directions revert at zero output; **no value is taken from the caller
when it reverts**; normal-sized swaps unaffected; `minAmountOut` still honoured.

### Mutation results

| Mutation | Caught |
|---|---|
| `openShort` increments by half the collateral | 4 / 7 fail ✓ |
| `_tryAutoRenew` short decrement removed | 2 / 7 fail ✓ |
| `netOut == 0` guard removed (both paths) | 3 / 5 fail ✓ |

The auto-renew mutation initially escaped: the first version of that test used
an `if/else` that passed whether or not auto-renew actually fired, and the short
could not pay the fee so it silently settled instead. Rewritten to force the
position profitable (dumping token into the pool so the buyback is cheaper) and
to assert `openPositionCount == 1` unconditionally, so a fallthrough to
settlement now fails rather than passes. This is exactly the class of weak test
that mutation testing exists to catch.

## Recommendations, in priority order

1. **Commit the contracts.** PROCESS-001 is the finding most likely to cause a
   real incident, because it makes every other assurance unverifiable.
2. **Decide the emergency-deployer policy** — timelock, multisig, or zero it
   after launch.
3. **Fix the `Coverage.ts` slot map** so the suite is green and regressions are
   visible.
4. **Bound `tokenDecimals` in `createMarket`** (closes IA-6).
5. Add `nonReentrant` to `setPositionCaps` for consistency.

## Scope limits

Reviewed in depth: `EXNIHILOPool` custody, accounting conservation, access
control, keeper/auto-renew value flows, swap math; `PositionNFT`'s
position-mutation surface; `EXNIHILORouter`'s approval and fee-quoting paths;
`Faucet`'s value paths.

Reviewed at surface level only: `PositionNFT`'s SVG/metadata rendering (a `view`
path wrapped in try/catch), `LpNFT`, `PoolDeployer`, and
`EXNIHILOFactory.createMarket` input validation beyond the `decimals()` fallback.

No formal verification or fuzzing campaign was run. The manipulation-safety and
parametric grids in `test/` are the strongest economic evidence available here,
and they are scenario-based rather than exhaustive.
