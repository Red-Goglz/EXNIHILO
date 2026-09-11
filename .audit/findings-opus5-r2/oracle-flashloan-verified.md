# Oracle & Flash Loan — Verified (Opus 5 R2)

**Date:** 2026-08-20
**Baseline:** `mainnet-launch` @ `c02af1d` + uncommitted working tree (per `SCOPE.md`)
**Scope covered:** every pricing path in `EXNIHILOPool` (spot/long/short marks,
`_priceClose`, `_renewFees`, `_openFees`, `_checkLeverageCap`), the new settlement
guard (`_armSettlementGuard` / `_assertSettlementUnguarded`), the new time-derived
ramps, `PreMarket.sol` + `PreMarketFactory.sol` (pricing + the atomic launch
handoff), and `LockedLpVault.sol` (harvest split).

```
0 CRITICAL | 2 HIGH | 2 MEDIUM | 1 LOW | 2 INFO
```

Every claim below was executed against the working tree in Hardhat. The PoC files
were deleted after the run; reproduction parameters are given inline so the next
round can rebuild them. No contract was modified.

---

## Oracle trust model: still none, and still the right call

`grep -nEi "latestRoundData|AggregatorV3|latestAnswer|oracle|TWAP|observe\(|consult\(|slot0|getReserves|sqrtPrice"` over
`packages/blockchain/contracts/*.sol` returns four hits, all of them prose in
`PreMarket.sol` (:29, :90, :97, :98) asserting the absence of an oracle. There is
no external price source anywhere in the system, so there is no stale-price risk,
no round-completeness risk, no L2-sequencer risk, and no oracle-failure mode.

`balanceOf` appears 14 times and **never** feeds a price. In the pool it is used
only for exact-transfer verification (`_transferIn`, :1845–1847) and as a *lower*
bound in the solvency assertion (`_assertReserveInvariant`, :1906, :1914). Reserves
are storage counters, not balances, so the classic donation/share-inflation attack
has no surface: sending USDC or tokens to a pool or to a `PreMarket` changes no
price and only loosens the invariant. The same holds for `PreMarket.tokenReserve` /
`quoteReserve` (:220–221), which are counters rather than balances.

The whole oracle-manipulation class therefore collapses into **AMM
self-manipulation** — and that is where this round's findings are.

---

## OFL-R2-001 — HIGH — `openLong` / `openShort` move the guarded state without arming the guard

**Location:** `EXNIHILOPool.sol:1437–1441` (`_armSettlementGuard`), called only at
`:1482` and `:1515` (the two swap helpers). Reserve mutations that evade it:
`:656` + `:660` (`openLong`), `:784` + `:788` (`openShort`). Guard consumers:
`:1058` (`settleExpired`), `:1176` (`closePositionAfterDeadline`).
Design note asserting this is safe: `:386–394`. Test asserting it as intended:
`test/AutoRenew.ts:871`.

### The mismatch

`_priceClose` values an expired position from exactly two state variables per side
(`:1562–1572`, `:1577–1589`):

| victim | reads |
|---|---|
| long  | `airTokenSupply`, `backedAirUsd` |
| short | `airUsdSupply`, `backedAirToken` |

`openShort` writes **both** of the long's inputs, in the adverse direction, at
`:784` (`airTokenSupply += airTokenMinted`) and `:788` (`backedAirUsd -= airUsdOut`).
`openLong` writes **both** of the short's inputs, adversely, at `:656`
(`airUsdSupply += usdcAmount`) and `:660` (`backedAirToken -= airTokenOut`).

Neither arms the guard. Worse, `openShort` is the *more efficient* lever per USDC
than the swap the guard does gate: `airTokenMinted = usdcNotional * airTokenSupply /
backedAirUsd` (`:767`) raises `airTokenSupply` by the full fraction `N/backedAirUsd`,
whereas a token→USDC swap of the same USDC size raises it only by
`N/backedAirUsd × (backedAirToken/airTokenSupply)` — strictly less whenever any
position is open.

And the size ceilings differ by 20×. The guard arms a swap at `SETTLE_GUARD_BPS`
= 1 % of `backedAirUsd` (`:278`, `:1438`), while `_checkLeverageCap` (`:1828–1831`)
permits an open of `CAP_MAX_BPS` = 20 % (`:209`) once the market is 24 h old.

The design note at `:386–394` argues opens are not viable because they "pay a 5 %
fee of which the 1 % protocol share is a real loss even to the LP." That is a cost
argument, and the cost is 1 % of the manipulation notional while the gain is a
double-digit percentage of the victim's mark.

