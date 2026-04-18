# External Call Safety — EXNIHILO 4.7

## Scope

`EXNIHILOPool.sol` (focus), `PositionNFT.sol`, `EXNIHILOFactory.sol`, `EXNIHILORouter.sol`, `LpNFT.sol`, `AirToken.sol`.

## Patterns Checked

1. Unchecked `call`/`delegatecall`/`staticcall` return values.
2. Fee-on-transfer tokens (balance diff ≠ transfer arg).
3. Rebasing tokens (silent balance drift).
4. Tokens with missing return values (USDT-style — require SafeERC20).
5. ERC-777 callback risks.
6. Unsafe `approve` race (non-zero → non-zero).
7. Return data bombs.
8. Gas stipend limits (`transfer` 2300 gas).
9. Push vs pull payment patterns.
10. SafeERC20 coverage of ALL token transfers.
11. Low-level `.call{value:}` usage.

## Audit of Transfer Sites

All USDC/underlying/airToken/airUsd transfers in `EXNIHILOPool` use OpenZeppelin `SafeERC20` (`safeTransfer`/`safeTransferFrom`/`forceApprove`). The only raw `IERC20.transfer(...)` call is inside `_trySendUsdc` (see ECS-2). No `.call{value:}`, no `delegatecall`, no `staticcall` in the codebase.

## Prior Findings Re-verification

### ECS-1 — Rebasing tokens silently break pool accounting (LOW)

**Status:** **Confirmed unchanged.** Pool tracks reserves via internal mapped state (`backedAirToken`, `backedAirUsd`) and measures incoming amounts as `amount` args (not post-transfer `balanceOf` diffs). Fee-on-transfer and rebasing tokens violate this assumption — the pool would over-credit users.

Mitigation: LP creator chooses the token (permissionless protocol risk). Protocol docs should explicitly warn.

## New Findings (4.7)

### ECS-2 — `_trySendUsdc` uses typed `IERC20.transfer`, breaks on USDT-style tokens (LOW→HIGH conditional, NEW)

**Location:** `EXNIHILOPool.sol:1353-1361`

```solidity
function _trySendUsdc(address to, uint256 amount) internal returns (bool) {
    try IERC20(usdc).transfer(to, amount) returns (bool ok) { return ok; }
    catch { emit PayoutFailed(to, amount); return false; }
}
```

**Bug:** The `try` call type-hints the returned data as `bool`. For tokens that return no data (USDT, BNB), Solidity's ABI decoder fails on empty returndata, the `catch` fires, and `PayoutFailed` is emitted even for successful transfers. Combined with NM-008/DoS-5, this means every expired-close to a non-standard USDC variant permanently strands the payout.

**Severity conditional on token choice:**
- Linea USDC (Circle's, returns `bool`): path is safe → LOW.
- USDT-style variants: every profitable close silently leaks → HIGH.

**Fix:** Use SafeERC20's low-level pattern (call + returndata-length check), or wrap `usdc.transfer` with `SafeERC20.safeTransfer` inside a try/catch at the lower level.

```solidity
function _trySendUsdc(address to, uint256 amount) internal returns (bool) {
    (bool ok, bytes memory ret) = address(usdc).call(
        abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
    );
    if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) {
        emit PayoutFailed(to, amount);
        return false;
    }
    return true;
}
```

### ECS-3 — Factory approval not reset to zero after `addLiquidity` (INFO, NEW)

**Location:** `EXNIHILOFactory.sol:243-246`

```solidity
IERC20(tokenAddress).forceApprove(address(pool), tokenAmount);
IERC20(usdc).forceApprove(address(pool), usdcAmount);
pool.addLiquidity(...);
// no forceApprove(..., 0) after
```

**Analysis:** Under normal flow the factory holds no tokens after seeding, so a residual allowance is unreachable. Defense-in-depth gap: if `addLiquidity` ever under-consumes (rounding edge or future change), a non-zero allowance on the factory-for-pool combination becomes a latent drain path should anyone ever send tokens to the factory.

**Fix:** Append `forceApprove(address(pool), 0)` after `addLiquidity`.

### ECS-4 — Router `sweep()` permissionless token drain (LOW, NEW)

**Location:** `EXNIHILORouter.sol:142-147`

Any caller can drain the router's full balance of any ERC-20. Tokens sent directly (by mistake, or as residuals from fee mis-estimation in `_positionFee`) can be stolen by any front-runner. See DoS-4 / DoS-6 / NM-006 for the chained exploit.

**Fix (preferred):** Refund residuals to `msg.sender` atomically at end of every router function. Then delete `sweep` entirely — the router becomes genuinely stateless between txs.

## Other Patterns — CLEAN

- **Fee-on-transfer / rebasing**: Same as ECS-1. Pool-level mitigation requires balance-delta accounting; current design is value-in-declared-amount.
- **ERC-777 callbacks**: Would only be relevant if `usdc`/`airToken`/`airUsd` were ERC-777. `AirToken` is vanilla ERC-20; USDC is standard ERC-20. LP-chosen underlying could be ERC-777 — see reentrancy RE-1 for the read-only reentrancy surface.
- **Return data bombs**: No contract iterates over multiple external calls' returndata; single-call paths are not vulnerable.
- **Gas stipends**: No `.transfer`/`.send`; all ETH paths absent.
- **Approve race**: All approvals use `forceApprove` (OpenZeppelin pattern that zeroes before setting).
- **Low-level call**: None.

## Delta vs 4.6

- ECS-1 **Confirmed unchanged** (LOW).
- **ECS-2 (LOW→HIGH conditional, NEW)** — USDT-style tokens in `_trySendUsdc` typed try. Severity depends on deployment token.
- **ECS-3 (INFO, NEW)** — factory allowance not reset post-seed.
- **ECS-4 (LOW, NEW)** — Router `sweep()` permissionless drain (chains with DoS/NM findings).

**Severity tally:** 4.6 = 0C/0H/0M/1L/0I → 4.7 = 0C/0H/0M (pending token choice)/**3L**/1I.
