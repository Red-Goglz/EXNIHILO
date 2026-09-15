---
description: "Definitions for every EXNIHILO term — airToken and airUsd counters, backed versus synthetic supply, premium, funding, sweeps and position caps."
---

# Glossary

| Term | Definition |
|---|---|
| **airToken / airUsd** | The pool's two internal accounting units. Not deployed tokens: nothing is minted, transferable or holdable. See [Pricing & Reserves](/markets/pricing). |
| **Backed reserves** | `backedAirToken` / `backedAirUsd` — the tokens and USDC the pool holds for the LP. |
| **Claimable balance** | USDC credited to a holder when their position is swept with a residual claim. Withdrawn with `claimPayout(to)`. |
| **Close-price clamp** | A close is priced against the worst of the last 5 block opens wherever that is worse than live, so a holder cannot close at a price they just moved. |
| **Constant-product** | `x * y = k`, used by all three curves. |
| **EXNIHILOFactory** | Creates markets. Permissionless, with no owner; its one role, `deployer`, can wind a pool down. |
| **EXNIHILOPool** | One per market: the curves, swaps, positions, funding and liquidity. Holds all tokens and collateral. |
| **Funding** | Continuous rent on an open position, charged by shrinking it — collateral, debt and notional together. Paid entirely to the LP. See [Funding](/positions/funding). |
| **Funding index** | One number per side, in RAY, describing the decay of the whole book. A position's live size is `atOpen × index / fundingIndexAtOpen`. |
| **Funding window** | The period one funding charge is levied over: one hour at market creation, widening to 30 days. |
| **Impact fee** | The part of the open fee that grows with position size and same-side open interest. Paid to the LP. |
| **LP NFT** | ERC-721 carrying sole control of one pool's liquidity. Transferable. |
| **Open interest** | `longOpenInterest` / `shortOpenInterest` — the live notional on each side. Decays with funding. |
| **pokeFunding** | Write accrued funding into the reserves without trading. Permissionless, never required. |
| **Position cap** | The largest position a pool accepts: 1% of its USDC at creation, 20% after 24 hours. |
| **Position NFT** | ERC-721 recording a position's terms at open. The pool holds the collateral and knows the live size. |
| **Premium** | The open fee — 5% of notional plus the impact fee, minimum 0.05 USDC. Non-refundable, and the most a trader can lose. |
| **Spot price** | `backedAirUsd / backedAirToken`. |
| **Supply counters** | `airTokenSupply` / `airUsdSupply` — the backed reserve plus collateral locked in positions plus synthetic debt. |
| **sweepDust** | Clear a position that has decayed below 0.1% of the collateral it opened with. Anyone may call it; any residual claim is credited to the holder. |
| **SWAP-1 / SWAP-2 / SWAP-3** | The three curves: spot swaps; long opens and short closes; short opens and long closes. |
| **Synthetic mint** | Increasing a supply counter without collateral — how exposure is created at open. |
| **Wind-down** | What `closePool` starts: no new positions, and after 7 days the funding rate doubles every day until every position is closed or swept. |
| **Writer** | The pool's LP, in option terms: the counterparty to every position. |
