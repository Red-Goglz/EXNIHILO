---
description: "Create a permissionless market for any ERC-20 token. What you need to seed the pool, the optional position caps, and what the factory deploys."
---

# Creating a Market

Anyone can create a new market for any ERC-20 token. No approvals, no governance votes, no admin permissions.

## What you need

1. **A token address** — any ERC-20 token you want to trade against USDC
2. **Initial token liquidity** — tokens to seed the pool
3. **Initial USDC liquidity** — USDC to seed the other side
4. **Position caps** (optional but recommended) — two independent limits on individual position size, both changeable later by the LP NFT holder:
   - `maxPositionBps` — cap as a share of the pool's USDC reserves, in basis points (allowed range 10–9900, i.e. 0.1%–99%; 0 = disabled). **Recommended: 100 (1%)** — it keeps any single trader from dominating your liquidity and scales automatically as the pool grows.
   - `maxPositionUsd` — hard dollar ceiling per position, applied on top of the % cap (the stricter one wins; 0 = disabled).
5. **Position duration** (optional) — how long each position period lasts before it must be renewed or settled, in seconds. Pass 0 for the 7-day default. Range: 1 hour to 1 year. **Permanent** — it cannot be changed after creation. Shorter periods mean more frequent renewal fee income for you; longer periods are more convenient for traders.

## What happens

Calling `createMarket()` on the Factory:

1. **EXNIHILOPool** deployed — the AMM + trading contract (your token's decimals are read on-chain, fallback 18)
2. **LP NFT minted** — to you, the market creator
3. **Initial liquidity seeded** — your tokens are deposited into the pool
4. **Market registered** — `MarketCreated` event emitted

All of this happens in a single atomic transaction.

## Sizing your pool so it is actually tradable

Position caps interact with pool depth, and it is easy to create a market nobody can
trade. At the recommended `maxPositionBps = 100` (1%):

| Your USDC seed | Max position size | Practical result |
|---|---|---|
| $1,000 | $10 | Too small — traders bounce |
| $10,000 | $100 | Workable for retail-size positions |
| $50,000 | $500 | Comfortable |

If you want to seed shallow, raise `maxPositionBps` deliberately rather than leaving
traders with a $10 ceiling — but understand you are accepting more risk per position
(see [Fee Earnings](/lp/fees#you-are-the-counterparty)). Seeding deeper is the safer way
to get the same tradability.

## Initial price

The initial spot price is determined by the ratio of your seed liquidity:

```
spotPrice = usdcAmount / tokenAmount
```

For example, seeding with 1,000 USDC and 1,000,000 tokens sets the initial price at $0.001 per token.

## After creation

You receive an LP NFT and become the sole liquidity provider. You can:
- Add more liquidity
- Set position caps
- Claim fees as traders open positions
- Transfer the LP NFT to someone else

## Token requirements

- Must be a standard ERC-20 (no fee-on-transfer tokens — the pool rejects them)
- Must have a `decimals()` function (the factory reads it to configure airToken)
- If `symbol()` is unavailable, the factory uses "???" as fallback
