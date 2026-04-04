# Position Expiry & Renewal

Every position in EXNIHILO has a **deadline**. After the deadline, anyone can close the position. Before the deadline, only the holder can close or realize it. Positions can be renewed by paying a fee.

## How it works

When you open a position, a deadline is set:

```
deadline = block.timestamp + positionDuration
```

The `positionDuration` is configured per pool at market creation (default: 7 days, range: 1 hour to 1 year).

Until the deadline:
- Your position is at **full value** — no erosion, no decay
- Only you (the NFT holder) can close or realize it
- Anyone can renew it by paying the renewal fee

After the deadline:
- Anyone can call `closePositionAfterDeadline()` to settle your position
- If in profit: you receive the USDC profit (minus 1% close fee), same as a normal close
- If underwater: collateral returns to LP, synthetic debt is burned, you receive nothing

## Renewal

Call `renewPosition(nftId)` to extend the deadline by one `positionDuration`. Anyone can call this — you can renew your own position or someone else's.

**Renewal fee**: 5% of the original notional (same as the opening base fee), split:
- 3% to LP (`lpFeesAccumulated`)
- 2% to protocol treasury

If the position has already expired, the new deadline extends from `now` (not from the old deadline).

## Closing

After the deadline, `closePositionAfterDeadline(nftId)` can be called by anyone:

**Profitable position:**
1. Position is closed via the normal AMM swap (SWAP-3 for longs, SWAP-2 for shorts)
2. Surplus USDC goes to the NFT holder (minus 1% close fee)
3. Position NFT is burned

**Underwater position:**
1. Locked collateral returns to LP's backed reserves
2. Synthetic debt is burned
3. Position NFT is burned
4. No USDC payment to anyone

## Position duration

Each pool has a fixed `positionDuration` set at creation:

| Setting | Duration |
|---|---|
| Minimum | 1 hour |
| Maximum | 365 days |
| Default | 7 days (when 0 is passed to `createMarket`) |

Shorter durations mean more frequent renewals — higher revenue for the LP but more management for traders. Longer durations are more convenient but give the LP less frequent fee income.

## Trading strategies

- **Day traders**: 1-hour pools work well — low renewal cost per trade
- **Swing traders**: 7-day pools (default) — weekly renewals
- **Long-term holders**: 30-day or 90-day pools — monthly/quarterly renewals
- **Set and forget**: Renew several periods in advance isn't possible — you must renew each period individually, which creates a natural check-in cadence

## Position NFT metadata

The deadline is stored in the Position NFT and visible in the on-chain SVG metadata. The NFT shows:
- **EXPIRES**: the deadline date
- Whether the position is active or expired
