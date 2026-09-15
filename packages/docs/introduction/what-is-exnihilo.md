---
description: "EXNIHILO lets you go long or short any ERC-20 token with no collateral and no liquidation. You pay a premium, and that premium is your entire downside."
---

# What is EXNIHILO

EXNIHILO ("out of thin air") lets you go long or short any ERC-20 token without posting
collateral and without any risk of liquidation.

**Positions are options.** You pay a premium — the open fee, roughly 5% of position size — and
that premium is the most you can lose. A long behaves like a call, a short like a put.
[Positions Are Options](./positions-are-options) covers the whole mapping.

| Perpetual futures | EXNIHILO |
|---|---|
| Collateral and margin | Only the open fee |
| Liquidation engine | No liquidations — nothing was borrowed |
| Loss can exceed your deposit | Maximum loss is the fee, known before you open |
| Oracle prices | Prices from the pool's own curves |
| Governance-gated listings | Anyone can create a market in one transaction |
| Account balances | Transferable NFTs |
| Funding that can pay either side | Funding that shrinks your position, paid to the LP |

## What it costs

A $100 position in a pool with $10,000 of USDC costs about **$5.08** — the 5% base fee plus a
small impact fee. If the token doubles you make roughly $100; if it goes to zero you lose the
$5.08 and nothing more. The fee has a 0.05 USDC floor.

These figures are illustrative. A single position is capped at 1% of a pool's USDC on day one,
rising to 20% after 24 hours, and the [app](https://exnihilo.markets/app) shows each pool's live
maximum, fee and break-even.

::: warning Two things to understand before you trade
**Positions decay.** There is no deadline, but [funding](/positions/funding) takes a fraction of
every position every second — steeply on a new market, slowly on a mature one.

**Losing positions cannot be closed.** An underwater position has no salvage value: it either
recovers or decays to nothing.
:::

## How it works

Every pool runs three constant-product curves over two pairs of counters:

| Curve | Reserves | Used for |
|---|---|---|
| **SWAP-1** | `backedAirToken` / `backedAirUsd` | Ordinary swaps |
| **SWAP-2** | `backedAirToken` / `airUsdSupply` | Opening longs, closing shorts |
| **SWAP-3** | `airTokenSupply` / `backedAirUsd` | Opening shorts, closing longs |

The **backed** counters track real tokens and USDC. The **supply** counters also include
synthetic units created by open positions. Opening a long mints synthetic airUsd and trades it
through SWAP-2; opening a short mints synthetic airToken and trades it through SWAP-3. Nothing
is borrowed — the exposure comes from moving a curve — which is why there is nothing to
liquidate. See [Pricing & Reserves](/markets/pricing).

## Who is on the other side

Each pool has exactly one liquidity provider, and that LP is the counterparty to every position
in it — in option terms, the writer. They earn most of the open fee and all funding, pay every
profitable close, and are protected by an automatic [position cap](/lp/position-caps). See
[Fee Earnings](/lp/fees).

## Where it runs

Avalanche C-Chain mainnet (chain ID 43114), quoted in Circle's native USDC. Markets are created
by users; there are no official ones. See [Contract Addresses](/protocol/addresses).
