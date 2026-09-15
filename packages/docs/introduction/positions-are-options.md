---
description: "An EXNIHILO long is a call and a short is a put. The full mapping from option mechanics onto the protocol — and the four places the analogy breaks down."
---

# Positions Are Options

If you know how options work, you already know how EXNIHILO works.

## The mapping

| Option | EXNIHILO |
|---|---|
| **Premium** — paid upfront, non-refundable | The open fee: 5% of notional + impact fee |
| **Maximum loss = premium** | Maximum loss = the fee you paid |
| **Strike** | The pool price at open — always at-the-money |
| **Expiry** | None — a perpetual option |
| **Theta** | Funding: a fraction of the position goes to the LP every second |
| **Expiring worthless** | An underwater position decays to nothing |
| **Exercise** | `closeLong` / `closeShort` — settle in USDC any time you are in profit |
| **Call / put** | **Long** / **short** |

There is no strike to choose, no implied volatility to model, and no Greeks. You pick a
direction and pay the premium; the position runs until you close it, shrinking a little every
second.

## Why there are no liquidations

Margin products lend you exposure, and anything lent can be recalled — that recall is
liquidation. EXNIHILO lends nothing: opening a position mints synthetic units and shifts the
pool's curve ([how](/markets/pricing#synthetic-supply)). With nothing borrowed there is nothing
to recall. It is also why the premium is non-refundable and a losing position cannot be closed:
you never posted collateral, so there is nothing to give back.

## The arithmetic

A $100 position in a pool with $10,000 of USDC:

```
Notional            $100.00
Base fee (5%)       $  5.00
Impact fee          $  0.08
─────────────────────────────
Premium             $  5.08     ← the most you can lose
```

| Token move | Long P&L, before slippage and funding | Return on $5.08 |
|---|---|---|
| +200% | ≈ +$200 | ≈ 40× |
| +50% | ≈ +$50 | ≈ 10× |
| Any move down | −$5.08 | Total loss of premium |

Settlement runs through the pool's curves, so real payouts are lower — mildly for a position at
1% of the pool, heavily at 20% — and break-even for a 1%-sized position is around **+8.3%**.
Below $1 of notional the 0.05 USDC floor exceeds 5%, so tiny positions pay proportionally more.
See [P&L Calculation](/trading/pnl).

## Where the analogy breaks

1. **No salvage value.** A losing option can be sold for its remaining time value. An
   underwater EXNIHILO position cannot be closed at all — it recovers or decays.
2. **The premium recurs.** An option's premium is paid once; here funding is charged for as long
   as you hold, because a perpetual option with a single premium would be worth an unbounded
   amount. It is charged in size, not value: collateral and debt shrink together, so your
   break-even never moves — there is just less position behind it.
3. **Payoff is not linear in spot.** Entry and exit both run through constant-product curves, so
   P&L bends with position size.
4. **The writer is one party.** Each pool's single LP is the counterparty to every position in
   it, bounded by an automatic [position cap](/lp/position-caps). See [Fee Earnings](/lp/fees).

## Where to next

| If you want to | Read |
|---|---|
| Compare against perps | [vs Perpetual Futures](./vs-perpetuals) |
| Open a position | [Opening a Position](/trading/opening) |
| Know exactly what you pay | [Fees](/protocol/fees) |
| Understand holding costs | [Funding](/positions/funding) |
| See what can go wrong | [Risk Disclosure](/faq/risks) |
