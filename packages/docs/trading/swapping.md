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

## Wrapper tokens

Under the hood, swaps operate on AirTokens (airToken / airUsd). The pool automatically wraps your raw tokens on deposit and unwraps on withdrawal — you interact with the real tokens directly.
