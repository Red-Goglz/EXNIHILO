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

An automated security audit was performed using **Claude Opus 4.6** (Anthropic) across 11 independent analysis passes on 2026-04-04.

**Scope:** EXNIHILOPool, PositionNFT, EXNIHILOFactory, EXNIHILORouter, LpNFT, AirToken

**Result: 0 Critical | 0 High | 0 Medium (fixed) | 7 Low | 6 Info**

| Pass | Focus | Findings |
|------|-------|----------|
| Nemesis (Feynman + State Inconsistency) | Iterative dual-engine deep audit | 4L, 1I |
| Behavioral State Analysis | Economic, access control, state integrity | 4L, 1I |
| DoS & Griefing | Unbounded loops, external call failure, storage bloat | 1M (fixed), 2L |
| External Call Safety | Unchecked returns, fee-on-transfer, rebasing, ERC-777 | 1L |
| Input & Arithmetic | Zero checks, rounding, overflow, dust amounts | 2L, 4I |
| Oracle & Flash Loan | Price manipulation, flash loan vectors | 2L |
| Proxy & Upgrade | Storage collisions, initialization, selector clashing | Clean |
| Reentrancy | Classic, cross-function, cross-contract, read-only | 1L |
| Semantic Guard | Guard consistency across all state variables | 1I |
| Signature & Replay | Signature verification, replay vectors | Clean |
| State Invariant | Mathematical invariant detection and verification | Clean |

The single Medium finding (a USDC-blacklisted position holder could block LP exit via expired position cleanup) was fixed with a try/catch wrapper on the affected transfer paths. Nine dedicated tests confirm the fix.

::: warning
This audit was performed by an AI model, not a human auditor. While it covers a wide range of vulnerability classes, it does not replace a formal professional audit. Use at your own risk.
:::

## Test coverage

The protocol has 404 tests covering:
- Core logic (swaps, positions, liquidity)
- Edge cases and boundary conditions
- Reentrancy attack vectors
- Fee-on-transfer rejection
- Zero-output guards
- Factory fallback behavior
- Blacklist resilience (DoS-2 fix)
