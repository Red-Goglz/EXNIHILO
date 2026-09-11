---
description: "Create a permissionless market for any ERC-20 token. What you need to seed the pool, how the automatic position cap works, what the factory deploys, and which token transfer restrictions a market can and cannot live with."
---

# Creating a Market

Anyone can create a new market for any ERC-20 token. No approvals, no governance votes, no admin permissions.

## What you need

1. **A token address** — any ERC-20 token you want to trade against USDC
2. **Initial token liquidity** — tokens to seed the pool
3. **Initial USDC liquidity** — USDC to seed the other side
4. **Position caps** — nothing to supply. Every market caps individual positions at 1% of its USDC reserves on day one, widening automatically to 20% over the first 24 hours. It cannot be configured at creation or changed afterwards. See [Position Caps](/lp/position-caps).
5. **Position duration** — nothing to supply. A position's lifetime steps with the market's age: 1 hour when brand new, then 8 hours, 24 hours and 7 days, reaching 30 days once the market is a week old. See [Expiry & Renewal](/positions/expiry#position-duration).

## What happens

Calling `createMarket()` on the Factory:

1. **EXNIHILOPool** deployed — the AMM + trading contract (your token's decimals are read on-chain, fallback 18)
2. **LP NFT minted** — to you, the market creator
3. **Initial liquidity seeded** — your tokens are deposited into the pool
4. **Market registered** — `MarketCreated` event emitted

All of this happens in a single atomic transaction.

## Sizing your pool so it is actually tradable

The position cap is a percentage of your USDC seed, so how deep you seed decides
what anyone can trade. The cap opens at 1% and reaches 20% after 24 hours:

| Your USDC seed | Max position, day one | Max position, after 24h |
|---|---|---|
| $1,000 | $10 | $200 |
| $10,000 | $100 | $2,000 |
| $50,000 | $500 | $10,000 |

Since the cap cannot be raised, **seeding deeper is the only way to make larger
trades possible**. A shallow pool stays a shallow pool, and its first day is
tighter still — expect little activity until the ramp has run.

## Initial price

The initial spot price is determined by the ratio of your seed liquidity:

```
spotPrice = usdcAmount / tokenAmount
```

For example, seeding with 1,000 USDC and 1,000,000 tokens sets the initial price at $0.001 per token.

## After creation

You receive an LP NFT and become the sole liquidity provider. You can:
- Add more liquidity
- Claim fees as traders open positions
- Transfer the LP NFT to someone else

## Token compatibility

Market creation is permissionless, so nothing vets your token beyond reading its
decimals and rejecting fee-on-transfer. Whether it actually *works* is on you —
and the failure mode is not a rejected transaction, it is liquidity that cannot
move afterwards.

### Hard requirements

- **Standard ERC-20 semantics** for `transfer`, `transferFrom` and `approve`.
- **No fee-on-transfer.** Both the factory and the pool compare their own balance
  before and after every pull and revert `FeeOnTransferNotSupported` when the
  amount that arrived is short of the amount requested. A deflationary or
  reflection token cannot seed a market.
- **A `decimals()` function.** Read on-chain at creation, with 18 as the
  fallback. The value is baked into the pool's airToken accounting and can never
  be changed, so a token that reports the wrong number produces a permanently
  mispriced market.
- `symbol()` is optional — the factory falls back to `"???"`.

### Tokens with transfer restrictions

Whitelists, blacklists, anti-whale caps, `maxTxAmount`, pause switches and
cooldowns are all common and all workable — but they have to be configured for
EXNIHILO **before** liquidity is committed, because seeding is irreversible.

**Exempt the factory address.**

| Network | EXNIHILOFactory |
|---|---|
| Avalanche C-Chain | `0xBe6Fb0e7b7d8EFD491FEbC436F737cE8B244F85a` |

Creating a market moves your entire token seed in two hops, inside one
transaction:

| # | Transfer | Called by |
|---|---|---|
| 1 | `transferFrom(seeder → factory)` | the factory |
| 2 | `transferFrom(factory → pool)` | the pool |

The factory is a party to both — `to` on the first hop, `from` on the second —
so a single exemption on that one fixed address clears the whole handoff. This
works for the usual `if (!exempt[from] && !exempt[to])` shape that anti-whale and
max-transaction logic is normally written in.

::: warning The pool address cannot be allowlisted in advance
The pool is deployed inside the same transaction that seeds it, with plain
`CREATE` — its address depends on `PoolDeployer`'s nonce, which moves every time
*anyone* creates a market. It is not knowable when you configure your token, and
there is no moment between its creation and the transfer into it.

So two token designs cannot be made to work at all, no matter how they are
configured:

- **Default-deny allowlists**, where every counterparty must be listed
- **Exemptions keyed only on `from`**, which never sees the factory on hop 2

If your token is one of these, do not seed a market with it.
:::

### After the market exists

Every open, close and swap moves tokens between traders and the pool, so the
restriction has to stay lifted for the life of the market:

- Do not blacklist the pool or the factory afterwards.
- Do not pause transfers — trading and settlement both stop.
- A `maxTxAmount` low enough to block ordinary trade sizes throttles the market
  the same way it would on any AMM.

### Summary

| Token behaviour | Outcome |
|---|---|
| Plain ERC-20 | Works |
| Blacklist, default-allow | Works — never blacklist the factory or the pool |
| `maxTxAmount` / anti-whale with either-party exemption | Works — exempt the factory |
| Pausable | Works while unpaused; a pause halts trading and settlement |
| Fee-on-transfer / reflection | Rejected at creation |
| Default-deny allowlist | Cannot work — the pool address is unknowable in advance |
| Exemption keyed only on `from` | Cannot work — same reason |

### Pre-market launches

A [pre-market](/developers/sdk#launchpad-integration) buyout hands its reserves to the same factory
on the same two hops, with the pre-market itself as `from` on the first one.
Exempting the factory covers it identically.

One difference matters: a pre-market has **no refund, withdrawal or expiry
path**. Seeding is one-way and the buyout is the only exit. If the token blocks
the handoff, the buyout reverts for everybody, permanently — stranding both the
token reserve and every buyer's quote asset with no way to recover either. Test
the token's transfer policy against the factory address before seeding, not
after.
