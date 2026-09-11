---
description: "Every market caps individual position size at 1% of pool reserves on day one, widening automatically to 20% over the first 24 hours. There is nothing to configure and no one can change it."
---

# Position Caps

Every market limits how large a single position can be. The cap is **automatic**:
it starts tight when the market opens and widens over the first day.

## How it works

The cap is a percentage of `backedAirUsd` — the pool's USDC reserve, the side
that actually backs payouts:

| Time since market creation | Cap |
|---|---|
| At creation | **1%** of reserves |
| 6 hours | 5.75% |
| 12 hours | 10.5% |
| 18 hours | 15.25% |
| 24 hours and after | **20%** of reserves |

It ramps linearly between those points, updating every second, and holds at 20%
from then on.

```solidity
pool.currentMaxPositionBps()   // current cap in bps: 100 → 2000
pool.effectiveLeverageCap()    // that percentage applied to live reserves, in USDC
pool.createdAt()               // when the ramp started
```

Because the cap is a *fraction* of reserves, the USDC ceiling also moves with
pool depth — a pool that grows admits proportionally larger positions without
anything being changed.

## Why it ramps

A brand-new market is the worst moment to allow size. There is no price history,
depth is whatever the creator seeded, and a single large position can dominate
the book before anyone has a chance to react. Holding the first hours at 1% lets
the market find its price and attract depth before it accepts real size.

Twenty-four hours later, the market has traded, the price has been arbitraged
against its DEX pair, and a 20% position is a normal risk rather than an
existential one.

## Nothing to configure

`createMarket` takes no cap arguments, and the pool has no setter. The values are
constants in the contract:

```solidity
CAP_START_BPS     = 100      // 1%
CAP_MAX_BPS       = 2000     // 20%
CAP_RAMP_DURATION = 24 hours
```

This is deliberate. Caps used to be two LP-settable parameters — a hard USDC
ceiling and a percentage — which meant every market launched with a risk setting
someone had to get right, and an LP could widen them at any moment. Making the
cap automatic removes both the configuration burden and the lever.

**For LPs:** you cannot raise the cap to attract larger traders, and you cannot
lower it if you get nervous. The schedule is the same for every market.

**For traders:** the cap you see is the cap. It is not going to move against you
mid-position, and a position already open is never affected by the ramp — the
check applies only at open time.

## What a rejected position looks like

Opening above the current cap reverts with `LeverageCapExceeded`. To size a trade
against the live ceiling, read `effectiveLeverageCap()` — it returns the maximum
notional in USDC at this moment.

## Interaction with the impact fee

The [impact fee](/protocol/fees) grows with the square of position size relative
to depth, so it and the cap push in the same direction. One consequence worth
knowing: the impact fee only exceeds the base fee above roughly 67% of pool
depth, which the 20% ceiling puts permanently out of reach. Under the automatic
cap, **the base fee is always the larger component**.
