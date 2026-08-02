---
description: "Every EXNIHILO fee in one table: the 5% open premium, the dynamic impact fee, renewal, swaps, the 1% close fee on profit, and the keeper bounty."
---

# Fee Structure

All fees are deterministic, on-chain, and non-upgradeable.

## Summary

| Fee | Rate | Recipient | When |
|---|---|---|---|
| Position open (base) | 5% of USDC notional | 3% LP + 2% protocol | Every long/short open |
| Position open (impact) | Dynamic — see formula below | LP | Every long/short open |
| Position renewal | Dynamic — see formula below | 3/2 LP/protocol split; impact slice → LP | Every renewal |
| Swap | Configurable (default 1%) | Pool (passive LP yield) | Every swap |
| Position close | 1% of profit | Protocol | Profitable closes only |
| Keeper bounty | 0.05 USDC flat | Whoever calls `settleExpired` | Expired-position settlement |
| Liquidity ops | 0% | — | Add / withdraw liquidity |

## Position open fee — 5% base + dynamic impact fee

**Base fee** split (both accrue as pull payments):
- **3%** → `lpFeesAccumulated` (claimable by LP via `claimFees(to)`)
- **2%** → `protocolFeesAccumulated` (claimable by treasury via `claimProtocolFees(to)`)

Minimum floor: **0.05 USDC** (split 3/5 LP, 2/5 protocol). Applies when 5% of notional would be less than 0.05 USDC.

**Impact fee** (LP drain protection):

```solidity
impactFee = IMPACT_FEE_BPS * N * (2 * OI + N) / (2 * backedAirUsd * BPS_DENOM)
```

Where `N` = notional, `OI` = same-side open interest, `backedAirUsd` = pool USDC reserves.

This is an **OI-integral formula**: the fee for each position equals the integral of a marginal rate that increases with cumulative open interest. Splitting a position into many smaller ones produces the exact same total fee. All impact fee revenue goes to the LP.

**Examples:**

| Pool size | Position | OI before | Impact fee | Total fee |
|---|---|---|---|---|
| $10,000 | $100 | $0 | $0.08 | $5.08 |
| $1,000 | $500 | $0 | $18.75 | $43.75 |
| $1,000 | $500 | $500 | $56.25 | $81.25 |
| $100 | $100 | $0 | $7.50 | $12.50 |

## Position renewal fee — dynamic

Renewal re-buys the position's optionality and its open-interest slot at **today's** prices instead of entry prices:

```
mark      = N + surplus                       // current gross value, floored at N
baseFee   = 5% of mark                        // 3% LP + 2% protocol, 0.05 USDC floor
impactFee = IMPACT_FEE_BPS × N × (2×(OI−N) + N)
            ───────────────────────────────────  → LP
                2 × backedAirUsd × BPS_DENOM

renewalFee = baseFee + impactFee
```

Where `N` = the position's original notional (its open-interest contribution), `surplus` = its current profit (0 if underwater), `OI` = current same-side open interest.

Properties:

- **A fresh or flat position pays roughly the old flat 5%** — nothing changes for the common case.
- **Winners pay for what they hold**: a position 2× in profit renews a 2× exposure and pays double. This is the crystallization pressure that keeps the LP compensated for deep-in-profit positions.
- **Crowding is priced**: the impact term is the position's own slice of the OI integral, repriced at current open interest and pool depth. Renewing through a pre-event OI spike costs accordingly.
- **Manipulation-bounded below**: the mark is floored at `N`, so wash-trading the curve to suppress a position's surplus can at best reduce the fee to the flat baseline, never under it.

`quoteRenewFee(nftId)` is the single source of truth; `renewPosition(nftId, maxFee)` takes a fee cap as slippage protection since the fee moves with live state.

## Swap fee

Set at pool creation as `swapFeeBps` (immutable). Applied to all three AMM curves.

The fee is computed on the spot value of the input, giving a true percentage-of-notional fee regardless of trade size. The fee stays in the pool, implicitly increasing the LP's reserves.

## Position close fee — 1% of profit

Only charged on profitable closes:
- If `pnl > 0`: `closeFee = pnl * 1%` → accrues to `protocolFeesAccumulated`
- If `pnl ≤ 0`: no fee

## Constants

```solidity
LP_FEE_BPS       = 300   // 3%
PROTOCOL_FEE_BPS = 200   // 2%
IMPACT_FEE_BPS   = 1500  // 15% impact scaling rate
MIN_POSITION_FEE = 50000 // 0.05 USDC
CLOSE_FEE_BPS    = 100   // 1%
KEEPER_BOUNTY    = 50000 // 0.05 USDC flat, paid by settleExpired
```

The keeper bounty is a flat constant rather than gas-derived because the pool is oracle-free — it cannot convert gas (native units) into USDC on-chain. 0.05 USDC comfortably exceeds the L2 gas cost of the call.

These are hardcoded constants — not configurable after deployment.
