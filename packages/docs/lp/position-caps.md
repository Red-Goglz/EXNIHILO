---
description: "Every market caps individual position size at 1% of pool reserves on day one, widening automatically to 20% over the first 24 hours. There is nothing to configure and no one can change it."
---

# Position Caps

Every market limits how large a single position can be. The cap is automatic: tight when the
market opens, widening over its first day.

## How it works

The cap is a share of `backedAirUsd`, the pool's USDC reserve:

| Time since market creation | Cap |
|---|---|
| At creation | **1%** of reserves |
| 6 hours | 5.75% |
| 12 hours | 10.5% |
| 18 hours | 15.25% |
| 24 hours and after | **20%** of reserves |

It ramps linearly, second by second, and holds at 20%. Because it is a share of reserves, a deeper
pool admits proportionally larger positions.

```solidity
pool.currentMaxPositionBps()   // 100 → 2000
pool.effectiveLeverageCap()    // that share of live reserves, in USDC
pool.createdAt()               // when the ramp started
```

Opening above the cap reverts `LeverageCapExceeded`. The check applies only at open — a position
already open is never affected.

## Why it ramps

A new market has no price history and only the depth its creator seeded; one large position could
dominate it before anyone reacts. A day later it has traded and been arbitraged, and a 20% position
is an ordinary risk.

## Nothing to configure

`createMarket` takes no cap arguments and the pool has no setter:

```solidity
CAP_START_BPS     = 100      // 1%
CAP_MAX_BPS       = 2000     // 20%
CAP_RAMP_DURATION = 24 hours
```

An LP cannot raise the cap to attract size or lower it when nervous, and a trader's cap cannot move
against them.

## Interaction with the impact fee

The [impact fee](/protocol/fees#open-fee) grows with size and same-side open interest relative to
depth, so it pushes the same way. For a lone position it passes the 5% base fee only above about
67% of depth, out of reach under the 20% cap; on a side already holding more than about a quarter
of depth, a full-size open pays more in impact than in base fee.
