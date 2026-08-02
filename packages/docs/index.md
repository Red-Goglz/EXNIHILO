---
layout: home
hero:
  name: EXNIHILO
  text: Nothing here can liquidate you
  tagline: Long or short any ERC-20 token on Avalanche. You pay a fee, not collateral — and that fee is the most you can ever lose.
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
    details: Price comes from the AMM's own curves. Contracts are immutable and there is no governance to capture. One emergency role can wind a pool down; it cannot move funds.
description: "Documentation for EXNIHILO — go long or short any ERC-20 token on Avalanche with no collateral and no liquidation risk. Start here."
---

## In one line

**EXNIHILO positions are options.** A long is a call, a short is a put, the open fee is
the premium, and the premium is the most you can lose. There is no strike to pick, no
implied volatility, and no margin call.

See [Positions Are Options](/introduction/positions-are-options) — it is the fastest
way to understand the entire protocol.

::: warning Every position expires
Positions run for the pool's `positionDuration` (default 7 days). Renew before the
deadline, opt into auto-renewal, or the position settles. Underwater positions settle
for nothing — you have to be right *within the window*.
:::

<!--
  These links are not decoration. The sidebar that normally reaches the rest of
  the docs is rendered by the theme's Vue components, and on the home layout it
  is collapsed away entirely — so the server HTML for this page previously
  exposed exactly two links into a 31-page tree. Anything arriving here without
  executing JavaScript (most AI retrieval crawlers, every link unfurler) could
  see nothing else. Written as markdown links so they survive in the static
  output.
-->

## Browse the docs

**Start here**
[What is EXNIHILO](/introduction/what-is-exnihilo) ·
[Positions Are Options](/introduction/positions-are-options) ·
[Key Concepts](/introduction/key-concepts) ·
[Glossary](/introduction/glossary)

**Trading**
[Opening a Long](/trading/opening-a-long) ·
[Opening a Short](/trading/opening-a-short) ·
[Closing Positions](/trading/closing-realizing) ·
[Swapping](/trading/swapping) ·
[Fees](/trading/fees) ·
[P&L](/trading/pnl)

**Positions**
[Position NFTs](/positions/position-nfts) ·
[Transferring](/positions/transferring) ·
[On-chain SVG Metadata](/positions/metadata) ·
[Expiry & Renewal](/positions/expiry)

**Providing liquidity**
[LP NFT & Ownership](/lp/ownership) ·
[Adding / Withdrawing](/lp/add-withdraw) ·
[Fee Earnings](/lp/fees) ·
[Position Caps](/lp/position-caps)

**Markets**
[Creating a Market](/markets/creating) ·
[How Pricing Works](/markets/pricing) ·
[Reserve Accounting](/markets/reserves)

**Protocol**
[Architecture](/protocol/architecture) ·
[Contract Addresses](/protocol/addresses) ·
[Fee Structure](/protocol/fees) ·
[Security](/protocol/security)

**Developers**
[Contract Reference](/developers/reference) ·
[ABIs](/developers/abis) ·
[Local Development](/developers/local-dev) ·
[Indexer](/developers/indexer)

**Before you trade**
[Common Questions](/faq/questions) ·
[Risk Disclosure](/faq/risks)
