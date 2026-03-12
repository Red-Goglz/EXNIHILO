# Common Questions

## General

### What does "Ex Nihilo" mean?
Latin for "out of nothing" or "out of thin air." It refers to the synthetic minting mechanism — leveraged exposure is created from thin air via the three-curve AMM.

### How is this different from perpetual futures?
Traditional perps require collateral, charge funding rates, and liquidate positions. EXNIHILO positions don't require any collateral, have no funding rates, and are never liquidated. Your maximum loss is the fee paid.

### Is there a token?
No. EXNIHILO has no governance token and no plans for one. The protocol is immutable.

## Trading

### Can I get liquidated?
No. There is no liquidation engine. Your position stays open until you choose to close it, or the LP force-realizes it (only when underwater AND you get the locked tokens anyway).

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

### What happens if the LP force-realizes my position?
Your position is settled and the NFT is burned. You received the locked tokens.

### How is P&L calculated?
From current pool reserves at the time of closing. See [P&L Calculation](/trading/pnl) for the formulas.

## Liquidity

### Can anyone provide liquidity?
Only one LP per pool — the market creator. If you want to LP, create your own market.

### How do LPs make money?
Two ways: 3% fee on every position opened + passive swap fee yield. See [Fee Earnings](/lp/fees).

### Can the LP rug the pool?
The LP can withdraw liquidity only when there is no open position. The LP can force-realize underwater positions. If you are in profit, the LP can't close or withdraw the liquidity. 
