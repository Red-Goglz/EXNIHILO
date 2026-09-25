---
description: "Perpetual options versus perpetual futures: exposure with no liquidation, because EXNIHILO lends you nothing. The full comparison — including where a perp wins."
---

# EXNIHILO vs Perpetual Futures

**The short version:** a perpetual future *lends* you exposure against collateral, so it must be
able to recall the loan — that is liquidation. EXNIHILO sells you a perpetual option instead: it
mints synthetic units against an AMM curve, so nothing was borrowed and nothing can be recalled.
The price is paid up front: the premium is non-refundable, and a losing position cannot be closed
early.

## Side by side

| | Perpetual future | EXNIHILO |
|---|---|---|
| **Instrument** | Linear future | Perpetual call or put |
| **Exposure from** | Borrowing against collateral | Synthetic units minted against a curve |
| **Collateral** | Margin | None |
| **Maximum loss** | Your margin, sometimes more | The premium, always |
| **Liquidation** | At a maintenance margin | Structurally impossible |
| **Ongoing cost** | Funding, either sign | Funding, always a cost, taken in size |
| **Closing at a loss** | Any time | **Not possible** |
| **Payoff** | Linear in spot | Bends with size |
| **Counterparty** | Order book or vault | One LP per pool |
| **Position** | Account balance | Transferable ERC-721 |

## "Leverage" means something different

A perp's 10× means $1,000 of exposure per $100 of margin, wiped out by a ~10% adverse move.
EXNIHILO has no leverage selector: $100 of notional costs about $5.08, roughly 20× capital
efficiency — but a 5%, 50% or 99% adverse move costs nothing beyond that $5.08.

The trade-off is that you **start behind**. The premium is spent, not deposited, so break-even
for a position at 1% of pool reserves is around **+8.3%**. Funding does not move that
break-even; it shrinks the position behind it.

## Where a perp is the better instrument

1. **You want to cut a loser.** An underwater EXNIHILO position cannot be closed at any price.
   If active risk management is your edge, that edge does not exist here.
2. **You want linear payoff.** Settlement runs through constant-product curves, so profit is
   reduced by slippage — mildly at 1% of pool reserves, severely at 20%.
3. **You want to hold size cheaply for a long time.** A perp's funding is often a few basis
   points per 8 hours and can pay you. EXNIHILO's is priced as an option's carry: around 10% of
   the position a day on a 1-day-old market, about 0.34% a day on a mature one, and several
   times that on a crowded side. See [Funding](/positions/funding).
4. **You want depth.** One LP per pool, and positions capped at 1%–20% of reserves. A major perp
   venue is deeper by orders of magnitude.

## Where EXNIHILO is the better instrument

- **You are sizing a thesis, not managing a trade.** The premium is the whole decision — no
  maintenance margin, no liquidation price to watch.
- **The token is unlisted.** Anyone can create a market for any ERC-20. See
  [Creating a Market](/markets/creating).
- **Short-run volatility is against you.** A wick that liquidates a 20× perp does nothing here;
  only the price when you close matters.
- **You want a position you can move.** Positions are ERC-721s and can be sold while open, on
  unchanged terms.
- **You are trading small.** The fee floor is 0.05 USDC, so a $1 position is real.

## A perpetual option, not a perpetual future

It trades like a perp — long or short, no expiry, funding — but has no maintenance margin, no
liquidation engine, no order book and no leverage multiple. Its funding never pays you and never
balances longs against shorts: it is the option's theta, paid to the LP. A long is a **call**, a
short is a **put**. See [Perpetual Options](./positions-are-options).

The no-liquidation property is structural, but it is not the same as safety. Every audit round
so far has been performed by AI models, not a human firm — read [Risk Disclosure](/faq/risks)
and [Security](/protocol/security) before trading.
