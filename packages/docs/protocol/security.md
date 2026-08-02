---
description: "EXNIHILO's security posture — reentrancy guards, the CEI pattern, immutability, the single privileged role, and four published AI audit rounds."
---

# Security

EXNIHILO prioritizes security through multiple layers of protection.

## Reentrancy protection

Every state-changing external function in EXNIHILOPool and EXNIHILOFactory uses OpenZeppelin's `ReentrancyGuard`. This prevents callbacks from re-entering the contract during token transfers.

## CEI pattern

All functions follow the Checks-Effects-Interactions pattern:
1. **Checks** — validate inputs, permissions, caps
2. **Effects** — update all state variables
3. **Interactions** — make external calls (transfers, mints)

This ordering ensures that even if reentrancy guard were bypassed, state is already updated before any external call.

## Reserve invariant

`_assertReserveInvariant()` runs after every state-changing operation and
reverts if any of four conditions fails:

```
backedAirToken ≤ airTokenSupply
backedAirUsd   ≤ airUsdSupply

underlyingToken.balanceOf(pool) ≥ backedAirToken

underlyingUsdc.balanceOf(pool)  ≥ backedAirUsd
                                + totalShortCollateral
                                + lpFeesAccumulated
                                + protocolFeesAccumulated
                                + totalClaimable
```

The first two say the pool never claims more backing than its supply counters
allow — the gap between them is the outstanding synthetic debt. The last two
check **real token balances** against every liability the pool carries: LP
reserves, collateral locked by open shorts, unclaimed fees, and credited
payouts.

`totalShortCollateral` matters more than it looks. `openShort` moves real USDC
out of `backedAirUsd` and records it as the position's `lockedAmount` — still
held by the pool, but owed to the trader. Without that term the check passed
whether or not the collateral was still there. With it, the fourth condition is
an exact conservation law rather than a loose lower bound.

Because there are no `unchecked` blocks anywhere in the protocol, an accounting
desync that would drive any counter negative reverts rather than wrapping. The
pool fails closed, not open.

## Fee-on-transfer protection

The `_transferIn()` helper verifies that the actual tokens received match the expected amount:

```solidity
uint256 before = token.balanceOf(address(this));
token.safeTransferFrom(msg.sender, address(this), amount);
uint256 after = token.balanceOf(address(this));
if (after - before != amount) revert FeeOnTransferNotSupported();
```

This rejects fee-on-transfer, rebasing, and deflationary tokens that would break the accounting.

## Zero-output guards

Operations that would produce zero output are rejected rather than silently
taking the caller's input:

- `if (airTokenOut == 0) revert ZeroAmount()` on `openLong`
- `if (airUsdOut == 0) revert ZeroAmount()` on `openShort`
- `if (netOut == 0) revert InsufficientOutput()` on both swap directions

The swap guard closes a case where the fee could exceed the raw output. Because
`_cpAmountOut` divides the fee by `reserveIn` rather than `reserveIn + amountIn`,
the effective rate is `swapFeeBps × (1 + amountIn/reserveIn)` — it rises with
trade size, and past roughly 99× the reserve (at a 1% fee) it consumes the whole
output. A caller passing `minAmountOut = 0` in that regime previously paid for
nothing. That fee shape is deliberate: it never *under*charges, which is the
conservative direction, and it makes large price manipulation progressively more
expensive.

## Slippage protection

All swaps and position opens accept `minAmountOut`. Transactions revert if output falls below this threshold.

## Safe token handling

All token operations use OpenZeppelin's `SafeERC20` library, which handles non-standard ERC-20 implementations (missing return values, etc.).

## Immutable architecture

- The Factory has no owner and no admin functions
- Pool parameters (swap fee, position duration, treasury, NFT contracts) are immutable after deployment
- `PositionNFT`'s factory binding is one-shot via `initFactory()`
- Position state can only be mutated by the owning pool (`applyRenewal` checks `msg.sender == pos.pool`)
- No proxy patterns, no `delegatecall`, no upgradability

Immutability cuts both ways: because nothing is upgradeable, a defect in a
deployed pool is permanent. The only remediation is deploying a new factory and
migrating liquidity.

One privileged role remains: `EXNIHILOFactory.deployer` can call `closePool()`
on any pool, forcing it into wind-down. It moves no value — positions still
settle and LPs still withdraw — but it is unilateral. The role is transferable
and can be set to `address(0)` to relinquish it permanently.

## Audit status

Four automated audit rounds have been performed, each across 11 independent
analysis passes using distinct model generations. The most recent supersedes the
others.

### Latest: Claude Opus 5 (2026-07-27)

**Scope:** EXNIHILOPool, PositionNFT, EXNIHILOFactory, EXNIHILORouter, LpNFT,
PoolDeployer, Faucet. (`AirToken.sol` was removed from the protocol before this
round — `airToken`/`airUsd` are supply counters inside the pool, not contracts.)

**Result: 0 Critical | 0 High | 0 Medium | 6 Low | 8 Info | 1 Process**

No path was found by which LP funds can be drained or value stolen.

The round's most serious finding was **not a code defect**: the previous
(Fable 5) report asserted that the only change since the 4.7 audit was
`PositionNFT` display code, when in fact ~1,171 lines of `EXNIHILOPool.sol` had
changed and the entire renewal / auto-renew / keeper / claim subsystem had never
been audited. Audit deltas must be derived from version control, not asserted.

Two fixes were applied during the round:

| Fix | Rationale |
|---|---|
| `totalShortCollateral` added to the reserve invariant | `openShort` moves USDC out of `backedAirUsd` into a position's `lockedAmount`; the invariant had stopped tracking it, so it could not detect a leak of short collateral. The invariant is now an exact conservation law (verified zero slack). |
| `if (netOut == 0) revert InsufficientOutput()` on both swap paths | A trade large enough that the fee exceeded raw output took the caller's input and returned nothing. |

