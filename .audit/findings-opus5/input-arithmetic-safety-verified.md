# Input & Arithmetic Safety — Verified (Opus 5)

**Date:** 2026-07-27
**Scope:** `EXNIHILOPool` math paths, `PositionNFT` formatting, `EXNIHILOFactory` validation

```
0 CRITICAL | 0 HIGH | 0 MEDIUM | 3 LOW (carried) | 2 INFO
```

## Overflow / underflow

Solidity **0.8.24** with **zero `unchecked` blocks** anywhere in the protocol
(`grep -nE "unchecked" *.sol` → no matches). Every arithmetic operation reverts
on overflow or underflow. The entire class of silent wraparound is unreachable.

This matters more than usual here, because several accounting decrements would be
catastrophic if they wrapped:

- `backedAirUsd -= cost` in `_tryAutoRenew`
- `airUsdSupply -= pos.airUsdMinted + surplus` in `_settle`
- `totalShortCollateral -= pos.lockedAmount` (added this round)
- `totalClaimable -= amount` in `claimPayout`

All of these revert rather than corrupt on a desync — a safe failure mode, and
the reason the strengthened invariant is a detection mechanism rather than a
liability.

## Rounding direction

252 division sites. The ones that decide value flow round in the protocol's
favour:

**Buyback cost rounds UP** (`_priceClose`, line 1318):
```solidity
uint256 cost = (pos.lockedAmount * pos.airTokenMinted + totalBuyable - 1) / totalBuyable;
```
Ceiling division. A short's cost to close is never understated, so `surplus =
lockedAmount - cost` is never overstated. Rounding favours the LP.

**Swap fee rounds against the trader.** `_cpAmountOut` divides the fee by
`reserveIn` rather than `reserveIn + amountIn`, giving an effective rate of
`f * (1 + amountIn/reserveIn) >= f`. Never undercharges.

**Position fee has a floor.** `_baseFees` applies `MIN_POSITION_FEE` (0.05 USDC)
when 5% of notional falls below it, and splits the floor in the same 3:2 ratio.
This is the mitigation for carried finding **IA-3** (open fees round down): dust
positions cannot pay zero fee.

## Division-before-multiplication

Checked the fee and pricing formulas for precision-destroying ordering. All
multiply first:

```solidity
impactFee = (IMPACT_FEE_BPS * notional * (2 * oi + notional))
          / (2 * backedAirUsd * BPS_DENOM);          // single trailing division

rawOut    = (amountIn * reserveOut) / (reserveIn + amountIn);
spotPrice = (backedAirUsd * (10 ** uint256(tokenDecimals))) / backedAirToken;
```

No intermediate truncation before a subsequent multiply.

## Zero-value and zero-address validation

24 `ZeroAddress()` / `ZeroAmount()` guard sites in `EXNIHILOPool`. Entry points
verified:

| Function | Guards |
|---|---|
| `openLong` / `openShort` | `usdcAmount == 0`, `recipient == 0`, reserves non-zero |
| `swap` | `amountIn == 0`, `recipient == 0`, reserves non-zero, **and now `netOut == 0`** (NM-OP5-001, fixed) |
| `addLiquidity` | `tokenAmount == 0 \|\| usdcAmount == 0`, ratio within 1bp |
| `removeLiquidity` | `openPositionCount != 0`, `backedAirToken == 0 && backedAirUsd == 0` |
| `claimFees` / `claimProtocolFees` / `claimPayout` | `to == 0`, `amount == 0` |

Division-by-zero is guarded by early returns rather than reverts in the price
views (`if (backedAirToken == 0) return 0;`), and by
`if (reserveIn == 0 \|\| reserveOut == 0) return 0;` in `_cpAmountOut`.

## Casting

Only two narrowing/signed casts exist in value paths, both in `quoteClose`
(a `view`):

```solidity
if (deficit > 0) return (true, -int256(deficit));
return (true, int256(surplus - (surplus * CLOSE_FEE_BPS) / BPS_DENOM));
```

`deficit` and `surplus` are USDC-scale (6 decimals) quantities bounded by pool
reserves; reaching `2^255` would require reserves beyond total token supply.
`PositionNFT`'s `uint256(pnl)` / `uint256(-pnl)` casts (lines 396, 399) are
inside the `tokenURI` display path, already wrapped in try/catch, and cannot
affect accounting.

No `uint128` / `uint64` / `uint32` narrowing anywhere.

## ERC-4626-style share inflation

Not applicable. There are no shares. Each pool has exactly one LP, identified by
an NFT, holding 100% by construction. `addLiquidity` enforces the current reserve
ratio to 1bp; `removeLiquidity` is all-or-nothing. There is no share price to
manipulate and no first-depositor vector.

## Carried findings

- **IA-3** (LOW, open) — open fees round down. Mitigated by `MIN_POSITION_FEE`.
- **IA-6** (LOW, open) — tokens with >38 decimals can overflow `_cpAmountOut`.
  Still reachable only if a market creator selects such a token; `10 ** dec`
  against realistic reserves overflows well before that in practice. Consider
  bounding `tokenDecimals` in `createMarket`.
- **ECS-1 inbound half** — now closed by `_transferIn`'s delta check.
- **IA-4 / IA-5** (INFO) — 1-wei rounding in `openShort`'s `airTokenMinted`,
  and zero swap fee on dust. Both unchanged and immaterial.

## INFO-IA-1 — `createMarket` input validation

Prior finding NM-005 remains open: `EXNIHILOFactory.createMarket` does not
explicitly validate `tokenAddress` beyond the `decimals()` try/catch. A creator
can pass a hostile or broken token. Since market creation is permissionless and
the creator is also the sole LP funding it, the loss is self-inflicted — but a
frontend allowlist is worth considering so users are not lured into a pool built
on a malicious token.
