---
description: "Every EXNIHILO cost in one place: the 5% open premium, the dynamic impact fee, continuous funding, the fixed 1% swap fee and the 1% close fee on profit."
---

# Fees

Every fee is a contract constant — identical on every market and changeable by no one.

| Fee | Rate | Paid to | When |
|---|---|---|---|
| Open — base | 5% of notional (min 0.05 USDC) | 4% LP, 1% protocol | Every open |
| Open — impact | Grows with size and open interest | LP | Every open |
| Funding | 10% + 20% × utilization per window | LP, in reserves | Continuously while open |
| Swap | 1% | LP, in reserves | Every swap |
| Close | 1% of profit | Protocol | Profitable closes |
| Liquidity | 0% | — | Add / withdraw |

::: tip A premium, not a taker fee
5% looks enormous next to a perp's 0.05% taker fee, but it is a different charge. A perp's fee sits
on top of collateral you can lose entirely; EXNIHILO's open fee **replaces** collateral and is your
whole downside. Compare it to an at-the-money option on a volatile token. See
[Perpetual Options](/introduction/positions-are-options).
:::

## Open fee

The base fee is 5% of notional: 4% to `lpFeesAccumulated` and 1% to `protocolFeesAccumulated`,
both claimed later as pull payments. Below $1 of notional the 0.05 USDC floor applies instead,
split the same 4:1.

The **impact fee** is added on top and goes entirely to the LP:

```
impactFee = 15% × N × (2 × OI + N) / (2 × backedAirUsd)
```

`N` is the notional, `OI` the same side's open interest before this position, and `backedAirUsd`
the pool's USDC. It is the integral of a marginal rate that rises with open interest, so it is
**split-proof**: one $1,000 position pays exactly what ten $100 positions do.

| Pool USDC | Position | Same-side OI before | Impact fee | Total fee |
|---|---|---|---|---|
| $10,000 | $100 | $0 | $0.08 | $5.08 |
| $10,000 | $2,000 (the 20% cap) | $0 | $30.00 | $130.00 |
| $10,000 | $2,000 | $2,000 | $90.00 | $190.00 |

Quote the exact figure with `quoteOpenFee(notional, isLong)`.

## Funding

Positions never expire, so holding one is charged continuously — not as a payment, but by shrinking
the position. Every second each position on a side loses the same small fraction of its collateral,
debt and notional, and the released collateral lands in the LP's reserves:

```
utilization   = sameSideOpenInterest / backedAirUsd      // capped at 4×
ratePerWindow = 10% + 20% × utilization
window(age)   = min(1 hour + market age, 30 days)
```

A winner gives up that share of its profit; a flat or losing position pays nothing in cash and loses
that share of its size. Break-even never moves. It is about 0.34% of a position a day on a mature
market, far more on a new or crowded one, and 100% to the LP. Measured rates and the wind-down are
on [Funding](/positions/funding).

## Swap fee

A fixed 1% on every swap, measured on the spot value of the input and kept in the pool's reserves as
LP yield. See [Swapping](/trading/swapping).

## Close fee

1% of the surplus on a profitable close, to `protocolFeesAccumulated`. Nothing is charged on a
position that cannot close.

Sweeping a decayed position pays its caller nothing. A bounty would come out of the holder's payout
and could exceed it; the LP, whose withdrawal a dead position blocks, already has the motive.

## Constants

```solidity
LP_FEE_BPS          = 400      // 4%
PROTOCOL_FEE_BPS    = 100      // 1%
MIN_POSITION_FEE    = 50000    // 0.05 USDC
IMPACT_FEE_BPS      = 1500     // 15%
CLOSE_FEE_BPS       = 100      // 1% of profit
swapFeeBps          = 100      // 1%
FUNDING_BASE_BPS    = 1000     // 10% per window
FUNDING_UTIL_BPS    = 2000     // + 20% × utilization per window
FUNDING_WINDOW_MIN  = 1 hour
FUNDING_WINDOW_MAX  = 30 days
SWEEP_DUST_BPS      = 10       // sweepable below 0.1% of opening collateral
WIND_DOWN_GRACE     = 7 days
WIND_DOWN_DOUBLING  = 1 day
CLAMP_BLOCKS        = 5        // block opens a close is priced against
```
