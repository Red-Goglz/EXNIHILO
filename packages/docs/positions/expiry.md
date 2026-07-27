# Position Expiry & Renewal

Every position in EXNIHILO has a **deadline**. After the deadline, anyone can close the position. Before the deadline, only the holder can close it. Positions can be renewed by paying a fee.

## How it works

When you open a position, a deadline is set:

```
deadline = block.timestamp + positionDuration
```

The `positionDuration` is configured per pool at market creation (default: 7 days, range: 1 hour to 1 year).

Until the deadline:
- Your position is at **full value** — no erosion, no decay
- Only you (the NFT holder) can close it
- Only you can renew it by paying the renewal fee

After the deadline:
- Anyone can call `closePositionAfterDeadline()` to settle your position
- If in profit: the USDC profit (minus 1% close fee) is credited to your claimable balance — withdraw any time via `claimPayout(to)`
- If underwater: collateral returns to LP, synthetic debt is cancelled, you receive nothing

## Renewal

Call `renewPosition(nftId, maxFee)` to extend the deadline by one `positionDuration`. Only the position holder can renew (this prevents third parties from indefinitely extending positions to grief the LP's exit).

**Renewal fee**: dynamic — the position is repriced at today's state (see [Fees](/protocol/fees#position-renewal-fee-dynamic)): 5% of the position's current mark value (original notional + current profit, floored at the original notional) plus its slice of the open-interest impact fee. Quote it with `quoteRenewFee(nftId)`; the `maxFee` parameter protects against the fee moving between quote and execution. Split as pull payments:
- 3% of mark to LP (`lpFeesAccumulated`, claimed via `claimFees`) plus the full impact slice
- 2% of mark to protocol (`protocolFeesAccumulated`, claimed via `claimProtocolFees`)

If the position has already expired, the new deadline extends from `now` (not from the old deadline).

## Auto-renewal (opt-in)

Holders can opt a position into keeper-driven auto-renewal instead of managing deadlines manually:

```
PositionNFT.setAutoRenew(nftId, enabled, maxFee)
```

At expiry, anyone may call `settleExpired(nftId, minPayout)` on the pool. If the position opted in **and** its own equity covers the renewal fee plus the 0.05 USDC keeper bounty **and** the fee is within the holder's `maxFee` cap **and** the new deadline fits within any pool `closeDate`, the position is **renewed instead of closed** — no USDC needed from the holder:

- **Long** — the fee + bounty are written against the position as additional synthetic debt (`airUsdMinted` grows); the eventual close pays out that much less.
- **Short** — the fee + bounty come out of the locked airUsd collateral.

A winning position therefore sustains itself period after period; a position that cannot pay simply settles. This is intentional natural selection: only positions worth keeping alive can afford to stay alive.

Notes:
- The opt-in is **cleared on every transfer** — a buyer must opt in themselves.
- While an auto-renewal is executable, `closePositionAfterDeadline` reverts with `AutoRenewActive` so nobody can bypass the opt-in and kill the position; `settleExpired` renews it.
- If the auto-renewal cannot execute (underwater, fee above cap, pool closing), `settleExpired` falls through to the normal close path.

## Keeper bounty

`settleExpired` pays its caller a flat **0.05 USDC** bounty, so cleaning up (or auto-renewing) expired positions is always economically viable. On a profitable close the bounty comes out of the settlement surplus; on an underwater close it is carved from the collateral returning to the LP (the LP is the beneficiary of the cleanup). `closePositionAfterDeadline` remains available without a bounty.

## Closing

After the deadline, `closePositionAfterDeadline(nftId, minPayout)` can be called by anyone:

**Profitable position:**
1. Position is settled via the normal AMM pricing (SWAP-3 for longs, SWAP-2 for shorts)
2. Surplus USDC (minus 1% close fee) is **credited** to the NFT holder's `claimable` balance — pull payment, no push transfer, so no wallet condition can block cleanup
3. Position NFT is burned
4. The holder withdraws via `claimPayout(to)` whenever convenient

**Underwater position:**
1. Locked collateral returns to LP's backed reserves
2. Synthetic debt is cancelled
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
- **Set and forget**: Renewals stack — each `renewPosition` call adds one period to the current deadline (paying the dynamic fee each time), so you can extend several periods ahead. Or opt into [auto-renewal](#auto-renewal-opt-in) and let a winning position pay its own fees from its equity, period after period

## Position NFT metadata

The deadline is stored in the Position NFT and visible in the on-chain SVG metadata. The NFT shows:
- **EXPIRES**: the deadline date
- Whether the position is active or expired
