---
description: "EXNIHILO pools double as ordinary AMM swap venues on the SWAP-1 curve. How swaps are priced and how the fixed 1% fee accrues to the LP."
---

# Swapping Tokens

Every pool is also an ordinary token/USDC AMM. Swaps use **SWAP-1**, the backed reserves:

```
rawOut = amountIn × reserveOut / (reserveIn + amountIn)
fee    = amountIn × reserveOut / reserveIn × 1%          (rounded up)
out    = rawOut − fee
```

- **Either direction** — `swap(amountIn, minAmountOut, tokenToUsdc, recipient)` on the pool, or
  through the router.
- **Fee** — a fixed 1%, identical on every market, measured on the spot value of the input and
  kept in the pool's reserves as LP yield. Because it is measured against `reserveIn` rather than
  `reserveIn + amountIn`, it grows with trade size: large price-moving swaps pay more, and a swap
  so large the fee exceeds the output reverts.
- **Slippage** — `minAmountOut` reverts the swap if the output falls short.

You trade the real token and USDC; airToken and airUsd are internal counters, not tokens. Swaps
are also what keeps a pool's price in line with other venues — see
[Pricing & Reserves](/markets/pricing).
