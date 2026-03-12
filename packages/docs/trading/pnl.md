# P&L Calculation

Position profit and loss is computed entirely from on-chain pool state — no oracles involved.

## Long P&L

When closing a long, the locked airToken tokens are swapped back to airUsd via SWAP-3:

```
airUsdOut = lockedAmount * backedAirUsd / airToken.totalSupply()
pnl = airUsdOut - airUsdMinted
```

- If `pnl > 0` — profit. You receive `usdcIn + pnl` (minus 1% close fee on profit).
- If `pnl < 0` — loss. You can't close the position.

## Short P&L

When closing a short, the synthetic airToken debt is bought back via SWAP-2:

```
cost = airUsd.totalSupply() * airTokenMinted / (backedAirToken - airTokenMinted)
pnl = lockedAmount - cost
```

- If `pnl > 0` — the token price dropped, buying back the debt is cheap. Profit.
- If `pnl < 0` — the token price rose, you can't close the position.

## Live P&L on your NFT

The PositionNFT contract computes P&L in real-time using calls to the pool. This data is rendered directly in the on-chain SVG metadata — no off-chain service needed.

## Important notes

- P&L depends on pool reserves at the time of closing, not at the time of opening
- Large positions relative to pool size will experience more slippage
- The three-curve design means long and short P&L are not perfectly symmetric
