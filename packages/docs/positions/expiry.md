---
description: "Every position carries a deadline: full value until it passes, then anyone may close it. How renewal and auto-renewal work, and who settles an expired position."
---

# Position Expiry & Renewal

Every position in EXNIHILO has a **deadline**. After the deadline, anyone can close the position. Before the deadline, only the holder can close it. Positions can be renewed by paying a fee.

## How it works

When you open a position, a deadline is set:

```
deadline = block.timestamp + currentPositionDuration()
```

The duration is not configured — it is derived from how old the market is. See [Position duration](#position-duration) below.

Until the deadline:
- Your position is at **full value** — no erosion, no decay
- Only you (the NFT holder) can close it
- Only you can renew it by paying the renewal fee

After the deadline:
- Anyone can call `closePositionAfterDeadline()` to settle your position
- If in profit: the USDC profit (minus 1% close fee) is credited to your claimable balance — withdraw any time via `claimPayout(to)`
- If underwater: collateral returns to LP, synthetic debt is cancelled, you receive nothing

## Renewal

Call `renewPosition(nftId, maxFee)` to extend the deadline by one `currentPositionDuration()`. Only the position holder can renew (this prevents third parties from indefinitely extending positions to grief the LP's exit).

**Renewal fee**: dynamic — the position is repriced at today's state (see [Fees](/protocol/fees#position-renewal-fee-dynamic)): 5% of the position's current mark value (original notional + current profit, floored at the original notional) plus its slice of the open-interest impact fee. Quote it with `quoteRenewFee(nftId)`; the `maxFee` parameter protects against the fee moving between quote and execution. Split as pull payments:
- 4% of mark to LP (`lpFeesAccumulated`, claimed via `claimFees`) plus the full impact slice
- 1% of mark to protocol (`protocolFeesAccumulated`, claimed via `claimProtocolFees`)

If the position has already expired, the new deadline extends from `now` (not from the old deadline).

### The 60-day renewal horizon

Because a renewal extends from the *existing* deadline, renewals stack — so there has to be a limit on how far they can stack. A renewal is rejected with `RenewalExceedsHorizon` if it would place the deadline more than **60 days** past the moment of the call (two times the 30-day maximum position duration).

What that means in practice:

- On a young market, where durations are hours or days, you can renew many times over before the horizon is anywhere in sight.
- On a mature market issuing 30-day positions, you get **one** renewal — 30 + 30 lands exactly on the horizon, so you never have to race your own deadline to use it. After that the position has to run down to 30 days of remaining life before it can be extended again.

Quote the outcome with `quoteRenewDeadline(nftId)`, which returns the deadline a renewal would write and whether it would be accepted. Do not reproduce the rule client-side — the pool is its source of truth.

The horizon exists for the LP. `removeLiquidity` reverts while any position is open, so without a bound a holder could keep a dust position alive indefinitely at the minimum fee and freeze the LP's entire principal — [H-3](../protocol/audit-report#high-severity) in the 2026-08-20 audit measured $60.85 buying a 100-year freeze. With the horizon, no outstanding position can expire more than 60 days from now, so an LP's wait after `closePool` is bounded rather than open-ended. Note that it does not make `closeDate` bind retroactively: a deadline already stacked past `closeDate` still stands until it passes.

## Auto-renewal (opt-in)

Holders can opt a position into keeper-driven auto-renewal instead of managing deadlines manually:

```
PositionNFT.setAutoRenew(nftId, enabled, maxFee)
```

At expiry, anyone may call `settleExpired(nftId, minPayout)` on the pool. If the position opted in **and** its own equity covers the renewal fee plus a safety margin of **2% of the position's mark value** (original notional + current profit) **and** the fee is within the holder's `maxFee` cap **and** the new deadline fits within any pool `closeDate`, the position is **renewed instead of closed** — no USDC needed from the holder:

- **Long** — the fee is written against the position as additional synthetic debt (`airUsdMinted` grows); the eventual close pays out that much less.
- **Short** — the fee comes out of the locked airUsd collateral.

A winning position therefore sustains itself period after period; a position that cannot pay simply settles. This is intentional natural selection: only positions worth keeping alive can afford to stay alive.

Notes:
- The opt-in is **cleared on every transfer** — a buyer must opt in themselves.
- While an auto-renewal is executable, `closePositionAfterDeadline` reverts with `AutoRenewActive` so nobody can bypass the opt-in and kill the position; `settleExpired` renews it.
- If the auto-renewal cannot execute (underwater, profit inside the safety margin, fee above cap, pool closing), `settleExpired` falls through to the normal close path.

**Why the safety margin?** The renew-or-close decision is priced from live AMM reserves. Without a margin, a position whose profit sits exactly at the fee flips outcome on an arbitrarily small price nudge — cheap to manipulate. The 2%-of-mark margin pairs with the [settlement guard](#settlement-guard) below: a price move large enough to swing the decision by the margin is also large enough to arm the guard, so the decision cannot be flipped and acted on in the same breath. (Until the 2026-08-20 audit this held only for swaps — position opens moved the same prices without arming anything. See [H-1](../protocol/audit-report#high-severity).) A position whose profit lands inside the margin settles instead of renewing — it could only have funded a renewal that left it with near-zero equity, and it is paid its profit on the close.

## Settlement guard

Third-party settlement is briefly locked whenever the price it settles at has moved. If either settlement price — `backedAirUsd / airTokenSupply` for longs, `backedAirToken / airUsdSupply` for shorts — moves **1% or more from where the current block opened**, `settleExpired` and `closePositionAfterDeadline` are blocked for **5 blocks** (~10 s on Avalanche) for everyone except the position's own holder. Inside the window both calls revert with `SettlementGuardActive`.

The measure is *cumulative net displacement over the block*, from **any** path that moves the reserves — swaps and `openLong` / `openShort` alike. It is deliberately not the size of a single trade: a run of individually small swaps in one block would slip under such a threshold while moving the price as far as one big one, and opening a position moves the opposite side's settlement price without being a swap at all. Arming is pool-wide, so a move on either side blocks settlement of both.

This exists because both calls price their outcome — the renew/close decision *and* the payout — from live reserves. Without the guard, an attacker could swap, settle a target position at the shifted price, and reverse the swap in one transaction, overriding the holder's recorded auto-renew consent or suppressing their payout at near-zero cost. With it, a manipulator must hold the position across 5 blocks of arbitrage exposure.

The holder is exempt: settling your own expired position at the current price is exactly what `closeLong` / `closeShort` already let you do, and the exemption guarantees an armed guard can never trap you in a position.

A **closing pool is exempt entirely**. Arming is relative to depth, so in a thin market an ordinary trade clears 1% and the guard is armed almost always — and since `removeLiquidity` requires every position to be settled, one abandoned expired position would otherwise lock the LP's principal for good. Once `closePool` has been called the guard stops blocking third parties, so a wind-down can always complete. Little is given up: the payout is still priced against the window below, which is the part that actually resists manipulation.

### Payouts are priced against a five-block window

The exemption above leaves one direction uncovered, and it is the one that moves LP capital out: a holder could move the price in their own favour and settle at the mark they just moved. Blocking the holder is not an option — it would let the LP re-arm the guard indefinitely and hold every holder in position — so the fix is a **price**, not a lock.

Every settlement — `closeLong`, `closeShort`, `settleExpired`, `closePositionAfterDeadline` — is priced at the **least favourable of the live reserves and every block-opening state recorded in the last 5 blocks**. In practice:

- Nothing moved in the window before your close: they are all identical and nothing changes. This is the normal case.
- You moved the price in your own favour inside the window: the payout is clamped to the pre-move price. Your swap bought you nothing, and its round trip is a pure loss.
- Somebody else moved it against you: you are paid the live (worse) price. The clamp is one-way and never pays *more* than the live curve supports. Use `minUsdcOut` to refuse and retry.

The window ages out by block number, not by trading activity, so a pool that goes quiet prices live again after 5 blocks and no holder is ever held away from their own position.

You can always close. You just cannot close at a price you moved inside the window. See [H-2](../protocol/audit-report#high-severity), which measured $4,122 of LP USDC per close before any of this existed.

::: warning What this does not do
The clamp makes a displaced mark unreachable for 5 blocks. It does not make it unreachable. An attacker who moves the price and then **waits the window out** closes at that mark like anyone else — measured at a few hundred dollars on a $100k pool. That is the same assumption `SETTLE_GUARD_BLOCKS` has always rested on: a price that has to survive 5 blocks of open arbitrage is no longer a manufactured one. No window length removes this; a longer one only demands longer persistence.
:::

`quoteClose` prices for the **next** block, because that is the earliest one a close submitted now can be mined in, and the window it will face is the one ending there. Quoting live would overstate the payout for the whole window after any favourable move — you would set `minUsdcOut` from a number the pool has already decided not to pay.

For keepers:
- `settlementGuardedUntilBlock()` — first block at which third-party settlement is allowed again; `0` = unguarded now, which includes any pool that is closing. Poll this instead of discovering the window through reverts.
- `settlementGuardBps()` — the displacement threshold in bps (100 = 1%).

Routine trading does not stall settlement: a move small enough to leave both ratios inside 1% of the block's opening value never arms it, and `_settle` itself is exempt so a keeper can batch several expiries in one block.

## Who settles an expired position

`settleExpired` pays its caller **nothing**, and neither does `closePositionAfterDeadline`. Settlement runs on the incentives the parties already have:

- **The holder** collects their own payout. `closeLong` / `closeShort` keep working after the deadline, and closing yourself pays out directly instead of crediting a claimable balance.
- **The LP** earns the renewal fee whenever an auto-renewal fires, and gets its locked capital and open-interest headroom back on a close.

::: warning A profitable position is worth closing yourself
Nobody is paid to settle for you, so an expired position may simply sit there until someone acts. It keeps its value while it waits — but a position left open is a position still exposed to price, so close a winner rather than leaving it to chance.
:::

An earlier design paid a flat 0.05 USDC bounty here. It was removed because the bounty was carved out of the settlement flow and clamped to what was available: on any position whose surplus was smaller than the bounty, the caller took **the entire payout** and the holder received nothing. Since the fee floor is 0.05 USDC, that described most small positions.

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

Position lifetime is **automatic**, stepped by how long the market has existed:

| Market age | Position lifetime |
|---|---|
| Under 1 hour | **1 hour** |
| Under 8 hours | **8 hours** |
| Under 24 hours | **24 hours** |
| Under 7 days | **7 days** |
| 7 days and beyond | **30 days** (the ceiling) |

Read `currentPositionDuration()` for what a position opened right now would get.

### Why it steps

A market's first hours are its most volatile. There is no price history, depth is
whatever the creator seeded, and a week-long position opened into that is a bet on
noise — written by the LP. The 8-hour step sits where the curve was coarsest, and
lands inside a market's first trading session. Short lifetimes early force frequent repricing through the
renewal fee, which is exactly when repricing is worth the most. Once a market has a week
behind it, long-dated positions are a normal product rather than an asymmetric one.

It also removes a parameter that was genuinely hard to choose. A market creator had to
pick a duration up front, permanently, before the market had traded at all — and the
right answer changes as a market ages, which a fixed value cannot express.

The schedule only ever increases. That is load-bearing: `closePool` sets
`closeDate = now + currentPositionDuration()`, and the guarantee that every outstanding
position has expired by then depends on no earlier position having been issued a longer
lifetime.

**A position keeps the lifetime it was opened under.** The step applies at open time and
never retroactively extends anyone. A renewal, though, is priced and dated at the step
current when it happens — so renewing an old position on an aged market extends it by 30
days, not by whatever it originally had.

## Trading strategies

- **Day traders**: brand-new markets work well — 1-hour positions, low renewal cost per trade
- **Swing traders**: 7-day pools (default) — weekly renewals
- **Long-term holders**: markets past a week old issue the 30-day maximum — monthly renewals
- **Set and forget**: Renewals stack — each `renewPosition` call adds one period to the current deadline (paying the dynamic fee each time), so you can extend several periods ahead, up to the [60-day horizon](#the-60-day-renewal-horizon). Or opt into [auto-renewal](#auto-renewal-opt-in) and let a winning position pay its own fees from its equity, period after period — that path extends from `now` rather than stacking, so it runs indefinitely

## Position NFT metadata

The deadline is stored in the Position NFT and visible in the on-chain SVG metadata. The NFT shows:
- **EXPIRES**: the deadline date
- Whether the position is active or expired
