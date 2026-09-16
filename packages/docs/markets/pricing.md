---
description: "How EXNIHILO prices everything from its own curves with no oracles: the three constant-product curves, backed versus synthetic supply, and the reserve identities that keep positions solvent."
---

# Pricing & Reserves

EXNIHILO derives every price from the pool's own state. There are no oracles.

## Two units, four counters

Each pool tracks two internal accounting units — **airToken** and **airUsd** — as plain counters.
They are not tokens: nothing is minted, transferable or holdable.

| Counter | Holds |
|---|---|
| `backedAirToken` / `backedAirUsd` | The tokens and USDC the pool holds for the LP |
| `airTokenSupply` / `airUsdSupply` | Everything: the backed reserve, collateral locked in positions, and synthetic debt |

## Three curves

All three use `amountOut = amountIn × reserveOut / (reserveIn + amountIn)`, minus a 1% fee:

| Curve | Reserves | Used for |
|---|---|---|
| **SWAP-1** | `backedAirToken` ↔ `backedAirUsd` | Swaps |
| **SWAP-2** | `backedAirToken` ↔ `airUsdSupply` | Opening longs, closing shorts |
| **SWAP-3** | `airTokenSupply` ↔ `backedAirUsd` | Opening shorts, closing longs |

```
spotPrice  = backedAirUsd / backedAirToken
longPrice  = airUsdSupply / backedAirToken      // marginal long entry
shortPrice = backedAirUsd / airTokenSupply      // marginal short entry
```

Swaps trade only the backed reserves; positions trade against one backed reserve and one supply
counter. That difference is where the exposure comes from.

## Synthetic supply

Opening a long mints synthetic airUsd into `airUsdSupply`, with no USDC behind it, and buys
airToken with it through SWAP-2. Opening a short mints synthetic airToken into `airTokenSupply`
and sells it through SWAP-3. The minted units are the position's debt: closing burns it, and
funding shrinks it continuously. Nothing is borrowed, which is why nothing can be liquidated.

## How the counters move

| Operation | backedAirToken | backedAirUsd | airTokenSupply | airUsdSupply |
|---|---|---|---|---|
| Add liquidity | ↑ | ↑ | ↑ | ↑ |
| Withdraw liquidity | ↓ | ↓ | ↓ | ↓ |
| Swap token → USDC | ↑ | ↓ | ↑ | ↓ |
| Swap USDC → token | ↓ | ↑ | ↓ | ↑ |
| Open long | ↓ collateral locked | — | — | ↑ debt |
| Open short | — | ↓ collateral locked | ↑ debt | — |
| Close long | ↑ collateral returns | ↓ profit paid | — | ↓ debt + profit |
| Close short | — | ↑ collateral less profit | ↓ debt | ↓ profit |
| Long funding | ↑ collateral released | — | — | ↓ debt |
| Short funding | — | ↑ collateral released | ↓ debt | — |

Two identities hold exactly at all times:

```
airTokenSupply == backedAirToken + totalLongCollateral  + totalShortDebt
airUsdSupply   == backedAirUsd   + totalShortCollateral + longOpenInterest
```

`longOpenInterest` and `shortOpenInterest` are the live notional on each side — a long's notional
is also its debt — and both shrink with funding. After every operation the pool also checks its
real token balances against every obligation; see [Security](/protocol/security#reserve-invariant).

## Price impact and arbitrage

Larger trades relative to reserves move the price more, so swaps, opens and closes all take a
minimum output. With no oracle there is nothing external to manipulate, but a pool's price can
drift from other venues; arbitrage through SWAP-1 pulls it back, and that flow is ultimately what
pays a winning position.
