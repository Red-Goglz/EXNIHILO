---
description: "Positions have no deadline. Funding charges rent continuously by shrinking the whole position — collateral and debt together — how the rate is set, what it does to the price, and when a decayed position can be swept."
---

# Funding

Positions have no deadline, no renewal and no expiry. Instead **funding** charges rent
continuously — by taking a slice of the position itself.

Every second each side of the book shrinks by a small fraction, exactly as if that fraction of
every position were closed and its payout kept by the pool:

```
Long    collateral −= d    backedAirToken += d
        debt       −= d    airUsdSupply   −= d
Short   collateral −= d    backedAirUsd   += d
        debt       −= d    airTokenSupply −= d
```

Your position is not closed, liquidated or margin-called. It gets **smaller**.

## Why it works this way

A position posts no margin, so what you hold is an option the LP wrote — and an option with no
expiry is worth an unbounded amount unless its premium is charged continuously. With no margin
account to debit, the only thing the charge can reach is the position.

It takes a **fraction** of what is there instead of accruing a debt, so a claim can never be
driven below zero — there is nothing to liquidate and no keeper to pay — and one index per side
describes the whole book, so no position is touched between open and close. Funding costs no gas
and needs no transaction.

## What you pay

| Your position | What funding takes |
|---|---|
| **In profit** | That fraction of the profit — the slice's payout stays with the LP |
| **Flat** | Nothing in cash; that fraction of your upside |
| **Underwater** | Nothing in cash; that fraction of any recovery |

Collateral and debt fall together, so **your break-even never moves**: a position at 80% of its
size pays 80% of what the full position would at the same price. No position is valued at
accrual time, so nobody can move the curve to change what funding takes.

## The rate

```
ratePerWindow = 10% + 20% × utilization     utilization = sameSideOpenInterest / backedAirUsd  (cap 4×)
window(age)   = min(1 hour + market age, 30 days)
```

**Market age.** The window starts at one hour and widens by a second per second, so rent is
steepest on a new market — no price history, the most volatility — and falls as it matures.

**Crowding.** Each side pays for its own open interest relative to pool depth. A lone position
pays close to the base rate; a side whose open interest equals the pool's depth pays three times
that. Open interest decays with the positions it counts, so crowding eases on its own, and the
contract integrates that in closed form. For longs, a stretch of time costs the same whether it is
accrued in one step or fifty.

Shorts are not quite exact. Short funding returns USDC to the pool, which deepens it and lowers the
short side's utilization, and a single accrual does not see that happen inside its own interval.
So a crowded short side on a quiet pool pays a little more: in testing, a short side at high
utilization kept 57.7% of its size after 20 days accrued in one step, against 58.9% accrued twice
a day. The error only ever overcharges, so nobody gains by keeping a pool quiet, and any trade or
`pokeFunding()` narrows it.

The rate is priced as an option's carry — more than a perp's funding, and steepest where
volatility is highest. Measured on a lone position, by market age when it opens:

| Market age at open | Rate at open | Size left after 1 day | After 7 days | After 30 days |
|---|---|---|---|---|
| 1 hour | ~120% a day | 77% | 64% | 55% |
| 8 hours | ~27% a day | 88% | 74% | 64% |
| 1 day | ~9.7% a day | 93% | 81% | 71% |
| 1 week | ~1.4% a day | 99% | 93% | 84% |
| 30 days+ | ~0.34% a day | 99.7% | 98% | 90% |

The first-hour rate lasts only moments — the window widens every second — which is why such a
position still keeps 77% after a day. On a mature market a side at 100% utilization pays about 1%
a day, and one at the 4× cap about 3%.

Quote the live rate with `fundingRatePerSecond(isLong)`, in RAY per second.

## What it does to the price

Funding moves the curves exactly as a close of that size would:

| | `spotPrice` | `longPrice` | `shortPrice` |
|---|---|---|---|
| Long funding | ↓ | ↓ | — |
| Short funding | ↑ | — | ↑ |

Each side pushes the price against itself. Because debt shrinks with collateral, a decaying
position stops distorting the curves and open interest in step with its size. No swap runs, so no
swap fee is charged.

## It is not a fee

Funding never reaches the claimable fee balances; it lands in the backed reserves the LP already
owns. It is **100% to the LP** — the protocol's cut is the open and close fees — and it cannot be
read from the fee accumulators. Use the `FundingAccrued` event (collateral released and debt
cancelled) or the indexer's `/funding/:pool` endpoint.

## Reading a position

```solidity
liveAmountsOf(nftId)      // (collateral, debt, notional) now, net of funding
remainingSizeBps(nftId)   // what is left of the opening size, in bps
```

The NFT stores opening figures; each live figure is
`atOpen × fundingIndex(side) / fundingIndexAtOpen`. Both views include funding not yet written to
storage, so they are accurate on a pool that has been quiet for a week.

`pokeFunding()` writes accrued funding without trading. Anyone may call it and nobody needs to.
Accrual timing can change what a side is charged, in three ways: above the 4× utilization cap the
rate is held for the whole interval even after funding has burned open interest back below it; a
crowded short side is measured against a depth that short funding itself deepens (see
[The rate](#the-rate)); and while the window is still widening, the integral is approximated
piecewise, so a different set of boundaries lands on a slightly different number. In all three the
error is an overcharge, never an undercharge, and accruing more often narrows it. The gaps are
small — the widening-window one is bounded at a fraction of a percent of the interval's charge,
and every case shrinks to nothing once the window reaches its 30-day cap.

## Sweeping a decayed position

Geometric decay never reaches zero. A position decayed to dust no longer affects anyone's price,
but it still counts as open, and the LP cannot withdraw while any position is open. Once a
position is below **0.1%** of the collateral it opened with, anyone may call `sweepDust(nftId)`;
before that it reverts `PositionNotDust`.

The threshold uses the position's own opening size, so only funding — never a manipulated price —
can reach it. If the sweep prices the position in profit, the payout is credited to the holder.
The price at the moment of the sweep can still be moved, though: a caller who pushes it first makes
the position price underwater, and then the collateral goes to the LP and the holder gets nothing.
What is lost that way is at most the position's remaining collateral, 0.1% or less of what it
opened with. Sweeping is unpaid; the LP is the party with the motive.

## Closing and underwater positions

Only the holder can close, whenever they like, and only in profit — see
[Closing Positions](/trading/closing-realizing). An underwater position is never liquidated: it
persists, decaying, and is yours again if the price recovers.

## Wind-down

`closePool()` blocks new positions immediately and sets `closeDate = now + 7 days`. After that the
funding rate **doubles every day**, up to 2^16. Nothing is force-closed, but holding becomes
geometrically expensive: an abandoned position is sweepable about eleven days after `closeDate` on
a mature market, sooner on a young one. That is what bounds an LP's wait to withdraw.
