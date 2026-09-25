---
description: "Closing settles a position against the pool's curves and pays the surplus in USDC. How longs and shorts unwind, the 1% fee on profit, the close-price clamp, and how decayed positions are swept."
---

# Closing Positions

Only the holder can close, at any time — but only in profit. Closing settles the position
against the pool's curves and pays the surplus in USDC.

```solidity
closeLong(nftId, minUsdcOut, to)
closeShort(nftId, minUsdcOut, to)
```

`minUsdcOut` is the floor the payout must clear, and it is the only thing protecting it. `to`
receives the payout — a separate parameter so a holder whose wallet cannot receive USDC (a
blacklisted one, say) can still exit. **Always set `minUsdcOut`**; see
[the clamp only moves one way](#the-clamp-only-moves-one-way) for why zero is not safe.

## What happens

**Long:** the locked airToken is valued through SWAP-3 and returns to the pool's reserves, the
airUsd debt is cancelled, and the surplus is paid out.

**Short:** the airToken debt is bought back through SWAP-2 with the locked airUsd, and what is
left is paid out.

Either way 1% of the profit goes to the protocol and the NFT is burned. The formulas are in
[P&L Calculation](/trading/pnl). Quote a close with `quoteClose(nftId)`, which returns
`(ready, pnl)` net of the close fee.

## Closing right after a price move

A close is priced against the worst of the last 5 block opens wherever that is worse than the
live price, including the open of the block the position was opened in. It stops a holder moving
the price and closing into their own move, even within one transaction. It has two consequences
for an honest holder, and `quoteClose` accounts for both:

- **A close right after a favourable move may pay the earlier price.**
- **A close right after an unfavourable move may be refused.** If the position was underwater at
  any of those block opens, the close reverts `PositionUnderwater` even though the live price
  shows a profit. It clears on its own once the move is more than 5 blocks old — a few seconds.

The refusal can also be caused on purpose: pushing the price down at the end of one block and back
at the start of the next holds a close back for 5 blocks, repeatably. Nothing is taken, but
funding keeps running, and only a position near break-even can be held back cheaply.

`quoteCloseUnclamped(nftId)` returns the same `(ready, pnl)` at live reserves, without the clamp.
When it shows a profit and `quoteClose` does not, the close is being held back rather than losing:
retry shortly. The app labels the button **Retry shortly**.

## The clamp only moves one way

The clamp can lower a payout and never raise one — that is what stops a holder pricing a close
against a move they just made — so it does nothing about a move made *at* you. Someone can sell
into the pool just before your long closes, or buy just before your short does, and the close
settles at that price.

`minUsdcOut` is the answer: with a sensible floor the close reverts `InsufficientOutput` instead,
and the position stays closeable once the move ages out. A close with `minUsdcOut = 0` takes
whatever price it is handed. A move sustained long enough to push the position underwater holds
the exit shut for as long as it lasts, while funding keeps running; no floor fixes that.

## Underwater positions

A position below break-even cannot be closed and is never liquidated. It stays open, shrinking
with funding, and is yours again if the price recovers.

## Dust sweeps

Once funding has taken all but **0.1%** of the collateral a position opened with, anyone may call
`sweepDust(nftId)` to clear it so the LP can eventually withdraw. The threshold depends only on
funding, never on price. If the sweep prices the position in profit, the payout is credited to
the holder — withdraw it with `claimPayout(to)` — rather than sent, so nothing about the holder's
wallet can block the sweep. That payout is not guaranteed: a caller can move the price first so
the position prices underwater, and the holder then receives nothing. It is at most the dust that
was left. See [Funding](/positions/funding#sweeping-a-decayed-position).
