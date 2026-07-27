# Semantic Guard Analysis — Verified (Opus 5)

**Date:** 2026-07-27
**Method:** Consistency Principle — the contract is its own specification. Where
a guard is applied consistently across a family of functions, its absence in one
member is a defect candidate.

```
0 CRITICAL | 0 HIGH | 0 MEDIUM | 0 LOW | 2 INFO
```

## Guard matrix — `EXNIHILOPool` state-changing externals

| Function | Reentrancy | Authorization | Pool binding | Slippage | Lifecycle |
|---|---|---|---|---|---|
| `openLong` | ✓ | — (open) | n/a | `minAirTokenOut` | `PoolClosing` |
| `openShort` | ✓ | — (open) | n/a | `minAirUsdOut` | `PoolClosing` |
| `swap` | ✓ | — (open) | n/a | `minAmountOut` + zero-out | reserves ≠ 0 |
| `closeLong` | ✓ | `ownerOf == msg.sender` | `pos.pool == this` | `minUsdcOut` | — |
| `closeShort` | ✓ | `ownerOf == msg.sender` | `pos.pool == this` | `minUsdcOut` | — |
| `renewPosition` | ✓ | `ownerOf == msg.sender` | `pos.pool == this` | `maxFee` | `RenewalExceedsCloseDate` |
| `settleExpired` | ✓ | anyone (by design) | `pos.pool == this` | `minPayout` | `PositionNotExpired` |
| `closePositionAfterDeadline` | ✓ | anyone (by design) | `pos.pool == this` | `minPayout` | `PositionNotExpired` + `AutoRenewActive` |
| `addLiquidity` | ✓ | `onlyLpHolder` | n/a | ratio ±1bp | — |
| `removeLiquidity` | ✓ | `onlyLpHolder` | n/a | n/a | `OpenPositionsExist` |
| `claimFees` | ✓ | `onlyLpHolder` | n/a | n/a | — |
| `claimProtocolFees` | ✓ | `== protocolTreasury` | n/a | n/a | — |
| `claimPayout` | ✓ | per-caller `claimable` | n/a | n/a | — |
| `closePool` | ✓ | LP holder **or** deployer | n/a | n/a | `PoolAlreadyClosed` |
| `setPositionCaps` | **✗** | `onlyLpHolder` | n/a | n/a | bounds 10–9900 |

## No inconsistent-guard defects found

Each column is internally consistent once the design intent is accounted for:

**Pool binding.** Every function that accepts an `nftId` checks
`pos.pool != address(this)`. This is the guard most likely to be forgotten in one
member of a family — all six position-taking functions have it. A position from
pool A cannot be settled against pool B's reserves.

**Authorization is deliberately asymmetric, and correctly so.** The two keeper
entry points (`settleExpired`, `closePositionAfterDeadline`) are intentionally
permissionless — that is the point of a keeper. What makes the asymmetry safe is
that both compensate with a *lifecycle* guard (`block.timestamp < pos.deadline`
→ `PositionNotExpired`) that the holder-only functions do not need. A keeper
cannot act on a live position; a holder can act on their own at any time.

**`AutoRenewActive` is the non-obvious one and it is present.**
`closePositionAfterDeadline` reverts when the holder has opted into auto-renewal,
so the zero-bounty path cannot be used to deny a holder the renewal that
`settleExpired` would have given them. This is exactly the kind of guard whose
absence would be a real finding; it is there.

**Slippage protection is universal.** Every value-moving entry point takes a
user-supplied bound: `minAirTokenOut`, `minAirUsdOut`, `minAmountOut`,
`minUsdcOut`, `minPayout`, `maxFee`. No path forces a user to accept an
unbounded price. `addLiquidity` uses a ratio tolerance instead, which is the
right analogue for a two-sided deposit.

## INFO-SGA-1 — `setPositionCaps` lacks `nonReentrant`

The single gap in the reentrancy column. Assessed as a non-issue in the
reentrancy report (its only external call is `ownerOf` on a protocol-deployed
contract, and it moves no value), but flagged here because the Consistency
Principle is what surfaced it: 14 of 15 state-changing externals carry the
modifier. Adding it costs nothing and removes the outlier.

## INFO-SGA-2 — `_assertReserveInvariant` intentionally omitted in two places

Carried from the prior round's SGA-1. `removeLiquidity` and `renewPosition` do
not call it. Both were verified algebraically this round:

- `removeLiquidity` zeroes `backedAirToken`/`backedAirUsd` and transfers exactly
  those amounts, leaving fee accumulators and `claimable` untouched. The
  invariant holds afterwards by construction.
- `renewPosition` pulls `totalFee` in and credits exactly `totalFee` to the fee
  accumulators — balance and liabilities move together.

Correct by design, not a gap. Adding the assert would be harmless but redundant.

## Cross-contract guard check

`PositionNFT`'s mutating functions are all pool-gated:
`applyRenewal` → `msg.sender != pos.pool` reverts `PositionNotFromPool`;
`mintLong` / `mintShort` / `release` are restricted to factory-registered pools.
No third party can mutate position state. This is the counterpart guard to the
pool's `pos.pool == address(this)` check, and together they close the loop in
both directions.
