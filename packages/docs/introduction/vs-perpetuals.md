---
description: "Leveraged exposure with no liquidation, because EXNIHILO lends you nothing. The full comparison against perpetual futures — including where a perp wins."
---

# EXNIHILO vs Perpetual Futures

People arrive here looking for leverage without liquidation risk, and perps are the
thing they are comparing against. This page is that comparison, including the cases
where the honest answer is that a perp suits you better.

**The short version:** a perpetual future *lends* you exposure against collateral, so it
must be able to recall that loan — liquidation is not a design flaw, it is the necessary
consequence of borrowing. EXNIHILO lends you nothing. It mints synthetic units out of
thin air and shifts an AMM curve to create your exposure. Nothing was borrowed, so there
is nothing to recall.

The price of that is paid up front: your premium is non-refundable, and a losing
position cannot be closed early at all.

## Side by side

| | Perpetual future | EXNIHILO |
|---|---|---|
| **Exposure comes from** | Borrowing against posted collateral | Synthetic units minted against an AMM curve |
| **Collateral required** | Yes — margin | None |
| **Maximum loss** | Your margin, and on some venues more | The premium you paid, always |
| **Liquidation** | Yes, at a maintenance margin threshold | Structurally impossible |
| **Margin calls** | Yes | None to make |
| **Ongoing cost** | Funding rate — variable, can pay *you* | Renewal fee each period — always a cost |
| **Cost direction** | Either sign | Always against you |
| **Closing at a loss** | Any time | **Not possible** — see below |
| **Payoff shape** | Linear in spot | Bends with size (constant-product curves) |
| **Counterparty** | Order book or pooled vault | One LP per pool |
| **Position lifetime** | Indefinite while margin holds | Fixed deadline, renewable |
| **Position format** | Exchange account balance | Transferable ERC-721 |

## "Leverage" means something different here

A perp quotes leverage as a multiple you select: 10× means $1,000 of exposure per $100
of margin, and a roughly 10% adverse move wipes you out.

EXNIHILO has no leverage selector. What it has is a **premium-to-notional ratio**. Open
$100 of notional in a reasonably sized pool and you pay roughly $5.08 — so you control
$100 of exposure for $5.08 at risk, which is capital efficiency in the neighbourhood of
20×. But the two are not interchangeable:

- On a 20× perp, a ~5% adverse move liquidates you and you lose the $5.
- On EXNIHILO, a 5% adverse move costs you nothing extra. A 50% adverse move costs you
  nothing extra. Your loss is $5.08 in every losing case, including a 99% collapse.

The trade-off is on the other side. Because the premium is a real cost rather than a
returnable margin deposit, **you start behind**. Break-even for a position sized at 1%
of pool reserves lands around **+8.3%**, and it rises with every renewal. A perp's
break-even is roughly flat, moved only by funding.

So the accurate framing is not "cheaper leverage". It is *bounded* leverage, bought with
a known, non-refundable premium — which is to say, an option. See
[Positions Are Options](./positions-are-options) for the full mapping.

## Where perps are genuinely the better instrument

Four cases, stated plainly.

**1. You want to be able to cut a loser.**
This is the big one. An underwater EXNIHILO position **cannot be closed at all** — not
at a loss, not for salvage value. Your only choices are to hold it in the hope it
recovers, or let it settle for nothing at the deadline. A perp lets you exit at any
price. If active risk management is your edge, that edge does not exist here.

**2. You want linear payoff.**
Perp P&L tracks spot linearly. EXNIHILO settlement runs through constant-product curves
both in and out, so realized profit is reduced by slippage — mildly for a position at 1%
of pool reserves, severely at 20%. See [P&L Calculation](/trading/pnl).

**3. You want to hold a large position cheaply for a long time.**
Funding on a perp is often a few basis points per 8 hours and can pay you. EXNIHILO's
renewal fee is 5% of the position's **current mark value** every period, and because it
reprices against notional *plus* profit, a deeply profitable position pays more to stay
alive than a fresh one. Each renewal raises your break-even. See
[Expiry & Renewal](/positions/expiry).

**4. You want depth, or a token nobody has listed.**
Every EXNIHILO pool has exactly one LP who is the counterparty to every position in it,
and that LP sets the position caps. Pools are small on purpose right now. A major perp
venue's book is deeper than any pool here by orders of magnitude.

## Where EXNIHILO is the better instrument

**You are sizing a thesis, not managing a trade.** If your view is "this token either
runs or it does not, and I want a known amount at risk either way", the premium *is* the
whole decision. No monitoring, no maintenance margin, no liquidation price to watch.

**You want exposure to something unlisted.** Markets are permissionless — anyone can
deploy one for any ERC-20 with no governance vote and no listing process. See
[Creating a Market](/markets/creating).

**Volatility is against you in the short run.** A wick that would liquidate a 20× perp
does nothing to an EXNIHILO position. Only the price at the moment you close, or at the
deadline, matters.

**You want a position you can move.** Positions are ERC-721s and can be transferred or
sold while open. Note the auto-renew opt-in clears on transfer — a buyer must opt in
themselves.

**You are trading small.** The 0.05 USDC fee floor means a $1 position is economically
real, and there is no minimum account size. Below about $1 of notional the floor
dominates and the effective rate rises sharply, so this is a floor, not a free lunch.

## Is this a perp? No.

Worth being direct, since the vocabulary overlaps. EXNIHILO has:

- no funding rate
- no maintenance margin
- no liquidation engine
- no order book
- no leverage multiple to select
- no indefinite position lifetime — every position has a deadline

An EXNIHILO long is a **call**; a short is a **put**. The open fee is the premium, the
strike is the pool's spot price at open (always at-the-money), and expiry is the pool's
`positionDuration`. If you know options, you already know this instrument. If you were
looking specifically for a perp, this is not one.

## What can go wrong

The no-liquidation property is real and structural, but it is not the same as safety.
The protocol is young, the pools are small, and all four audit rounds were performed by
AI models rather than a human security firm. Before putting money in, read
[Risk Disclosure](/faq/risks) and [Security](/protocol/security) — both are written to
be read *before* you trade, not after.

## Next

| If you want to | Read |
|---|---|
| Understand the option mapping in full | [Positions Are Options](./positions-are-options) |
| See exactly what you pay | [Fees](/trading/fees) |
| Understand deadlines and renewal cost | [Expiry & Renewal](/positions/expiry) |
| Open your first position | [Opening a Long](/trading/opening-a-long) |
| Know what can go wrong | [Risk Disclosure](/faq/risks) |
