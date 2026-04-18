# Reentrancy Pattern Analysis — EXNIHILO 4.7

## Scope

`EXNIHILOPool.sol`, `PositionNFT.sol`, `EXNIHILOFactory.sol`, `EXNIHILORouter.sol`, `LpNFT.sol`, `AirToken.sol`.

## Methodology

Check every variant:
1. Classic reentrancy (CEI violation — external call before state write).
2. Cross-function reentrancy.
3. Cross-contract reentrancy.
4. Read-only reentrancy (view reads inconsistent state during reentry).
5. Callback vectors — ERC-777 `tokensReceived`, ERC-1155/721 hooks, FoT/rebasing, `.call{value:}`.
6. `nonReentrant` placement on all entry points making external calls.
7. NFT `_safeMint` callbacks.
8. Post DoS-2 fix: does `_trySendUsdc` try/catch open a new reentry window?

## Call Graph (key external functions)

| Function | External calls | `nonReentrant` | CEI compliance |
|----------|---------------|----------------|----------------|
| `openLong` | `usdc.transferFrom`, `airToken.mint`, `_safeMint PositionNFT` | ✓ | State written before transfer |
| `openShort` | `airUsd.transferFrom` (internal), `_safeMint PositionNFT` | ✓ | State written before transfer |
| `closeLong` | `airToken.burn`, `usdc.transfer` (last), `PositionNFT.release` | ✓ | State before ext |
| `closeShort` | `airUsd.burn`, `usdc.transfer` (last) | ✓ | State before ext |
| `realizeLong` | `underlying.transfer`, `airToken.mint` | ✓ | **See RE-1** |
| `realizeShort` | `underlying.transferFrom`, `airToken.burn` | ✓ | **See RE-1** |
| `swap` | `underlying.transferFrom/transfer`, `usdc.transferFrom/transfer` | ✓ | Reserves updated pre-transfer |
| `addLiquidity` / `removeLiquidity` | `usdc`, `airToken`, `underlying` | ✓ | State before ext |
| `claimFees` | `usdc.transfer` | ✓ | Resets `lpFeesAccumulated` before send |
| `closePositionAfterDeadline` | `_trySendUsdc` | ✓ | See RE-new analysis |
| Router `openLong`/`openShort`/`swap` | `pool` + `usdc`/`underlying` | ✓ | Stateless proxy |

## Prior Findings Re-verified

### RE-1 — Read-only reentrancy with ERC-777 underlying (LOW, Accepted)

**Status:** **Confirmed unchanged.** `realizeShort` (`EXNIHILOPool.sol:875-878`) and `realizeLong` (`EXNIHILOPool.sol:652-655`) write `backedAirToken`/`backedAirUsd` AFTER the `_transferIn`. With an ERC-777-style underlying, the `tokensReceived` hook fires mid-function. A third-party contract reading pool state via `getReserves`/backed-amount views during the hook sees stale values. Theoretical; requires ERC-777 underlying AND a live consumer of these views on-chain simultaneously.

**Mitigation:** LP creator's token choice. Protocol-level mitigation would require CEI reordering or a reentrancy-lock visibility check on view functions.

## New Analysis (4.7)

### `_trySendUsdc` Try/Catch — CLEAN

The DoS-2 fix at `EXNIHILOPool.sol:1353-1361`:

```solidity
function _trySendUsdc(address to, uint256 amount) internal returns (bool) {
    try IERC20(usdc).transfer(to, amount) returns (bool ok) {
        return ok;
    } catch {
        emit PayoutFailed(to, amount);
        return false;
    }
}
```

Called from `_closeExpiredLong`/`_closeExpiredShort`. USDC is standard ERC-20 (no recipient callback), so there's no reentry window through the transfer itself. All pool state (`backedAirUsd`, position NFT burn, airUsd burn, counters) is committed BEFORE the call, making this path strictly safer than `realizeLong`/`realizeShort`. No new reentrancy surface.

(Note: the `try` still fails with USDT-style no-return-value tokens — that's an ECS finding, not reentrancy.)

### `closePool` — CLEAN

`closePool` (`EXNIHILOPool.sol:320-333`) calls `lpNftContract.ownerOf(0)` and `factory.deployer()` before writing `closeDate`. Both callees are trusted immutables with no user-controlled callbacks; `nonReentrant` is held; `closeDate == 0` means no financial state is stale during the read. Not exploitable.

### NFT `_safeMint` — CLEAN

`_safeMint` in `PositionNFT` and `LpNFT` can trigger `onERC721Received` on the recipient. `nonReentrant` is applied to all pool functions that mint, and all state mutations (counter increments, `positions[id]` writes, reserve updates) happen BEFORE `_safeMint`. No cross-function attack path found.

### `_assertReserveInvariant` — CLEAN

When present, it runs after state writes. Not a reentry vector.

## Delta vs 4.6

- RE-1 **Confirmed unchanged.**
- `_trySendUsdc` (new function post-4.6) audited — no new reentrancy surface.
- `closePool` path (reviewed fresh) — no new reentrancy surface.
- `nonReentrant` coverage on all external value-moving functions **verified complete**.
- **No new reentrancy findings.**

**Severity tally:** 4.6 = 0C/0H/0M/1L/0I → 4.7 = 0C/0H/0M/1L/0I. No change.
