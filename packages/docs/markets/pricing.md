# How Pricing Works

EXNIHILO derives all prices from its own AMM curves. There are no oracles.

## Spot price

The spot price of the underlying token in USDC is:

```
spotPrice = backedAirUsd / backedAirToken
```

This represents the raw USDC units per whole token. The frontend adjusts for decimals when displaying.

## Constant-product formula

All three AMM curves use the same formula:

```
amountOut = amountIn * reserveOut / (reserveIn + amountIn)
```

This is the standard Uniswap-style `x * y = k` model. Larger trades relative to reserves incur more slippage.

## Three curves, three reserve pairs

| Curve | reserveIn / reserveOut | Purpose |
|---|---|---|
| SWAP-1 | backedAirToken ↔ backedAirUsd | Normal swaps |
| SWAP-2 | backedAirToken ↔ airUsd.totalSupply() | Long open / short close |
| SWAP-3 | airToken.totalSupply() ↔ backedAirUsd | Short open / long close |

The key difference between curves is what counts as "reserves":
- **SWAP-1** uses only backed reserves (real collateral)
- **SWAP-2 / SWAP-3** use one backed reserve and one totalSupply (backed + synthetic)

This means leveraged positions trade against a different curve than spot swaps, which is what creates the leveraged exposure.

## Price impact

Price impact depends on trade size relative to reserves:
- Small trades: minimal slippage
- Large trades: significant slippage
- The `minAmountOut` parameter on every operation protects against excessive slippage

## No oracle manipulation

Since prices are derived entirely from the pool's own state, there is no oracle to manipulate. However, the pool price can diverge from external market prices — this creates arbitrage opportunities that help keep prices aligned.