### Verified exploit

Pool: 100,000 USDC / 100,000 TKN, aged past the cap ramp. Victim opens a long at
the cap (20,000 USDC notional), no auto-renew. Genuine third-party demand (an
80,000 USDC swap) triples the price. Position expires.

```
victim surplus (honest)        : $26,016.44
guard arms a SWAP at           : $1,800.00
an OPEN of $36,000 is unguarded: 20x the arming size

LP calls openShort($36,000)     → lastLargeSwapBlock UNCHANGED,
                                  settlementGuardedUntilBlock() == 0
LP calls closePositionAfterDeadline(victim, 0)

honest credit to holder        : $25,756.27
manipulated credit to holder   : $11,936.13
HOLDER LOSS                    : $13,820.14

LP fee outlay $2,340.00 → $1,980.00 returns to it as lpFeesAccumulated
LP irrecoverable cost          : $480.57 (conservative; the marginal figure is
                                  ~$220, because suppressing the surplus also
                                  shrinks the 1 % close fee the protocol takes)
```

**~29× return on the irrecoverable cost, in one transaction, with the guard never
armed.** The $13,820 does not vanish — it stays in `backedAirUsd`, which the LP
NFT holder owns.

The short the attacker opens is not a cost: its `lockedAmount` came out of
`backedAirUsd` (the LP's own capital) and returns there at settlement if it ends
underwater (`_settle`, `:1636`). Settling the victim's long additionally *raises*
`totalBuyable` for shorts (`:1650`/`:1652` raise `backedAirToken` and lower
`airUsdSupply`), so the manipulation position is left better off than it started.

The symmetric direction is confirmed too: an `openLong` of $9,415 against a short
victim cut its `quoteClose` PnL from $9,216.71 to $6,982.85, again without arming
the guard.

### Why I believe it

The non-arming is not inference — `lastLargeSwapBlock` was read before and after
and is byte-identical, and `settlementGuardedUntilBlock()` returns 0. It is also
the contract's *documented intent* (`:386–394`) and is locked in by
`test/AutoRenew.ts:871`. That test uses `openLong` against a **long** victim, which
is the one open direction that genuinely cannot move that victim's mark — neither
`backedAirToken` nor `airUsdSupply` appears in the long branch of `_priceClose`.
The two directions that do move it were never tested.

### Severity

I considered CRITICAL: funds are directly and repeatably stealable by the pool
operator with two calls. I settled on HIGH because the population is bounded to
*expired* positions, the amount is bounded by the victim's surplus rather than by
pool depth, and a non-LP attacker can only grief (the suppressed value lands with
the LP, not with them). A coordinator could reasonably read this as CRITICAL.

### Fix sketch (not applied)

Arm the guard from `openLong` and `openShort` on the USDC notional, against
pre-mutation `backedAirUsd` — the same measure `_armSettlementGuard` already takes.
That alone does not close OFL-R2-002.

---

## OFL-R2-002 — HIGH — the guard is a per-call size test with no per-block accumulation

**Location:** `EXNIHILOPool.sol:1437–1441`. The threshold is evaluated against
`backedAirUsd` *as of that call*, and nothing accumulates across calls in a block.
Margin it is paired with: `:1101` (`RENEW_MARGIN_BPS`, `:279`).

### The gap

`_armSettlementGuard(usdcValue)` tests one trade in isolation. An attacker sizing
each swap at just under 1 % of the *current* `backedAirUsd` can repeat
indefinitely; the threshold shrinks with the reserve, so the sequence never arms.
Nothing forces the swaps into separate blocks, and nothing needs to: a guard that
is never armed imposes no window at all.

The reasoning block at `:254–277` derives the pairing correctly for **one** swap —
a move of fraction `f` of depth swings the mark by ≈ `f`, so capping `f` at 1 % and
requiring 2 % of mark as margin makes a single sub-threshold swap harmless. That
derivation is sound and `test/AutoRenew.ts:774` verifies it. It simply does
not extend to `k` swaps, where the swing compounds as `((1-f)/(1+f·r))^k`.

Critically, the same docstring (`:240–243`) already names the LP as "the only party
that profits from either outcome" and observes that a swap round trip "is very
nearly free" for them — because the fee is retained by *not* reducing the output
reserve (`:1487–1489`, `:1519–1522`), so it lands in the LP's own `backedAirUsd`.
The mitigation chosen does not address that actor.

### Verified exploit

Pool: 10,000 USDC / 1,000,000 TKN. Victim: 100 USDC long, **auto-renew enabled**,
`maxFee = MaxUint256`, price pumped, expired, verified renewable.

```
surplus before : $39.10   margin (2 % of mark): $2.78
14 sub-threshold token→USDC swaps, each sized under settlementGuardArmingSize()
  lastLargeSwapBlock UNCHANGED after every single one
  settlementGuardedUntilBlock() == 0
surplus after  : $5.55   → verdict flipped to NOT renewable
holder credited: $5.49   (vs $38.71 unmanipulated)  — 86 % suppressed
```

Combined with OFL-R2-001 on the $100k pool from that finding — one `openShort` at
the cap followed by 24 sub-threshold swaps, guard never armed at any point:

```
surplus $26,016.44 → holder credited $1,676.75      — 93.5 % suppressed
```

The holder had explicitly opted into auto-renewal. Their opt-in was overridden and
their payout was near-destroyed, by an actor who paid essentially nothing: for the
LP the swap fees land back in `backedAirUsd`, and the round trip on a
constant-product curve returns to its starting point.

### Why I believe it

`lastLargeSwapBlock` was asserted unchanged after each individual swap inside the
loop, not merely at the end. `settlementGuardedUntilBlock()` returned 0 at the
moment of settlement. The settle call then succeeded.

### Fix sketch (not applied)

Accumulate per block — e.g. track `(block.number, cumulativeUsdcMoved)` and arm
when the running total for the current block crosses `SETTLE_GUARD_BPS`, resetting
on a new block. A cumulative measure also closes the openLong/openShort route from
OFL-R2-001 if those paths feed the same accumulator, which makes it the better
single fix.

---

## OFL-R2-003 — MEDIUM — the 5-block window is a settlement-denial lever, and it blocks the LP's exit

**Location:** `EXNIHILOPool.sol:1452–1458` (`_assertSettlementUnguarded`), `:282`
(`SETTLE_GUARD_BLOCKS`), `:897` (`removeLiquidity` requires `openPositionCount == 0`).

A guard that blocks third-party settlement for 5 blocks is also a guard anyone can
*arm on purpose*. Arming is permissionless — `swap` (`:574`) has no access control
— and the exemption at `:1453` is for the position **holder**, not for the LP. The
LP is exactly the party that needs third-party settlement, because an expired
*underwater* position gives its holder zero reason to settle it, and
`removeLiquidity` reverts while it is open.

The incentive is real: an expired underwater position is a free option for its
holder. Every block it stays unsettled is another block it might recover. The guard
hands the holder a cheap way to buy that time. Note also that `KEEPER_BOUNTY` was
removed this round (SCOPE item 6), so nobody is paid to race the blocker.

### Verified

Cost of total settlement denial, $180k pool, arming with a USDC→token swap and
immediately reversing it so the pair ends where it started:

```
5 round trips blocked 5 windows (25 blocks ≈ 50 s on Avalanche)
net USDC cost: $180.95     → $7.24 per block, ~$36 per 5-block window
both settleExpired() and closePositionAfterDeadline() reverted
  SettlementGuardActive in every window, for both the LP and a third party
```

And the severe composition — after `closePool()`, which is irreversible (`:502`):

```
pool closed, position expired, holder arms the guard
  closePositionAfterDeadline → SettlementGuardActive
  removeLiquidity            → OpenPositionsExist
  openPositionCount = 1
```

The LP has committed to winding down, can no longer earn open fees (`openLong` /
`openShort` revert on `closeDate != 0`, `:624`/`:749`), and cannot exit.

### Honest bounds

Sustained denial is expensive — extrapolating $7.24/block to an hour of Avalanche
blocks is roughly 7 % of pool depth, and the fee is paid *to* the LP. The realistic
shape is therefore targeted: mempool-front-run a specific settlement attempt for
~$36, rather than a permanent siege. That is still a new capability the guard
created — before it, `closePositionAfterDeadline` was always reachable — and the
`closePool` composition converts "LP earns fees while waiting" into "LP is simply
stuck". MEDIUM: griefing with real cost to the griefer and bounded damage, but a
new and durable DoS on the LP's exit.

---

## OFL-R2-004 — MEDIUM — `PreMarket`'s "one-way commitment" is not enforced, and `MIN_BUYOUT_USDC` makes the drained state permanent

**Location:** `PreMarket.sol:416–452` (`swap`), `:480–546` (`buyout`), `:156`
(`MIN_BUYOUT_USDC`), `:73–79` (the guarantee as written),
`PreMarketFactory.sol:111–113` (the same claim).

The Dutch price itself is clean: `currentPrice()` (`:354–358`) is a pure function of
`startPrice`, `decayBpsPerMinute` and elapsed time. It reads no reserve and cannot
be manipulated by trading. The launch handoff is also *mostly* price-continuous, as
`:92–99` argues correctly — the real market inherits `tokenReserve` against
`quoteReserve × price`, so the composite curve is the premarket curve scaled by
`price`, and a manipulate-then-extract round trip walks the same curve twice paying
1 % on the premarket leg (`:401`) and 1 % of spot value on the pool leg
(`EXNIHILOPool.sol:1718–1722`). I could not construct a profitable atomic round
trip across the boundary, and I believe none exists while that scaling holds.

**`MIN_BUYOUT_USDC` is where the scaling breaks**, and `swap` is what gets you
there. The header states the seed "cannot be pulled back out, by anyone, ever."
`swap` is a full exit for the quote leg: push token in, take quote out, no size cap,
no deadline, permissionless.

### Verified

Seed: 1,000,000 PROJ / 100 WAVAX, `startPrice` $40/WAVAX. Honest buyout: $4,000.
Attacker holds a large low-basis PROJ bag (for a launchpad token, that is the team)
and dumps 1,000,000,000 PROJ:

```
after dump : 1,001,000,000 PROJ / 0.1009 WAVAX
attacker extracted 99.899 of the 100 WAVAX seeded  — 99.9 % of the "locked" leg
buyout cost now: $4.03 (was $4,000)

launched market: backedAirUsd = $4.03, backedAirToken = 1,001,000,000 PROJ
pool.spotPrice() returns 0
LP NFT permanently locked in a LockedLpVault, backing a $4 market
```

The market is dead on arrival: `effectiveLeverageCap()` is 1 % of $4.03 ≈ $0.04,
below the `MIN_POSITION_FEE` of $0.05 (`EXNIHILOPool.sol:173`), so no position can
ever be opened. And it is irreversible — `launched` is one-way (`:501`), the vault
has no withdrawal path by construction, and `PreMarket` has no refund or expiry.

### Why this is a finding and not "an AMM has a price"

Dumping into a constant-product pool is expected behaviour, and a rational
third party would not do this — the realized average price is ~1000× below spot.
The exploitable party is specifically the token issuer, whose basis is zero. Two
things elevate it past normal AMM risk:

1. The contract tells launchpads in its own header that this is impossible. A
   launchpad bonding real AVAX on the strength of `:73–79` is relying on a
   guarantee the bytecode does not provide.
2. `MIN_BUYOUT_USDC` (`:156`) exists to guarantee the launch always completes. It
   does — including from a fully-drained state, cementing the outcome into a
   permanently-locked LP over a worthless market. The reasoning at `:151–155`
   ("far below what any honestly-seeded reserve is worth, so it can only ever bind
   on an auction nobody took") treats `quoteReserve` as fixed; `buyout`'s own
   `maxUsdc` docstring (`:472–475`) already acknowledges it is not.

MEDIUM rather than HIGH: the value at risk is a third party's bonded quote asset,
but capture requires the attacker and the token issuer to be the same party, which
is a trust assumption a launchpad arguably already makes.

---

## OFL-R2-005 — LOW — `settlementGuardArmingSize()` understates the real threshold

**Location:** `EXNIHILOPool.sol:1211–1213` vs `:1438`; comment claiming exactness
at `:1433–1435`.

The view floors: `(backedAirUsd * SETTLE_GUARD_BPS) / BPS_DENOM`. The check does
not: `usdcValue * BPS_DENOM >= backedAirUsd * SETTLE_GUARD_BPS`. When
`backedAirUsd * 100` is not divisible by 10,000 the advertised figure is below the
true threshold, and a swap at exactly that size does not arm.

Verified with `backedAirUsd = 101,234,567,891`: advertised 1,012,345,678, remainder
9,100, swap at exactly the advertised size did **not** arm.

Damage is bounded at one USDC atom (1e-6 USDC), so this is a docs/UX defect, not an
evasion route — OFL-R2-002 already provides unbounded evasion. It matters only
because `:1206–1210` directs keepers and frontends to trust this number, and
`:1433–1435` explicitly claims the pre-swap denominator "makes
`settlementGuardArmingSize()` exact". Ceil-divide the view, or document the ±1.

---

## OFL-R2-006 — INFO — `LockedLpVault` documents the pre-reweight fee split

**Location:** `LockedLpVault.sol:40` and `:65` say the LP stream is "3 % of
notional". `LP_FEE_BPS` is 400 (`EXNIHILOPool.sol:169`) after this round's reweight
(SCOPE item 1). `PreMarket.sol:134–135` has the correct 4 %, so the two new
contracts contradict each other. No behavioural impact — the vault reads the actual
amount, never a bps constant.

---

## OFL-R2-007 — INFO — the one time-derived value a validator can profitably nudge

Answering SCOPE question 5. Every `block.timestamp` / `block.number` use was
enumerated (14 in the pool, 2 in `PositionNFT`, 2 in `PreMarket`, 2 in `Faucet`):

- **`currentMaxPositionBps()`** (`:1290–1295`) — linear over 24 h. A ±15 s nudge
  moves the cap by `15/86400 × 1900` bps ≈ 0.33 bps of `backedAirUsd`. Negligible.
- **`currentPositionDuration()`** (`:1310–1317`) — stepped, so a nudge matters only
  within seconds of an exact step boundary (1 h / 8 h / 24 h / 7 d), where it grants
  a longer lifetime. No profit: anyone can simply wait, there is no scarce resource
  being raced for, and the function stays non-decreasing, which `closePool` relies
  on (`:224–227`).
- **`pos.deadline` comparisons** (`:1053`, `:1173`) — a nudge settles ~15 s early.
  The guard is `block.number`-based (`:1439`, `:1455`) and therefore unaffected.
- **`lastLargeSwapBlock`** — `block.number` is not nudgeable.
- **`PreMarket.currentPrice()`** (`:354–358`) — the one directly monetizable case.
  A validator buying out the reserve can nudge the timestamp forward for a discount
  of `decayBpsPerMinute × nudge / 60`; at the intended 200 bps/min and a 15 s nudge
  that is 0.5 % of `startPrice`. Bounded and small, but it is a real edge and it is
  the only place in the system where a timestamp nudge converts directly to money.

Nothing here rises above INFO.

---

## Carried findings from `.audit/findings-opus5/`

### OFL-1 / OFL-2 (flash-loan manipulation around open/close) — re-derived, **still accepted**

Re-derived against the current constants rather than carried forward, as SCOPE
required.

**For a third party the economics are unchanged.** `LP_FEE_BPS` 300→400 and
`PROTOCOL_FEE_BPS` 200→100 leave the total open fee at **500 bps exactly as
before** — the trader pays the same 5 %. `swapFeeBps` is now a constant 100
(`:196`) where it was previously per-pool floored at 100 and, per the docstring,
every pool took the floor — so no change there either. `IMPACT_FEE_BPS` (1500),
`CLOSE_FEE_BPS` (100) and the `_cpAmountOut` fee model are untouched.

`test/ManipulationSafety.ts` was re-run on this working tree and still passes the
full grid (8 pool configurations × 8 notional fractions × 7 move multipliers, both
sides):

```
✅ long side:  no drain across the full grid (impact fee holds)
✅ short side: no drain across the full grid (impact fee holds)
```

**For an LP-attacker the cost halved.** The recycled share of the open fee rose
from 3/5 to 4/5, so an LP's net cost of opening a manipulation position fell from
2 % to 1 % of notional. And the impact fee — the quantity the previous round leaned
on as the "economic cap" — has always routed 100 % to the LP (`:1820`), so it
provides *zero* deterrence to an LP-attacker under either split. This is the
mechanism behind OFL-R2-001; the fee reweight did not create it but made it 2×
cheaper.

The `ManipulationSafety.ts` suite cannot see this: `deployPool` gives the LP NFT to
`creator` and the attacker is always a separate signer, so the LP-as-attacker case
is not in the grid. Nor is the multi-swap manipulation (the sweep uses exactly one
`swap` per run), nor manipulation of a *third party's* expired position (every run
opens and closes the attacker's own position). Those three gaps are precisely where
OFL-R2-001 and -002 live.

### NM-003 (no keeper incentive) — closure void, and now worse

SCOPE item 6 notes `KEEPER_BOUNTY` was removed, voiding the prior closure. From
this pass's angle it compounds OFL-R2-003: settlement is now both **unpaid** and
**blockable**, and the party who most needs it (the LP, to reach
`removeLiquidity`) is the one the guard's holder-exemption does not cover.

---

## Checked and found clean

- **No external oracle, anywhere.** No feed, no TWAP, no staleness surface, no
  circular dependency on a third-party pool. The self-referential mark is the right
  design: the pool is the sole venue for its own synthetic asset.
- **No donation / share-inflation surface.** Reserves are storage counters
  (`EXNIHILOPool` `:318`–`:328`, `PreMarket` `:220`–`:221`), never `balanceOf`.
  A direct transfer to any of these contracts changes no price. `_assertReserveInvariant`
  uses `balanceOf` only as a lower bound (`:1906`, `:1914`), so a donation can only
  loosen it, never fake solvency into a payout.
- **`addLiquidity` is genuinely safe as a manipulation lever**, as `:387–390`
  claims. Proved algebraically both ways: a ratio-matched deposit scales a long's
  priced value by `(1 + Δu/B_u)/(1 + Δt/S_t) ≥ 1` (since `B_t ≤ S_t`) and a short's
  `totalBuyable` by `(1 + Δt/B_t)/(1 + Δu/A_u) ≥ 1` (since `B_u ≤ A_u`). It can only
  *raise* a position's surplus, in both directions. It is also `onlyLpHolder` and
  costs locked capital.
- **`removeLiquidity` cannot be used as a manipulation lever** — it reverts while
  any position is open (`:897`).
- **Settlement does not arm the guard**, so a keeper can batch expiries
  (`test/AutoRenew.ts:857`). Verified as intended and desirable.
- **The holder exemption cannot trap anyone.** `:1453` lets the holder always act on
  their own position, and `renewPosition` (`:994`) is unguarded and holder-only, so
  an armed guard never strands a holder.
- **`LockedLpVault` harvest split is not gameable.** `_harvest` (`:212–233`) reads
  no price, no reserve, and no pool state other than `lpFeesAccumulated`; it splits
  by the **immutable** `integratorBps` (`:102`). Verified: manipulating the pool with
  a 50,000 USDC swap in the same window changed neither accrual; a $100 direct
  donation split by the same fixed ratio; `pending()` matched the executed harvest
  exactly. The only timing lever anyone has is *when* to harvest, and since the ratio
  is fixed, timing shifts nothing between the parties. Clean.
- **The premarket→market handoff is price-continuous except at the floor.** The
  buyout scales the premarket curve by the auction price, so a
  manipulate-buyout-extract round trip pays the premarket's 1 % and the pool's 1 %
  of spot value and is strictly lossy. I attempted the flash-loan version (inflate
  `quoteReserve` with borrowed quote, buy out, dump the extracted tokens into the
  fresh market) and it loses on both legs; the fresh pool's spot-value fee model
  additionally makes dumping into a near-empty token reserve revert via the
  `rawOut <= fee` guard (`EXNIHILOPool.sol:1724`). `MIN_BUYOUT_USDC` is the sole
  discontinuity — see OFL-R2-004.
- **A fresh market cannot be looted in the buyout transaction.** `createdAt` is set
  in the pool constructor (`:552`), so a market launched by `buyout` starts at
  `CAP_START_BPS` = 1 % and `DURATION_AGE_1` = 1 hour. There is also no pre-existing
  LP whose capital could be taken — the opening reserves are the buyer's own USDC
  and the premarket's tokens.
- **`spotPrice() == 0` on an extremely thin pool is handled downstream.**
  `packages/site/src/pages/PoolPage.tsx:142` and `:160` both gate on
  `spotPriceRaw > 0n`, so it renders as unavailable rather than dividing by zero.
  No contract divides by any of the three price views — they are display-only.

## Notes for the other passes

- **Business-logic / semantic-guard pass:** the guard-coverage asymmetry in
  OFL-R2-001 is a textbook consistency violation — two expiry entry points call
  `_assertSettlementUnguarded`, and the arming side covers only 2 of the 4 functions
  that write the state being guarded. Worth confirming from the guard-consistency
  angle independently.
- **DoS/griefing pass:** OFL-R2-003 is yours as much as mine; the
  `closePool` + permanent-arming composition (LP cannot reach `removeLiquidity`) is
  the part I would want a second opinion on.
- **Anyone testing `PreMarket`:** `test/PreMarket.ts` covers construction,
  validation and decay thoroughly but has no adversarial trading scenario. The
  quote-leg drain in OFL-R2-004 is not represented.
