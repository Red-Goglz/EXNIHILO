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

::: warning
EXNIHILO has not yet undergone a formal security audit. Use at your own risk.
:::

## Test coverage

The protocol has ~150 tests covering:
- Core logic (swaps, positions, liquidity)
- Edge cases and boundary conditions
- Reentrancy attack vectors
- Fee-on-transfer rejection
- Zero-output guards
- Factory fallback behavior
