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

`minUsdcOut` protects the payout from slippage. `to` receives it — a separate parameter so a
holder whose wallet cannot receive USDC (a blacklisted one, say) can still exit.

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
live price. It stops a holder pumping the price and closing into their own move. It has two
consequences for an honest holder, and `quoteClose` accounts for both:

- **A close right after a favourable move may pay the earlier price.**
- **A close right after an unfavourable move may be refused.** If the position was underwater at
  any of those block opens, the close reverts `PositionUnderwater` even though the live price
  shows a profit. It clears on its own once the move is more than 5 blocks old — a few seconds.

The second can also be caused on purpose: anyone who pushes the price down at the end of one block
and back at the start of the next holds a close back for 5 blocks, and can repeat it. Nothing is
taken — the holder keeps the position and can close once the pushing stops — but funding keeps
running meanwhile, and only a position close to break-even can be held back cheaply.

`quoteCloseUnclamped(nftId)` returns the same `(ready, pnl)` at live reserves, without the clamp.
When it shows a profit and `quoteClose` does not, the close is being held back rather than losing:
retry shortly. The app does this for you and labels the button **Retry shortly**.

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
