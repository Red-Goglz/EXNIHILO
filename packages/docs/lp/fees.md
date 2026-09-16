---
description: "As the LP you are the option writer: you collect the premium and funding on every position and pay every winning close. How income accrues and what it genuinely costs you."
---

# LP Fee Earnings

## You are the counterparty

In option terms **the LP is the writer**. Every position in your pool is written against your
liquidity: you collect the premium and the funding, and when a trader closes in profit, the profit
is paid from your reserves. There is no insurance fund. Writing options pays when premiums exceed
payouts and loses when a trader catches a large move.

Three protections apply, and none of them are yours to set:

| Protection | What it does |
|---|---|
| **Position cap** | Bounds one position to 1% of your USDC at launch, 20% after 24 hours |
| **Impact fee** | Charges large positions and crowded sides quadratically more |
| **Pool isolation** | One pool's losses never touch another |

::: warning Depth is your only lever
The cap is a share of your reserves, so what one trader can take against you is set by how much you
seed, and you cannot tighten it. Seed only what you can afford to see drawn down.
:::

## Income

| Source | Rate | Where it goes |
|---|---|---|
| Open fee | 4% of notional (of the 5% base) | `lpFeesAccumulated` — claim with `claimFees(to)` |
| Impact fee | Grows with size and open interest | `lpFeesAccumulated` |
| Funding | Continuous, 100% to you | The pool's reserves — not claimable |
| Swap fees | 1% of every swap | The pool's reserves — not claimable |

Funding and swap fees deepen the pool rather than paying out; you receive them when you withdraw.
Funding does not appear in the fee accumulators — track it with the `FundingAccrued` event or the
indexer's `/funding/:pool`. See [Funding](/positions/funding).

`claimFees(to)` sends the accumulated USDC to `to` and resets the balance. Only the current LP NFT
holder can claim, and fees are never pushed.

## What drives it

More positions opened, larger positions relative to the pool, more crowding on a side, more swap
volume — and time, since funding accrues on every open position every second.
