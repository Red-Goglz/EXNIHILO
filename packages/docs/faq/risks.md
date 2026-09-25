---
description: "What can go wrong: smart contract risk, the absence of a human audit, funding decay, market wind-downs, LP counterparty exposure and thin liquidity. Read before trading."
---

# Risk Disclosure

::: danger
EXNIHILO is experimental software. Only use funds you can afford to lose.
:::

## Smart contract risk

**No human security firm has audited the protocol.** Five AI audit rounds have been published; the
latest (2026-08-20) found critical issues. Continuous funding came after it and has had one
single-pass review (R3), whose High is fixed; the fixes made since are unaudited. The code uses reentrancy guards, exact
reserve invariants and a 673-test suite, but undiscovered vulnerabilities may exist, and nothing can
be patched once deployed. See [Security](/protocol/security).

## As a trader

- **Your maximum loss is the premium** — a hard bound in the contract.
- **A losing position cannot be closed.** It has no salvage value: it recovers or decays to nothing.
- **Positions shrink while you hold them.** Funding takes a fraction every second:

  | Opened on | Size left |
  |---|---|
  | A market in its first hour | ~77% after one day |
  | A 1-day-old market | ~93% after one day, ~71% after a month |
  | A mature market | ~90% after a month (about 0.34% a day) |

  A crowded side pays several times more. A position held through a long flat stretch can lose most
  of its size without the price ever moving against you. Check `remainingSizeBps(nftId)`.
- **Markets can be wound down.** If the pool's LP closes it, no new positions open, and after 7
  days funding doubles daily — a position you do not close decays away within about eleven more
  days. Nobody but that LP can do this.
- **Settlement runs through the pool's curves.** Large positions in small pools lose a lot to
  slippage, and a close right after a sharp favourable move may be priced at the earlier price.
- **Always set `minUsdcOut` on a close.** The close-price clamp only ever lowers a payout, so it
  does nothing about someone moving the price against you in the block before yours lands. A floor
  turns that into a failed transaction; without one the close takes whatever price it is handed.
- **A close can be held back for a few seconds.** A close is priced against the worst of the last
  5 block opens, so after a sharp dip — or someone pushing the price down at a block boundary — a
  position in profit can refuse to close until the dip ages out. Retry shortly. Someone repeating
  the push can keep a position near break-even from closing for as long as they keep it up.
- There are no stop-losses.

## As an LP

Your risk is much larger. You are the counterparty to every position in your pool, and your maximum
loss is your whole deposit. The position cap and impact fee bound it but do not remove it. See
[Fee Earnings](/lp/fees#you-are-the-counterparty).

## Market risk

Pool prices come from the pool's own reserves, not oracles, and can diverge sharply from other
venues, especially in thin pools.

## Regulatory

DeFi may be regulated where you live, and complying is your responsibility. The protocol guarantees
no profit, liquidity or availability.
