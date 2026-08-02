---
description: "As the LP you are the option writer: you collect every premium and pay every winning close. How fee income accrues and what it genuinely costs you."
---

# LP Fee Earnings

## You are the counterparty

Read this before depositing.

In option terms, **the LP is the writer**. Every position opened in your pool is written
against your liquidity: you collect the premium, and when a trader closes in profit,
that profit is paid out of your backed reserves. There is no shared insurance fund and
no other party absorbing it.

This is not a hidden risk — it is the business you are entering. Writing options is
profitable when premiums collected exceed payouts made, and loss-making when a trader
catches a large move in a pool that let them size into it.

**Three things protect you, and you control two of them:**

| Protection | Who sets it |
|---|---|
| **Position caps** — bound the size of any single position | You. `maxPositionBps = 100` (1% of reserves) is the recommended default |
| **Impact fee** — scales quadratically with position size and open interest, sized to compensate above the price-distortion cost of writing the position | Protocol, automatic |
| **Pool isolation** — one pool's losses never touch another | Protocol, structural |

The impact fee is what makes the math work. A position small relative to your reserves
pays almost nothing extra — and can only win a correspondingly small amount. A position
large relative to your reserves pays sharply more, precisely because it is the one that
could hurt you. Caps exist so you decide where that line sits.

::: warning
Do not disable position caps on a pool you cannot afford to see drawn down. Setting both
caps to 0 maximizes volume and maximizes your exposure to a single trader catching a
large move.
:::

## Revenue sources

LPs earn fees from three sources.

## 1. Position open fees — 3% of notional

Every time a trader opens a long or short, 3% of the USDC notional is added to `lpFeesAccumulated`. Renewals accrue 3% of the position's current mark value (notional + profit) plus the renewal impact slice. The LP can claim these at any time via `claimFees(to)`.

```
baseFee = usdcAmount * 5 / 100
lpShare = baseFee * 3 / 5    // 3% of notional
```

## 2. Impact fee — dynamic, scales with position size and OI

An additional impact fee is charged on every position open and goes **entirely to the LP**. This fee protects against LP drain attacks by scaling quadratically with position size relative to pool liquidity.

```
impactFee = 1500 × N × (2 × OI + N) / (2 × backedAirUsd × 10000)
```

The impact fee is negligible for small positions in deep pools but becomes significant when positions are large relative to the pool — exactly when LP protection matters most.

## 3. Swap fees — passive yield

The configurable swap fee (default 1%) stays in the pool on every swap. This implicitly increases the LP's backed reserves over time — it's not claimed separately, it's reflected in larger withdrawal amounts.

## Claiming fees

Call `claimFees(to)` on the pool. The accumulated USDC (base LP fee + impact fee) is transferred to `to` and `lpFeesAccumulated` resets to zero. Fees are pull payments — nothing is ever pushed automatically, so no wallet condition can interfere with pool operations.

Only the current LP NFT holder can claim.

## Revenue model

LP earnings scale with:
- **Number of positions opened** — more opens = more base fees
- **Position size relative to pool** — larger positions pay more impact fee
- **Cumulative open interest** — more OI = higher impact fees on new positions
- **Swap volume** — more swaps = more passive yield
- **Pool TVL** — larger pools attract more traders

::: tip
The impact fee ensures that LPs are always compensated more than the price-distortion cost of any position — no profitable drain strategy exists.
:::
