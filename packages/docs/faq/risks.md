---
description: "What can go wrong: smart contract risk, the absence of a human audit, funding decay, market wind-downs, LP counterparty exposure and thin liquidity. Read before trading."
---

# Risk Disclosure

::: danger
EXNIHILO is experimental software. Only use funds you can afford to lose.
:::

## Smart contract risk

**No human security firm has audited the protocol.** Five AI audit rounds have been published; the
latest (2026-08-20) found critical issues, and the continuous-funding model the contracts now use was
built after it and has not been audited. The code uses reentrancy guards, exact reserve invariants
and a 630-test suite, but undiscovered vulnerabilities may exist, and nothing can be patched once
deployed. See [Security](/protocol/security).

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
- **Markets can be wound down.** If the LP or the factory's emergency role closes a pool, no new
  positions open, and after 7 days funding doubles daily — a position you do not close decays away
  within about eleven more days.
- **Settlement runs through the pool's curves.** Large positions in small pools lose a lot to
  slippage, and a close right after a sharp favourable move may be priced at the earlier price.
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
