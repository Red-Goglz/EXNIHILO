---
layout: home
hero:
  name: EXNIHILO
  text: Nothing here can liquidate you
  tagline: Perpetual options on any ERC-20 token on Avalanche. Go long or short for a fee, not collateral — and that fee is the most you can ever lose.
  actions:
    - theme: brand
      text: Get Started
      link: /introduction/what-is-exnihilo
    - theme: alt
      text: Launch App
      link: https://exnihilo.markets/app
features:
  - title: Your loss is capped at the fee
    details: No collateral, no margin, no liquidation engine. You pay a premium to open — roughly 5% of position size — and that premium is your entire downside.
  - title: Nobody lists your token? Now you do.
    details: One transaction creates a leveraged market for any ERC-20. No oracle, no market maker, no listing committee, no governance vote.
  - title: Positions are NFTs
    details: Every position is a transferable ERC-721 with on-chain SVG art and live P&L. Sell the position without closing it.
  - title: No oracles, no token, no upgrade path
    details: Price comes from the AMM's own curves. Contracts are immutable, with no governance and no privileged role. Only a pool's own LP can wind it down.
title: EXNIHILO Docs — perpetual options on any ERC-20, no liquidation
titleTemplate: false
description: "Documentation for EXNIHILO — perpetual options on any ERC-20 token: go long or short with no collateral and no liquidation risk. Start here."
---

## In one line

**EXNIHILO positions are perpetual options.** A long is a call, a short is a put, the open fee is
the premium, and the premium is the most you can lose. There is no strike to pick, no expiry and
no margin call — funding charges for time instead. It trades like a perp and risks like an option.
[Perpetual Options](/introduction/positions-are-options) is the fastest way to understand the
protocol.

::: warning Every position decays
Positions never expire, but [funding](/positions/funding) charges rent by shrinking them —
steeply on a brand-new market, slowly on a mature one. A losing position cannot be closed, so
it has to recover before funding shrinks it away.
:::

<!--
  These links are not decoration. The sidebar that normally reaches the rest of the docs is
  rendered by the theme's Vue components, and on the home layout it is collapsed away
  entirely — so without them the server HTML for this page exposes almost no links into the
  tree. Anything arriving without executing JavaScript (most AI retrieval crawlers, every link
  unfurler) would see nothing else. Written as markdown links so they survive in the static
  output.
-->

## Browse the docs

**Start here**
[What is EXNIHILO](/introduction/what-is-exnihilo) ·
[Perpetual Options](/introduction/positions-are-options) ·
[vs Perpetual Futures](/introduction/vs-perpetuals) ·
[Glossary](/introduction/glossary)

**Trading**
[Opening a Position](/trading/opening) ·
[Closing Positions](/trading/closing-realizing) ·
[Swapping](/trading/swapping) ·
[P&L](/trading/pnl)

**Positions**
[Position NFTs](/positions/position-nfts) ·
[Funding](/positions/funding)

**Providing liquidity**
[Running a Pool](/lp/ownership) ·
[Fee Earnings](/lp/fees) ·
[Position Caps](/lp/position-caps)

**Markets**
[Creating a Market](/markets/creating) ·
[Pricing & Reserves](/markets/pricing)

**Protocol**
[Architecture](/protocol/architecture) ·
[Contract Addresses](/protocol/addresses) ·
[Fees](/protocol/fees) ·
[Security](/protocol/security) ·
[Audit Report](/protocol/audit-report)

**Developers**
[SDK](/developers/sdk) ·
[Contract Reference](/developers/reference) ·
[ABIs](/developers/abis) ·
[Local Development](/developers/local-dev) ·
[Indexer](/developers/indexer)

**Before you trade**
[Common Questions](/faq/questions) ·
[Risk Disclosure](/faq/risks)
