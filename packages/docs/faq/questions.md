# Common Questions

## General

### What does "EXNIHILO" mean?
Latin for "out of nothing" or "out of thin air." It refers to the synthetic minting mechanism — leveraged exposure is created from thin air via the three-curve AMM.

### Who is paying?
When you open a long position, you need someone that will buy via the normal swap to increase the price. That someone could be buying the token on another dex, then arb bots will sync the price. Most projects also have an AVAX pool, actually people buying avax will pay your long. Yes that could even mean institutions. Shorts are different, you sell now the tokens you don't have. When the price is lower, you can buy them back for less.

### How is this different from perpetual futures?
Traditional perps require collateral, charge funding rates, and liquidate positions. EXNIHILO positions don't require any collateral, have a clear deadline, and are never liquidated. Your maximum loss is the fee paid.

### Is there a token?
No. EXNIHILO has no governance token and no plans for one. The protocol is immutable.

## Trading

### Can my position be closed after the deadline?
Positions have a deadline. After expiry, anyone can close your position. Profitable positions pay you the profit minus 1% fee; underwater positions return collateral to the LP. Renew before the deadline to avoid this.

### What's my maximum loss?
Your maximum loss is the USDC fees you paid. You cannot lose more than that.

### What tokens can I trade?
Any ERC-20 token that someone has created a market for. Markets are permissionless — anyone can create one.

### Why did my transaction revert?
Common reasons:
- **Slippage exceeded** — your `minAmountOut` was too tight. Increase slippage tolerance.
- **Position cap exceeded** — the LP set a position size limit. Try a smaller amount.
- **Insufficient approval** — approve the pool to spend your tokens first.

## Positions

### Can I transfer my position?
Yes. Position NFTs are standard ERC-721 tokens. Use any wallet or marketplace to transfer them.

### What happens if my position expires?
If not renewed before the deadline, anyone can call `closePositionAfterDeadline`. Profitable positions still pay you; underwater ones return collateral to the LP with no payout.

### How is P&L calculated?
From current pool reserves at the time of closing. See [P&L Calculation](/trading/pnl) for the formulas.

## Liquidity

### Can anyone provide liquidity?
Only one LP per pool — the market creator. If you want to LP, create your own market.

### How do LPs make money?
Three ways: 3% base fee on every position opened + dynamic impact fee (scales with position size) + passive swap fee yield. See [Fee Earnings](/lp/fees).

### Can the LP rug the pool?
The LP can withdraw liquidity only when there are no open positions. If positions are open, the LP must wait for them to close, be realized, or expire. The LP cannot force-close profitable positions.
