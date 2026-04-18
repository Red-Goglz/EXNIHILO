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

After every operation:

```
backedAirToken ≤ airToken.totalSupply()
backedAirUsd  ≤ airUsd.totalSupply()
```

This is checked at the contract level and prevents the pool from becoming insolvent.

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

Position opens that would produce zero output tokens are rejected:
- `if (airTokenOut == 0) revert ZeroAmount()` on openLong
- `if (airUsdOut == 0) revert ZeroAmount()` on openShort

This prevents dust attacks and economically meaningless positions.

## Slippage protection

All swaps and position opens accept `minAmountOut`. Transactions revert if output falls below this threshold.

## Safe token handling

All token operations use OpenZeppelin's `SafeERC20` library, which handles non-standard ERC-20 implementations (missing return values, etc.).

## Immutable architecture

- The Factory has no owner and no admin functions
- Pool parameters (swap fee, treasury, NFT contracts) are immutable after deployment
- AirToken's pool binding is one-shot via `initPool()`
- No proxy patterns, no upgradability

## Audit status

Two automated security audits have been performed against the protocol, each across 11 independent analysis passes using distinct model generations.

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

Full pass-by-pass reports: [`.audit/findings-4.7/`](https://github.com/bravenoob/exnihilo-dapp/tree/main/.audit/findings-4.7).

### Original audit: Claude Opus 4.6 (2026-04-04)

The 4.6 pass found 0 Critical, 0 High, 1 Medium (DoS-2: blacklisted holder blocks LP exit — fixed via `_trySendUsdc` try/catch), 7 Low, 6 Info. Nine dedicated tests in `BlacklistResilience.ts` confirmed the DoS-2 fix. Full reports: [`.audit/findings/`](https://github.com/bravenoob/exnihilo-dapp/tree/main/.audit/findings).

::: warning
Both audits were performed by AI models, not human auditors. While they cover a wide range of vulnerability classes and the 4.7 re-audit independently surfaced findings the 4.6 pass missed, they do not replace a formal professional audit. Use at your own risk.
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
