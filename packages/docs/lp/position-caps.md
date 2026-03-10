# Position Caps

The LP can set caps to limit individual position sizes, managing pool risk.

## Two cap types

### Hard cap — `maxPositionUsd`

A fixed USDC amount. No single position can exceed this value.

- Set via `setPositionCaps(maxPositionUsd, maxPositionBps)`
- Set to `0` to disable
- Example: `maxPositionUsd = 1000e6` limits each position to 1,000 USDC

### Soft cap — `maxPositionBps`

A percentage of `backedAirUsd` in basis points (10,000 = 100%).

- Valid range: 10–9,900 bps (0.1% – 99%)
- Set to `0` to disable
- Example: `maxPositionBps = 500` limits each position to 5% of pool TVL

Both caps are checked independently — a position must satisfy both (if active).

## Setting caps

```solidity
pool.setPositionCaps(maxPositionUsd, maxPositionBps)
```

Only the LP NFT holder can call this. Caps can be raised, lowered, or cleared at any time. Changes apply to new positions only — existing positions are not affected.

## Strategy

| Goal | Recommended caps |
|---|---|
| Maximum volume | Both set to 0 (no caps) |
| Conservative LP | Low bps cap (e.g., 200 = 2% of TVL) |
| Fixed risk per trade | Dollar cap (e.g., 500 USDC) |
| Balanced | Both active — dollar cap + TVL percentage |
