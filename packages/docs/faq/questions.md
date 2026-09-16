---
description: "Common questions about EXNIHILO — whether positions are genuinely options, who pays a winning trade, how the fees work, and what funding does to a position you hold."
---

# Common Questions

## General

### What does "EXNIHILO" mean?
Latin for "out of nothing". Exposure is created out of thin air: opening a position mints synthetic
units against the pool's curves instead of borrowing anything.

### Is this actually an option?
Structurally, yes. You pay a non-refundable premium, post no collateral, can lose at most the
premium, and hold nothing of value while underwater. A long is a call and a short a put, struck at
the price when you open. [Positions Are Options](/introduction/positions-are-options) covers where
the analogy breaks.

### No collateral and no liquidations — who eats the loss?
The pool's LP, by design. Each pool has one LP who is the counterparty to every position in it: they
collect the premium and funding, pay every profitable close, and are protected by an automatic
[position cap](/lp/position-caps) and an [impact fee](/protocol/fees#open-fee) that grows with size
and crowding.

### Isn't a 5% fee enormous?
Only next to a perp's taker fee, which sits on top of collateral you can lose. EXNIHILO's 5%
*replaces* the collateral and is the whole downside — compare it to an at-the-money option on a
volatile token.

### Where does a winning trader's profit come from?
From the LP's reserves, replenished by the flow that moved the price. A long wins when buyers push
the pool's price up — directly, or through arbitrage with other venues where the token trades. A
short wins when sellers push it down.

### How is this different from a perp?
No collateral, no liquidation, and a maximum loss fixed at open. Funding here never pays you and
never balances longs against shorts: it is rent on the LP's capital, taken by shrinking your
position. See [vs Perpetual Futures](/introduction/vs-perpetuals).

### Has it been audited?
Not by a human firm. Five AI audit rounds have been published, and the move to continuous funding
came after the latest one and has not been audited. See [Security](/protocol/security).

### Is there a token?
No, and no governance. The contracts are immutable.

## Trading

### What happens if I leave a position open?
It keeps running — nothing expires and nobody else can close it. It shrinks with funding: steeply on
a new market, slowly on a mature one, faster on a crowded side. Your break-even never moves; the size
behind it does. See [Funding](/positions/funding).

### What is my maximum loss?
As a trader, the fee you paid — enforced by the contract. As an **LP**, your whole deposit; see
[Fee Earnings](/lp/fees#you-are-the-counterparty).

### Why can't I close a losing position?
You posted no collateral, so there is nothing to return. An underwater position can be held
indefinitely, shrinking, in the hope it recovers — but it has no salvage value.

### How small can a position be?
The fee has a 0.05 USDC floor, so a $1 position is real. The binding limit is the maximum — the
[position cap](/lp/position-caps).

### Why did my transaction revert?
- **`InsufficientOutput`** — slippage; widen your tolerance.
- **`LeverageCapExceeded`** — over the position cap (1% of the pool on day one, 20% after 24 hours).
- **`PoolClosing`** — the market is winding down and accepts no new positions.
- **`PositionUnderwater`** — the position is not in profit, so it cannot be closed.
- **Allowance** — approve USDC to the router (or the pool) first.

## Positions

### Can I transfer my position?
Yes — it is a standard ERC-721, and it keeps its terms and its decay in the new owner's hands.

### Can anyone else close my position?
No. The only third-party action is `sweepDust`, once funding has taken all but 0.1% of the collateral
a position opened with. If the sweep prices what is left in profit, that payout is credited to you;
a caller who moves the price first can deny you it, but it is at most that last 0.1%.

## Liquidity

### Can anyone provide liquidity?
One LP per pool — whoever holds its LP NFT, initially the market creator. To be an LP, create a
market.

### How do LPs make money?
The 4% open fee, the impact fee, funding on every open position, and swap fees. Funding and swap fees
stay in the pool's reserves rather than becoming claimable. See [Fee Earnings](/lp/fees).

### Can the LP rug the pool?
The LP can withdraw only when no position is open. Closing the pool — which the LP or the factory's
emergency role can do — blocks new positions and, after 7 days, doubles funding daily, so open
positions have to be closed or decay away within about two and a half weeks. Nothing is force-closed
at a price the holder did not choose.
