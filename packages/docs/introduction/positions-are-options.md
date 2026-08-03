---
description: "An EXNIHILO long is a call and a short is a put. The full mapping from option mechanics onto the protocol — and the four places the analogy breaks down."
---

# Positions Are Options

If you already know how options work, you already know how EXNIHILO works. This page
is the fastest path to understanding the protocol.

## The mapping

EXNIHILO positions are not margin trades. They have the exact shape of an option:

| Option | EXNIHILO |
|---|---|
| **Premium** — paid upfront, non-refundable | The open fee: 5% of notional + impact fee |
| **Max loss = premium** | Max loss = the fee you paid |
| **Strike** | The pool's spot price at open — always at-the-money |
| **Expiry** | The pool's `positionDuration` (default 7 days) |
| **Rolling to the next expiry** | `renewPosition` — pay the renewal fee |
| **Expires worthless** | Underwater at deadline → position settles, you get nothing |
| **Exercise** | `closeLong` / `closeShort` — settle in USDC at any time while in profit |
| **Call** | **Long** — profits when the token rises |
| **Put** | **Short** — profits when the token falls |

There is no strike to choose, no implied volatility to model, and no Greeks. You pick a
direction, pay the premium, and the position runs until you close it or it expires.

## Why there are no liquidations

This is the question everyone asks first, and the answer is structural rather than
clever.

Margin products **lend** you exposure. Anything lent can be recalled — that is what
liquidation *is*. It isn't a design flaw in perps; it's the necessary consequence of
borrowing.

EXNIHILO lends you nothing. When you open a position, the protocol **mints synthetic
units out of thin air** and shifts the AMM's price curve to create your exposure. No
capital was borrowed, so there is nothing to recall. See
[Key Concepts](./key-concepts#synthetic-minting).

This is precisely why the premium is non-refundable and why a losing position cannot be
closed: you never posted collateral, so there is nothing to give back.

## The arithmetic

Opening a $100 position in a pool with $10,000 of USDC reserves:

```
Notional            $100.00
Base fee (5%)       $  5.00
Impact fee          $  0.08     (1500 × N × (2·OI + N) / (2 × backedAirUsd × 10000))
─────────────────────────────
Total premium       $  5.08     ← the most you can ever lose
```

Approximate outcomes at expiry, **before slippage**:

| Token move | Long P&L | Return on the $5.08 paid |
|---|---|---|
| +200% | ≈ +$200 | ≈ 40× |
| +50% | ≈ +$50 | ≈ 10× |
| +5% | ≈ +$5 | ≈ 1× |
| Any move down | −$5.08 | Total loss of premium |

::: warning Settlement is AMM-based, not linear
These figures are illustrative. Real settlement runs through the pool's curves
([P&L Calculation](/trading/pnl)), so your realized profit is reduced by slippage —
significantly so if your position is large relative to pool reserves. A position that
is 1% of pool reserves behaves close to the table above; one that is 20% does not.
:::

Because the fee has a **0.05 USDC floor**, a $1 position costs $0.05 and is
economically real. There is no minimum account size.

::: warning The floor cuts both ways
Below $1 of notional the floor *exceeds* the 5% base rate, and the effective cost rises
sharply — a $0.25 position still pays $0.05, which is 20%. Above $1 the rate settles at
5% and break-even lands around **+8.3%** for a position sized at 1% of pool reserves,
regardless of how large the pool is.

The pool sizes above are illustrative. The [app](https://exnihilo.markets/app) computes
the real maximum position, effective fee rate and break-even for each live pool.
:::

## Where the option analogy breaks

Four differences that matter, stated plainly:

**1. There is no salvage value.** A losing option can usually be sold back for whatever
time value remains. An underwater EXNIHILO position cannot be closed at all — it can
only be held in the hope it recovers, or left to settle for nothing. Your exit is
binary.

**2. The premium recurs.** An option's premium is paid once. EXNIHILO's renewal fee is
charged every period, and it is **repriced against the position's current mark value**
(notional + profit, floored at notional) plus a slice of the open-interest impact fee.
A deeply profitable position pays more to stay alive than a fresh one. Each renewal
raises your break-even. See [Expiry & Renewal](/positions/expiry).

**3. Payoff is not linear in spot.** Both entry and exit run through constant-product
curves, so the relationship between token price and P&L bends with position size.

**4. The writer is one party, not a market.** Every pool has exactly one LP, and that LP
is the counterparty to every position in it. They set the position caps and they carry
the risk. See [Fee Earnings](/lp/fees#you-are-the-counterparty).

## Who pays for your profit

The pool's LP. Their liquidity is the source of every payout, which is why the protocol
charges an impact fee that scales quadratically with position size and open interest —
it is sized to compensate the LP above the price-distortion cost of writing the
position.

Externally, the pool's price is kept honest by arbitrage: when EXNIHILO's price diverges
from other venues, arbitrageurs swap against SWAP-1 to close the gap. Your long is
ultimately paid by flow that pushes the pool price up.

## Reading the rest of the docs

| If you want to | Read |
|---|---|
| Compare this against perps | [vs Perpetual Futures](./vs-perpetuals) |
| Open your first position | [Opening a Long](/trading/opening-a-long) |
| Understand the pricing engine | [Key Concepts](./key-concepts) |
| Know exactly what you pay | [Fees](/trading/fees) |
| Understand expiry and rolling | [Expiry & Renewal](/positions/expiry) |
| Write options as an LP | [Fee Earnings](/lp/fees) |
| See what can go wrong | [Risk Disclosure](/faq/risks) |