Both shipped with mutation-tested coverage (`ShortCollateralInvariant.ts`,
`ZeroOutputSwap.ts`).

Full reports: [`.audit/findings-opus5/`](https://github.com/Red-Goglz/EXNIHILO/tree/main/.audit/findings-opus5).

### Claude Fable 5 (2026-07-09) — superseded

Reported 0 Critical / 0 High / 0 Medium / 4 Low. Retained here for the record,
but its central claim — that nothing value-moving had changed since the 4.7
round — did not hold, so its clean result should not be read as covering the
renewal, auto-renew, keeper or claim subsystems. Superseded by the Opus 5 round
above. Reports: [`.audit/findings-fable5/`](https://github.com/Red-Goglz/EXNIHILO/tree/main/.audit/findings-fable5).

### Re-audit: Claude Opus 4.7 (2026-04-17, remediated 2026-04-18)

**Scope:** EXNIHILOPool, PositionNFT, EXNIHILOFactory, EXNIHILORouter, LpNFT, AirToken (+ PoolDeployer for proxy/upgrade pass)

**Result (post-remediation): 0 Critical | 0 High | 0 Medium | 4 Low | 4 Info**

The 4.7 re-audit surfaced one token-conditional HIGH and four MEDIUMs that the 4.6 pass missed, including the accounting side-effect of the DoS-2 fix itself. All HIGH and MEDIUM findings have been remediated.

| Pass | Focus | Findings (at audit) |
|------|-------|---------------------|
| Nemesis (Feynman + State Inconsistency + Fusion) | Iterative triple-engine deep audit | 2M, 6L, 1I |
| Behavioral State Analysis | Economic, access control, state integrity | 1M, 5L, 1I |
| DoS & Griefing | Unbounded loops, external call failure, storage bloat | 1M, 5L |
| External Call Safety | Unchecked returns, fee-on-transfer, rebasing, ERC-777 | 1H (conditional), 3L, 1I |
| Input & Arithmetic | Zero checks, rounding, overflow, dust amounts | 2M, 6L, 4I |
| Oracle & Flash Loan | Price manipulation, flash loan vectors | 2M, 2L |
| Proxy & Upgrade | Storage collisions, initialization, selector clashing | 1L, 1I |
| Reentrancy | Classic, cross-function, cross-contract, read-only | 1L |
| Semantic Guard | Guard consistency across all state variables | 1M, 2L, 1I |
| Signature & Replay | Signature verification, replay vectors | Clean |
| State Invariant | Mathematical invariant detection and verification | 1H, 1L, 1I |

Cross-pass consensus was strong: the two top issues (`_trySendUsdc` accounting leak and the Router fee-race + permissionless `sweep` chain) were each independently flagged by 5-8 of the 11 passes.

### Remediation (2026-04-18)

| Patch | File(s) | Closes |
|-------|---------|--------|
| Socialize failed `_trySendUsdc` payouts into `lpFeesAccumulated` | `EXNIHILOPool.sol` | SI-001, ECS-2, NM-008, BSA-6, DoS-5 |
| Router residual refund to caller + delete `sweep()` | `EXNIHILORouter.sol` | NM-006, NM-009, DoS-4, DoS-6, IA-10, SI-002, ECS-4, OFL-4 |
| `closeShort` underflow guard mirroring `closeLong` | `EXNIHILOPool.sol` | SGA-2, IA-8 |
| `MIN_SWAP_FEE_BPS = 100` floor (1 %) | `EXNIHILOPool.sol` | OFL-3; strengthens OFL-1 / OFL-2 accept-posture |
| `setDeployer` NatSpec clarifying `address(0)` is deliberate for permissionless handoff | `EXNIHILOFactory.sol` | NM-007, IA-7, SGA-4 (accepted-with-documentation) |

Remaining open items are LOW or INFO: either mitigated by existing protocol mechanisms (atomic deployment, `closePool` fallback, MIN_POSITION_FEE), accepted by design (theoretical ERC-777 read-only reentrancy, treasury blacklist), or tied to pathological LP token choices (rebasing, extreme decimals).

Full pass-by-pass reports: [`.audit/findings-4.7/`](https://github.com/Red-Goglz/EXNIHILO/tree/main/.audit/findings-4.7).

### Original audit: Claude Opus 4.6 (2026-04-04)

The 4.6 pass found 0 Critical, 0 High, 1 Medium (DoS-2: blacklisted holder blocks LP exit — fixed via `_trySendUsdc` try/catch), 7 Low, 6 Info. Nine dedicated tests in `BlacklistResilience.ts` confirmed the DoS-2 fix. Full reports: [`.audit/findings/`](https://github.com/Red-Goglz/EXNIHILO/tree/main/.audit/findings).

::: warning
All four rounds were performed by AI models, not human auditors. They cover a wide range of vulnerability classes, and each round has independently surfaced findings its predecessors missed — but they do not replace a formal professional audit. Use at your own risk.
:::

## Test coverage

The protocol has **414 tests** covering:
- Core logic (swaps, positions, liquidity)
- Edge cases and boundary conditions
- Reentrancy attack vectors
- Fee-on-transfer rejection
- Zero-output guards
- Factory fallback behavior
- Blacklist resilience (DoS-2 fix + 4.7 socialization extension)
- Router residual refund and `sweep()` removal (4.7 Router fix)
- `closeShort` underwater revert path
- `MIN_SWAP_FEE_BPS` constructor floor (0 / 99 / 100 / 10000 boundaries)
