# State Invariant Detection — Verified (Opus 5)

**Date:** 2026-07-27
**Method:** infer the mathematical relationships that must hold between state
variables, then find any mutation path that violates one.

```
0 CRITICAL | 0 HIGH | 0 MEDIUM | 0 LOW | 1 IMPROVEMENT (applied this round)
```

## Inferred invariants

| # | Invariant | Enforced |
|---|---|---|
| I1 | `backedAirToken <= airTokenSupply` | explicit, `_assertReserveInvariant` |
| I2 | `backedAirUsd <= airUsdSupply` | explicit, `_assertReserveInvariant` |
| I3 | `underlyingToken.balanceOf(this) >= backedAirToken` | explicit |
| I4 | `underlyingUsdc.balanceOf(this) >= backedAirUsd + totalShortCollateral + lpFeesAccumulated + protocolFeesAccumulated + totalClaimable` | explicit (**strengthened this round**) |
| I5 | `totalClaimable == Σ claimable[addr]` | structural |
| I6 | `totalShortCollateral == Σ lockedAmount` over open shorts | structural (**new**) |
| I7 | `openPositionCount == count of live position NFTs for this pool` | structural |
| I8 | `longOpenInterest == Σ airUsdMinted` over open longs | structural |
| I9 | `shortOpenInterest == Σ usdcIn` over open shorts | structural |

I1–I4 are asserted at 7 call sites: `openLong`, `openShort`, `addLiquidity`,
`_tryAutoRenew`, both swap internals, and `_settle`.

## I4 — the change made this round

Previously I4 omitted `totalShortCollateral`. `openShort` moves real USDC out of
`backedAirUsd` and records it as the position's `lockedAmount`; that USDC remains
in the contract but was not represented on the liability side. The invariant was
therefore a *loose lower bound* — it passed whether or not the short collateral
was still present, and so could not detect a leak of it.

Adding the term makes I4 an exact conservation law. Empirically confirmed:

```
initial        shortCollateral=5,939,101   bal=20,000,300,134  liabilities=20,000,300,134  slack=0
after 3 shorts shortCollateral=14,847,751  bal=20,000,750,841  liabilities=20,000,750,841  slack=0
```

`slack = 0` at every observation. Before the change, slack would have equalled
the entire short collateral.

## I6 — proof of non-desync

A short's `lockedAmount` has exactly three mutation points in `PositionNFT.sol`,
all mirrored in the accumulator:

| Mutation | Site | Accumulator update |
|---|---|---|
| `mintShort` sets `lockedAmount = airUsdOut` | PositionNFT:270 | `+= airUsdOut` (Pool:700) |
| `applyRenewal` sets a new value | PositionNFT:304 | auto-renew short `-= cost` (Pool:1017); manual `renewPosition` passes it unchanged |
| burn on settle | `_settle` | `-= pos.lockedAmount` in both branches (Pool:1377, 1400) |

`mintLong` also writes `lockedAmount`, but for longs it denominates airToken, not
USDC, and is correctly excluded.

## Conservation algebra per settlement branch

Verified that liability change equals cash outflow in every branch.

**Profitable short.** `_priceClose` guarantees `restore + surplus ==
pos.lockedAmount` exactly (`restore = cost`, `surplus = lockedAmount - cost`).
Liabilities move by `+cost (backedAirUsd) − lockedAmount (I6) + closeFee
(protocol fees)`, which reduces to `−(surplus − closeFee)` — precisely the cash
paid out as `bountyPaid + netSurplus`.

**Underwater short.** `+(lockedAmount − bountyPaid) − lockedAmount = −bountyPaid`,
matching the bounty transfer.

**Auto-renew (long).** `backedAirUsd −= cost`, fee accumulators `+= totalFee`,
cash `−KEEPER_BOUNTY`. With `cost = totalFee + KEEPER_BOUNTY`, net liability
change is `−KEEPER_BOUNTY` = cash out.

**Auto-renew (short).** `totalShortCollateral −= cost`, accumulators `+=
totalFee`, cash `−KEEPER_BOUNTY`. Same result.

`airUsdSupply` is deliberately left unchanged in the long auto-renew branch: it
tracks backing *plus* synthetic debt, and `backedAirUsd` falls by `cost` while
debt rises by `cost`. Net zero — the code comment states this and the algebra
confirms it.

## I8/I9 — open-interest coupling

`openLong` does `longOpenInterest += usdcAmount` where `airUsdMinted =
usdcAmount`; `_settle` does `longOpenInterest -= pos.airUsdMinted`. These stay
balanced across renewal because auto-renew increments **both** by `cost`
(`longOpenInterest += cost` alongside `airUsdMinted + cost`).

Shorts touch neither on renewal, matching `shortOpenInterest -= pos.usdcIn` at
settle (`usdcIn` is never mutated by `applyRenewal`).

This coupling matters beyond bookkeeping: OI is an input to the impact fee, so a
desync would mispriced every subsequent open.

## I7 — position count

`++` in `openLong` and `openShort`; a single `--` in `_settle`, which is the sole
exit path for every close (self-close, expiry, keeper settlement). Cannot
desync. This is what makes `removeLiquidity`'s `openPositionCount != 0` guard
trustworthy as trader protection.

## Failure mode on violation

Because there are no `unchecked` blocks, a desync that would drive any
accumulator negative reverts rather than wrapping. Combined with the assert
sites, a hypothetical accounting bug fails closed (operations revert) rather than
open (funds leak). That is the correct direction for a custody contract.

## Empirical

Full suite after strengthening I4: **394 passing, 8 failing** — the same
pre-existing storage-slot `Coverage.ts` failures, **zero
`ReserveInvariantViolated`**, despite I4 now being strictly tighter and asserted
on every state-changing path.
