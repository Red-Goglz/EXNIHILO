# Reentrancy — Verified (Opus 5)

**Date:** 2026-07-27
**Scope:** `EXNIHILOPool`, `PositionNFT`, `EXNIHILOFactory`, `EXNIHILORouter`, `LpNFT`, `Faucet`

```
0 CRITICAL | 0 HIGH | 0 MEDIUM | 1 LOW (accepted, carried) | 1 INFO
```

## Guard coverage

`EXNIHILOPool` declares 26 `external` functions. Every one that mutates state
carries `nonReentrant`, with a single exception analysed below. The remainder
are `view` (`spotPrice`, `longPrice`, `shortPrice`, `effectiveLeverageCap`,
`isClosing`, `quoteOpenFee`, `quoteRenewFee`, `quoteClose`, `indexerState`,
`getAutoRenew`) or interface declarations, not implementations.

## CEI ordering — verified per value-moving path

Each of these commits state before any external interaction, and asserts the
reserve invariant afterwards:

| Function | Effects before interactions | Invariant asserted |
|---|---|---|
| `openLong` / `openShort` | supply + reserve counters, `openPositionCount++` | ✓ |
| `addLiquidity` | all four counters | ✓ |
| `removeLiquidity` | counters zeroed before both transfers | (holds by construction) |
| `_settle` (all 4 branches) | counters, `openPositionCount--`, accumulators | ✓ |
| `_tryAutoRenew` | reserves, OI, `applyRenewal`, fee accrual, then bounty transfer | ✓ |
| `claimFees` / `claimProtocolFees` | accumulator zeroed, paid-total incremented | n/a (no reserve change) |
| `claimPayout` | `claimable[msg.sender] = 0`, `totalClaimable -=` | n/a |
| `_swapUsdcToToken` / `_swapTokenToUsdc` | supplies + reserves | ✓ |

The three claim functions are the classic reentrancy shape (read balance →
transfer). All three zero the balance **before** `safeTransfer`, so a reentrant
call reads zero and reverts on `ZeroAmount()`.

## The pull-payment redesign removes the highest-risk path

Third-party settlement no longer pushes USDC to the position holder. `_settle`
calls `_creditPayout(holder, netSurplus)` when `viaExpiry` is true, and the
holder later withdraws via `claimPayout(to)`. This removes an attacker-chosen
callee from the settlement path entirely. Direct `safeTransfer` to the holder
remains only on self-close, where the holder is `msg.sender` and already
controls the transaction.

## INFO-RE-1 — `setPositionCaps` is not `nonReentrant`

`EXNIHILOPool.sol:372`. State-changing and `external`, but not guarded.

Assessed as non-issue: the only external call in its path is
`lpNftContract.ownerOf()` inside `onlyLpHolder`, and `LpNFT` is a protocol
contract deployed by the factory, not attacker-supplied. The function writes two
`uint256` config values and moves no value. Even under hypothetical reentry the
worst outcome is the caps ending at one of the caller's own chosen values.
Adding the modifier would be free consistency, not a fix.

## RE-1 (carried, accepted) — read-only reentrancy with an ERC-777 underlying

Unchanged from prior rounds. If a market creator chooses an ERC-777-style
underlying token with transfer hooks, the hook fires during `safeTransfer` in
`removeLiquidity` / `_swapUsdcToToken`, at which point an external observer
could read mid-update reserve values.

Still LOW, and now weaker than before: the reserve invariant is asserted after
every such path, and `_transferIn` rejects any token whose balance delta does
not equal the requested amount. Exploiting it requires the LP to deliberately
create a market against a hook-bearing token, and yields an observation rather
than a state change.

## Faucet

`Faucet.claim()` has no `nonReentrant`, but sets `lastClaim[msg.sender] =
block.timestamp` **before** `msg.sender.call{value: ...}`. A reentrant call
evaluates `block.timestamp >= lastClaim[msg.sender] + cooldown`, i.e.
`t >= t + 24 hours`, which is false — it reverts. The cooldown write acts as the
guard. `withdraw()` is `onlyOwner` and returns funds to the owner.

Both low-level calls check their return value (`require(ok, ...)`).

## Structural note

There are **no loops** in any contract in the protocol, so no reentrancy variant
that depends on partial loop progress (batch operations, multi-recipient
distribution) can exist.
