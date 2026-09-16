---
description: "Each pool has exactly one LP, identified by a transferable LP NFT. What the holder can do — add and withdraw liquidity, claim fees, close a market — and what nobody can change."
---

# Running a Pool

Each pool has exactly one liquidity provider: whoever holds its **LP NFT**. The NFT is minted to
the market creator along with the initial liquidity, and transferring it transfers every LP right
at once — to sell a pool, move it to a multisig, or build on top of it.

## What the LP can do

| Action | Call | Notes |
|---|---|---|
| Add liquidity | `addLiquidity(tokenAmount, usdcAmount)` | Must match the current reserve ratio (±0.01%), so the price does not move. Approve both tokens first |
| Withdraw | `removeLiquidity()` | Everything, and only when no position is open |
| Claim fees | `claimFees(to)` | The 4% open fee and impact fees — see [Fee Earnings](/lp/fees) |
| Close the market | `closePool()` | Irreversible — see below |

Only the NFT's direct owner passes the check; approved operators do not. Nothing else about a pool
is configurable: the swap fee, position cap and funding rate are contract constants.

## Closing a market

`closePool()` stops new positions immediately and starts a wind-down: after a 7-day grace period
the funding rate doubles every day. Trading and closes continue and nothing is force-closed, but
positions nobody closes decay into sweep range within about eleven days of the grace period
ending. Once every position is closed or swept, `removeLiquidity()` works.

The factory's emergency `deployer` role can also close any pool. Announce a closure before calling
it — holders need the grace period to exit.

## Why one LP

No pro-rata share accounting, one clear owner, and pool rights that are a single tradeable asset.
The cost is that the LP carries the pool's whole counterparty risk — read
[You are the counterparty](/lp/fees#you-are-the-counterparty) before depositing.
