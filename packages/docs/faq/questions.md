---
description: "Common questions about EXNIHILO — what the name means, whether positions are genuinely options, how the fees work, and what happens at expiry."
---

# Common Questions

## General

### What does "EXNIHILO" mean?
Latin for "out of nothing" or "out of thin air." It refers to the synthetic minting mechanism — leveraged exposure is created from thin air via the three-curve AMM.

### Is this actually an option?
Structurally, yes. You pay a non-refundable premium (the open fee), you post no collateral, your max loss is that premium, the position has an expiry, and it settles worthless if you are underwater. A long is a call, a short is a put, and the strike is the spot price at open. See [Positions Are Options](/introduction/positions-are-options) — which also covers the four places the analogy breaks down.

### No collateral and no liquidations? Who eats the loss?
The pool's LP. Explicitly, and by design. Each pool has exactly one LP who is the counterparty to every position in it — in option terms, the writer. They collect the premium on every position opened and pay profitable settlements out of their liquidity. They bound their exposure with [position caps](/lp/position-caps) and are compensated by an [impact fee](/trading/fees#impact-fee-lp-drain-protection) that scales quadratically with position size and open interest. Nothing about this is hidden from either side.

### Isn't a 5% fee enormous?
Only if you compare it to a perp taker fee, which is the wrong comparison. A perp charges 0.05% *on top of* collateral you must post and can lose entirely. EXNIHILO's 5% *replaces* the collateral and is the entire downside. Priced as what it is — an at-the-money option on a volatile token with a 7-day term — 5% of notional is inexpensive.

### Why can't I close a losing position?
Because you never posted collateral, there is nothing to return. The premium bought you a right, not a margin account. An underwater position can be held (renewing it each period) in the hope it recovers, or left to settle for nothing. There is no partial exit and no salvage value — this is the main cost of the no-liquidation design.

### Has it been audited?
Not by a human security firm. Four automated audit rounds have been performed by AI models, each across 11 independent analysis passes, with every finding and remediation published. See [Security](/protocol/security) and [Risk Disclosure](/faq/risks#smart-contract-risk).

### Who is paying?
When you open a long position, you need someone that will buy via the normal swap to increase the price. That someone could be buying the token on another dex, then arb bots will sync the price. Most projects also have an AVAX pool, actually people buying avax will pay your long. Yes that could even mean institutions. Shorts are different, you sell now the tokens you don't have. When the price is lower, you can buy them back for less.

### How is this different from perpetual futures?
Traditional perps require collateral, charge funding rates, and liquidate positions. EXNIHILO positions don't require any collateral, have a clear deadline, and are never liquidated. Your maximum loss is the fee paid.

### Is there a token?
No. EXNIHILO has no governance token and no plans for one. The protocol is immutable.

## Trading

### Can my position be closed after the deadline?
Positions have a deadline. After expiry, anyone can settle your position (they earn a 0.05 USDC bounty for the cleanup). Profitable positions pay you the profit minus 1% fee into your claimable balance; underwater positions return collateral to the LP. To avoid this, either renew before the deadline or opt into [auto-renewal](/positions/expiry#auto-renewal-opt-in) — then a winning position pays its own renewal fees from its profit and keeps running.

### What's my maximum loss?
As a trader, the USDC fees you paid. You cannot lose more than that — it is enforced by the contract, not by policy. Note that renewing a position pays the premium again, so a position held across many periods accumulates cost.

As an **LP** the answer is different: your maximum loss is your full deposited liquidity. See [Fee Earnings](/lp/fees#you-are-the-counterparty).

### How small can a position be?
The fee has a 0.05 USDC floor, so a $1 position costs $0.05 and is economically real. There is no minimum account size. In practice the binding limit is the pool's [position caps](/lp/position-caps), which cap the maximum rather than the minimum.

### What tokens can I trade?
Any ERC-20 token that someone has created a market for. Markets are permissionless — anyone can create one.

### Why did my transaction revert?
Common reasons:
- **Slippage exceeded** — your `minAmountOut` was too tight. Increase slippage tolerance.
- **Position cap exceeded** — the LP set a position size limit. Try a smaller amount.
- **Insufficient approval** — approve the pool to spend your tokens first.

## Positions

### Can I transfer my position?
Yes. Position NFTs are standard ERC-721 tokens. Use any wallet or marketplace to transfer them. Note that the auto-renewal opt-in is cleared on transfer — the new owner must set it themselves.

### What happens if my position expires?
If the holder opted into auto-renewal and the position's profit covers the fee, `settleExpired` renews it instead of closing — no USDC needed from the holder. Otherwise anyone can settle it: profitable positions still pay you (credited to your claimable balance); underwater ones return collateral to the LP with no payout.

### How is P&L calculated?
From current pool reserves at the time of closing. See [P&L Calculation](/trading/pnl) for the formulas.

## Liquidity

### Can anyone provide liquidity?
Only one LP per pool — the market creator. If you want to LP, create your own market.

### How do LPs make money?
Four ways: 3% base fee on every position opened, a dynamic impact fee that scales with position size and open interest, renewal fees (repriced at the position's current value every period — deep winners pay more), and passive swap fee yield. See [Fee Earnings](/lp/fees).

### Can the LP rug the pool?
The LP can withdraw liquidity only when there are no open positions. If positions are open, the LP must wait for them to close or expire. The LP cannot force-close profitable positions.
