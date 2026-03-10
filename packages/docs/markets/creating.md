# Creating a Market

Anyone can create a new market for any ERC-20 token. No approvals, no governance votes, no admin permissions.

## What you need

1. **A token address** — any ERC-20 token you want to trade against USDC
2. **Initial token liquidity** — tokens to seed the pool
3. **Initial USDC liquidity** — USDC to seed the other side
4. **Swap fee** — the fee percentage for swaps (in basis points, e.g., 100 = 1%)

## What happens

Calling `createMarket()` on the Factory:

1. **AirToken** deployed — ERC-20 wrapper for your underlying token (matches its decimals)
2. **AirUsd** deployed — ERC-20 wrapper for USDC (6 decimals)
3. **EXNIHILOPool** deployed — the AMM + trading contract
4. **LP NFT minted** — to you, the market creator
5. **Initial liquidity seeded** — your tokens are deposited into the pool
6. **Market registered** — `MarketCreated` event emitted

All of this happens in a single atomic transaction.

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
