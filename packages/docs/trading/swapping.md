---
description: "EXNIHILO pools double as ordinary AMM swap venues using the SWAP-1 curve. How swaps are priced and how the default 1% fee accrues to the LP."
---

# Swapping Tokens

EXNIHILO pools also function as standard AMM swap venues.

## How swaps work

Swaps use **SWAP-1**, the simplest of the three curves:

```
x = backedAirToken
y = backedAirUsd
amountOut = amountIn * y / (x + amountIn)  (minus fee)
```

You can swap in either direction:
- **Token → USDC**: Deposit tokens, receive USDC
- **USDC → Token**: Deposit USDC, receive tokens

## Swap fee

A configurable swap fee (default 1%) is applied to every swap. The fee stays in the pool as passive yield for the LP.

The fee is computed on the *spot value* of the input:

```
fee = amountIn * reserveOut / reserveIn * feeBps / 10000
```

This ensures the fee is a true percentage of notional value, regardless of trade size.

## Slippage protection

Every swap accepts a `minAmountOut` parameter. If the output would be less than this value, the transaction reverts.

## Internal accounting

Under the hood, swaps update the pool's internal airToken / airUsd supply counters. You interact with the real tokens directly — no wrapper tokens exist.
