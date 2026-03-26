# Fee Structure

All fees are deterministic, on-chain, and non-upgradeable.

## Summary

| Fee | Rate | Recipient | When |
|---|---|---|---|
| Position open (base) | 5% of USDC notional | 3% LP + 2% protocol | Every long/short open |
| Position open (impact) | Dynamic — see formula below | LP | Every long/short open |
| Swap | Configurable (default 1%) | Pool (passive LP yield) | Every swap |
| Position close | 1% of profit | Protocol | Profitable closes only |
| Liquidity ops | 0% | — | Add / withdraw liquidity |

## Position open fee — 5% base + dynamic impact fee

**Base fee** split:
- **3%** → `lpFeesAccumulated` (claimable by LP via `claimFees()`)
- **2%** → `protocolTreasury` (transferred immediately)

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

## Swap fee

Set at pool creation as `swapFeeBps` (immutable). Applied to all three AMM curves.

The fee is computed on the spot value of the input, giving a true percentage-of-notional fee regardless of trade size. The fee stays in the pool, implicitly increasing the LP's reserves.

## Position close fee — 1% of profit

Only charged on profitable closes:
- If `pnl > 0`: `closeFee = pnl * 1%` → sent to protocol treasury
- If `pnl ≤ 0`: no fee

Realize operations (including force realize) do not charge a close fee.

## Constants

```solidity
LP_FEE_BPS       = 300   // 3%
PROTOCOL_FEE_BPS = 200   // 2%
IMPACT_FEE_BPS   = 1500  // 15% impact scaling rate
MIN_POSITION_FEE = 50000 // 0.05 USDC
CLOSE_FEE_BPS    = 100   // 1%
```

These are hardcoded constants — not configurable after deployment.
