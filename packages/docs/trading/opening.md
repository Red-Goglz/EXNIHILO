---
description: "Open a long (a perpetual call) or a short (a perpetual put): pay the premium, post no collateral, and lose no more than you paid. What it costs, what happens on-chain, and the limits that apply."
---

# Opening a Position

A **long** profits when the token rises against USDC — in option terms, a perpetual call. A
**short** profits when it falls — a perpetual put. Either way you pay a premium (the open fee), post no collateral,
and cannot lose more than that premium. For a short this matters most: a squeeze that would wreck
a margin short cannot cost you more than you paid.

## What it costs

| | |
|---|---|
| Notional | $100 |
| Base fee (5%) — 4% to the LP, 1% to the protocol | $5.00 |
| Impact fee (in a $10k pool) — to the LP | $0.08 |
| **Premium — your entire downside** | **$5.08** |

The fee has a 0.05 USDC floor, and the impact fee grows with size and same-side open interest —
see [Fees](/protocol/fees). Quote the exact fee with `quoteOpenFee(notional, isLong)`.

## What happens on-chain

**Long** — `openLong(usdcAmount, minAirTokenOut, recipient)`

1. The fee is pulled from you in USDC. The notional is not: it is minted as synthetic airUsd.
2. That airUsd buys airToken through SWAP-2.
3. The airToken is locked in the pool against your position; the airUsd stays in `airUsdSupply`
   as the position's debt.
4. A Position NFT is minted to `recipient`.

**Short** — `openShort(usdcNotional, minAirUsdOut, recipient)`

1. The fee is pulled from you in USDC.
2. Synthetic airToken worth the notional at the pool's rate is minted — the position's debt.
3. It is sold through SWAP-3, and the airUsd it returns is locked in the pool against your
   position.
4. A Position NFT is minted to `recipient`.

The collateral never leaves the pool; the NFT is the record. See
[Position NFTs](/positions/position-nfts). Most users open through `EXNIHILORouter`, which needs
one USDC approval for every pool.

## Limits

- **Slippage** — `minAirTokenOut` / `minAirUsdOut` revert the open if the curve gives less.
- **Position cap** — at most 1% of the pool's USDC on day one, rising to 20% after 24 hours.
  Above it the open reverts `LeverageCapExceeded`; read the live maximum with
  `effectiveLeverageCap()`. See [Position Caps](/lp/position-caps).
- **Closing markets** — once a pool is winding down, opens revert `PoolClosing`.

## After you open

The position pays [funding](/positions/funding) from the first second: collateral and debt
shrink together, so your break-even stays put while the size behind it falls. Close in profit
whenever you like — see [Closing Positions](/trading/closing-realizing).
