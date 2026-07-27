# External Call Safety — Verified (Opus 5)

**Date:** 2026-07-27
**Scope:** `EXNIHILOPool`, `EXNIHILORouter`, `EXNIHILOFactory`, `PositionNFT`, `Faucet`

```
0 CRITICAL | 0 HIGH | 0 MEDIUM | 1 LOW (carried, narrowed) | 1 INFO
```

## Return values: all checked

Every ERC-20 interaction goes through OpenZeppelin `SafeERC20`
(`safeTransfer` / `safeTransferFrom` / `forceApprove`) — 12 call sites in
`EXNIHILOPool`, 10 in `EXNIHILORouter`. A grep for raw `.transfer(` /
`.transferFrom(` / `.approve(` outside those wrappers returns **zero matches**.

This covers tokens that return no boolean (USDT-style) and tokens that return
`false` instead of reverting.

The only low-level calls in the protocol are the two in `Faucet.sol` (49, 73),
and both check the result (`require(ok, ...)`).

## Fee-on-transfer: explicitly rejected, not merely assumed away

`_transferIn` measures the actual balance delta and reverts if it does not equal
the requested amount:

```solidity
uint256 balanceBefore = token.balanceOf(address(this));
token.safeTransferFrom(from, address(this), amount);
if (token.balanceOf(address(this)) - balanceBefore != amount) {
    revert FeeOnTransferNotSupported();
}
```

This is a genuine improvement over the previously audited code and closes the
inbound half of prior finding **ECS-1**. A fee-on-transfer token can no longer
silently under-fund the pool while the accounting credits the full amount.

Every inbound path uses it: `openLong`, `openShort`, `renewPosition`,
`addLiquidity`, and both swap directions.

## Return-data bombs / gas stipend

No `.call{gas:}` with attacker-controlled callees, no `abi.decode` of unbounded
external return data, and no reliance on the 2300-gas stipend (no `.send` /
`.transfer` of native value in the pool). The Faucet's `call{value:}` forwards
all gas but is guarded by CEI + cooldown (see the reentrancy report).

## ERC-721 callback surface

`PositionNFT` and `LpNFT` extend OpenZeppelin ERC-721. Minting uses `_mint`,
**not** `_safeMint`, in the pool-driven paths, so no `onERC721Received` callback
fires into an attacker-controlled recipient during `openLong` / `openShort` /
`createMarket`. That removes the callback reentrancy vector at position creation.

`release(nftId)` (burn) likewise triggers no callback.

## Trusted-callee inventory

Every external call from `EXNIHILOPool` targets either an immutable
protocol-deployed contract or the market's own tokens:

| Callee | How it is fixed |
|---|---|
| `positionNFT` | immutable, set in constructor |
| `lpNftContract` | immutable, set in constructor |
| `factory` | immutable, set in constructor |
| `underlyingToken` / `underlyingUsdc` | immutable, chosen by the market creator |

There is no path where a caller supplies an arbitrary contract address that the
pool then calls. `EXNIHILORouter` restricts its pool argument with
`onlyPool(pool)`, checked against the factory registry.

## Router residual handling

`EXNIHILORouter` sets an allowance, calls the pool, then clears it in the same
transaction:

```solidity
usdc.forceApprove(pool, fee);
IEXNIHILOPool(pool).openLong(...);
usdc.forceApprove(pool, 0);
_refundResidual(usdc, balBefore, msg.sender);
```

`_refundResidual` uses a balance delta against `balBefore`, so pre-existing dust
from donations or accidents is never attributed to the current caller. No
standing allowance is left behind.

Note the router quotes fees from the pool (`_positionFee` →
`IEXNIHILOPool(pool).quoteOpenFee`) rather than replicating the formula — the
correct pattern, and the one the frontend was fixed to follow this session.

## ECS-1 (carried, narrowed) — rebasing tokens

A token that rebases **while held** by the pool still breaks accounting, because
`backedAirToken` / `backedAirUsd` are counters maintained independently of the
live balance. `_assertReserveInvariant` compares them as a lower bound, so a
*negative* rebase would trip the invariant and freeze the pool (safe failure),
while a *positive* rebase would leave un-attributed surplus.

Severity remains LOW: it requires the market creator to deliberately select a
rebasing underlying, and the inbound half is now impossible thanks to
`_transferIn`. Documented as a market-creator responsibility.

## INFO-ECS-1 — `decimals()` fallback in the factory

`EXNIHILOFactory.sol:203` wraps `IERC20Decimals(tokenAddress).decimals()` in
try/catch with a fallback. Correct handling for tokens that omit the optional
method. Worth noting that the fallback value is then baked into the pool as
immutable `tokenDecimals`; a token that reports wrong decimals produces a
mispriced market. That is inherent to permissionless market creation and is the
creator's risk, not a protocol defect.
