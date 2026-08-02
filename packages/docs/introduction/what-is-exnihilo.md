---
description: "EXNIHILO lets you go long or short any ERC-20 token with no collateral and no liquidation. You pay a premium, and that premium is your entire downside."
---

# What is EXNIHILO

EXNIHILO ("Out of Thin Air") lets you go long or short on any ERC-20 token without
posting collateral and without any risk of liquidation.

**The shortest accurate description: EXNIHILO positions are options.** You pay a
premium — the open fee, roughly 5% of your position size — and that premium is the most
you can ever lose. A long behaves like a call, a short like a put. There is no strike to
choose, no implied volatility, and no margin call.

If that framing lands, read [Positions Are Options](./positions-are-options) next; it
covers the whole protocol in one page.

## How it's different

| Traditional Perps | EXNIHILO |
|---|---|
| Requires collateral + margin | Only the open fee — a premium |
| Liquidation engine force-closes positions | No liquidations, ever — nothing was borrowed |
| Loss can exceed your deposit | Max loss is fixed and known before you open |
| Oracle-dependent pricing | Price derived from the pool's own AMM curves |
| Listing is governance-gated | Anyone can create a market, one transaction |
| Positions are account-bound | Positions are transferable NFTs |
| Positions run indefinitely | Positions expire and must be renewed |

## How it works in 30 seconds

1. **Pick a token** — Browse existing markets or create one for any ERC-20.
2. **Go long or short** — Enter your USDC amount and pay the fee. The protocol mints
   synthetic units via its three-curve AMM to give you exposure. You post no collateral.
3. **Close when ready** — No margin calls, no liquidation risk. Close in profit and
   receive USDC.

Your position is an NFT with fully on-chain SVG artwork showing live P&L — you can
transfer or sell it at any time without closing it.

## What it costs, and what you can lose

Opening a $100 position in a pool with $10,000 of USDC reserves costs about **$5.08**
(5% base fee + a small impact fee). That $5.08 is your entire downside. If the token
doubles you make roughly $100 on it; if the token goes to zero you lose the $5.08 and
nothing more.

The fee has a **0.05 USDC floor**, so a $1 position is economically real. There is no
minimum account size.

::: tip These figures scale with the pool
$100 is an illustration, not what is currently openable. Each pool's LP sets a position
cap (commonly 1% of reserves), and liquidity is being scaled up deliberately while the
protocol is young — so today's maximum position is much smaller.

The [app](https://exnihilo.markets/app) shows each pool's live maximum position,
effective fee rate and break-even move, read straight from the contracts. Trust those
over any number written in the docs.

Note also that below $1 of notional the 0.05 USDC floor exceeds the 5% base rate, so
very small positions pay a proportionally higher fee.
:::

::: warning Two things to understand before you trade
**Positions expire.** Each pool sets a `positionDuration` (default 7 days). Renew before
the deadline, opt into auto-renewal, or the position settles. You must be right *within
the window*.

**Losing positions cannot be closed.** There is no salvage value — an underwater
position either recovers or settles for nothing.
:::

## Where does the leverage come from?

EXNIHILO uses a three-curve constant-product AMM. When you open a position, the protocol
mints *synthetic* (unbacked) units that inflate the AMM's supply counters. This shifts
the price curve, creating exposure without borrowing, margin, or oracles.

This is also the reason there are no liquidations. Margin products **lend** you
exposure, and anything lent can be recalled — that is what liquidation is. EXNIHILO
lends you nothing, so there is nothing to recall.

See [Key Concepts](./key-concepts) for a deeper explanation.

## Who is on the other side

Each pool has exactly one liquidity provider, and that LP is the counterparty to every
position in it — your profit is paid out of their liquidity. In option terms, the LP is
the writer. They set position caps to bound their exposure and earn the premium on every
position opened. See [Fee Earnings](/lp/fees).

## Chains

EXNIHILO is live on **Avalanche C-Chain mainnet** (chain ID 43114), quoted in Circle's
native USDC. It is the only network the app shows.

Market creation is permissionless — pools are created by users rather than shipped with
the protocol. Contract addresses are on the [addresses page](/protocol/addresses).
