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
