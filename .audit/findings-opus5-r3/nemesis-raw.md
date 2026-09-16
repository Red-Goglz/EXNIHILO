# Nemesis R3 — raw working notes (2026-09-15)

Tree: HEAD `609723f` + uncommitted comment-only compaction (verified: every non-comment
diff line is a comment or whitespace). Delta since the last committed pre-funding tree
`1964520`: EXNIHILOPool 1914 lines, PositionNFT 178, Router 2, LockedLpVault 5.
PreMarket / PreMarketFactory / Factory post-R2 fixes (C-2 price floor, M-1) were
committed in `1964520` and never audited.

## Phase 0 — recon

Attack goals
1. Trader extracts more than the curve supports (drain backed reserves).
2. Anyone (LP) shrinks or zeroes a holder's claim: price manipulation at close, or
   funding charged that should not be.
3. Holder evades funding.
4. LP principal locked: openPositionCount never reaching 0 (unsweepable positions).
5. Aggregate/position desync -> close underflow -> holder cannot exit.

Novel code: funding index + closed-form decay (`_decayFactor`), Simpson integration
(`_weightedElapsed`), clock carry on zero release, price ring clamp, `sweepDust`,
`_flushResidue`, wind-down doubling.

## Phase 1 — structural identities (verified by walking every mutator)

  airTokenSupply == backedAirToken + totalLongCollateral + totalShortDebt
  airUsdSupply   == backedAirUsd  + totalShortCollateral + longOpenInterest

Every mutator (open x2, swap x2, add/remove liquidity, _accrueFunding both sides,
_settle profit/underwater both sides, _flushResidue) moves both sides of these by the
same amount. So `backed <= supply` can never fail on its own; solvency is structural.
Token balance >= backedAirToken + TLC and USDC balance >= backedAirUsd + TSC + fees +
claimable are likewise preserved exactly. Attacks must therefore be about VALUE, not
solvency.

Aggregate >= sum(positions): `_released` rounds kept UP, `_liveAt` rounds DOWN,
index truncates DOWN -> positions always decay at least as fast as aggregates. Holds.
Consequence: when a side's last position closes, a residue of >= 1 unit normally
remains in TLC / TSC / longOI / TSD / shortOI. `_flushResidue` clears it only when
openPositionCount == 0 (BOTH sides empty).

## Rate state is honest between mutations

Every B/OI mutation runs `_accrueFunding` first (reserveMutation), so OI and
backedAirUsd are constant over [lastFunding, now] -> the memory's "swap depth in,
poke, swap out" concern is a FALSE POSITIVE for single-block manipulation. Holding
inflated depth across blocks is a real price move exposed to arbitrage. EXCEPTION:
when the clock is carried (release rounds to zero), the NEW state's OI is applied to
the OLD interval. -> candidate F-1.

## Candidate F-1 (HIGH?) — frozen funding clock bills the next opener retroactively

`_projectFunding:1057` returns factor RAY when `_released(aggregateCollateral, f)==0`;
`_accrueFunding:1002/1018` then advances the clock ONLY if the aggregate is exactly 0.
With aggregate == 1 unit, `_released(1, f) = 1 - ceil(f) = 0` for every f > 0, so the
clock NEVER advances. Residue of 1 arises organically: single short, one accrual,
close -> ceil(P0*f) - floor(P0*f) = 1. If the other side still has a position,
`_flushResidue` does not run. Next opener on the frozen side is added to the
aggregate; the next accrual charges the WHOLE frozen interval at the newcomer's OI.
Contradicts comment "so idle time is not billed to the next opener".
Attacker variant: openShort(3 units) -> airUsdOut == 1 -> TSC == 1, cost 0.05 USDC.
Also: that dust position is unsweepable (index never moves -> live == atOpen) and
blocks removeLiquidity until wind-down drives f to 0 (~closeDate + 14 d mature).
**CONFIRMED by PoC (`test/AuditR3Poc.ts`):**
- control (empty short book, 30 d gap): victim remainingSizeBps 9999, 1 s billed.
- organic (one short opened+closed while a long stays open): residue
  totalShortCollateral = 1, shortOI = 2; after 30 d of ordinary swaps
  lastFundingShort unchanged; victim 10,000 USDC short -> remainingSizeBps **6590**
  one block after open; **2,981.69 USDC** of its collateral released to the LP;
  **30.0002 days** billed for a position 1 block old.
- attacker (3-unit short, 0.05 USDC fee): TSC = 1, sweepDust -> PositionNotDust after
  30 d; victim -> 6694 bps, 2,971.98 USDC released, 30 d billed.

Long side also confirmed: 18-dec token, residue totalLongCollateral = 2 wei, clock
frozen through 30 d + poke, long victim -> 6843 bps one block after open.

## Pass 2 — State (enriched by Pass 1)

Coupled pairs added from Pass 1's exposed assumption ("aggregate == 0 iff side empty"):

| Pair | Writers | Sync |
|---|---|---|
| lastFundingX <-> (side X has positions) | _accrueFunding (advances only if release>0 or aggregate==0) | GAP: openLong/openShort add to a frozen side without resetting the clock |
| side-X residue <-> side-X empty | _flushResidue gated on GLOBAL openPositionCount | GAP: no per-side count; residue survives while the other side is open |
| fundingIndexX <-> ring snapshot index | _priceRingSnapshot after accrual | synced |
| aggregates <-> sum(live positions) | open/settle/accrue/flush | synced (aggregate >= sum by rounding) |
| airTokenSupply / airUsdSupply identities | all mutators | synced exactly |
| claimable <-> totalClaimable | _creditPayout / claimPayout | synced |

Parallel paths: openLong vs openShort — identical gap on both. Sweep vs voluntary
close — both via _settle; sweep adds an outer _accrueFunding (harmless, second is no-op).

Masking code: `_released` `if (kept > amount) kept = amount` (rounding only, sound);
`_liveAt` `idx >= opened` guard (malformed only, sound); `_flushResidue` — MASKS the
residue that causes F-1, but only when both sides are empty.

## Pass 3 — Feynman on Pass 2 gaps

Q: why does open not reset the clock? A: the carry was added so dust cannot evade
funding; the "forgive idle time" branch keys on aggregate == 0, assuming rounding
leaves no residue. But `_released` deliberately rounds aggregates UP, so residue is
the NORMAL outcome. Two locally sound rounding choices compose into the bug.
Downstream readers of the frozen clock: `_projectFunding` (views + execution agree —
the view drops the victim's size immediately after open, so it is not hidden, only
unannounced before open), `fundingRatePerSecond` (reports a positive rate on a frozen
side), `quoteOpenFee` (unaffected — impact fee uses OI residue ~2 units).
Index -> 0 reachable only in wind-down (opens blocked), so no index-zero desync.

## Pass 4 — State on Pass 3 root cause

Other uses of "aggregate == 0" as "empty": `_projectFunding:1041`, `_accrueFunding:
1002/1018` — both part of F-1. `removeLiquidity` requires global count 0 -> flush has
run -> safe. No further gaps. Converged.

## Other candidates (to verify)

- C2 sweepDust "residual credited, never taken" — false: caller can swap the dust
  position underwater in the same tx (fee returns to LP) or use a snapshot in the
  clamp window -> underwater path -> holder gets 0. Bounded to dust. LOW.
- C3 clamp as close-denial lever: "underwater at any open in window wins outright";
  LP holds a price push across a block boundary every <=5 blocks to keep a
  near-break-even holder unable to close while funding runs. Needs cross-block
  exposure. LOW.
- C4 `e.timestamp <= pos.openedAt` skip: same-second later blocks are skipped, so the
  clamp is blind for positions opened in the same second. Only the from-scratch
  (unprofitable) shape. INFO.
- C5 closePool privilege escalation: deployer (any pool) / LP can now force every
  open position to decay ~99.9 % in ~18 d; before the redesign closePool could not
  cost a holder their position. Trust note. LOW/INFO.
- C6 LockedLpVault markets: funding lands in backed reserves nobody can ever
  withdraw; "100 % to the LP" is not true for launchpad markets. INFO.
- C7 PreMarket startPrice overflow (M-2 upper half) still present:
  startPrice * decay * elapsedMax overflows for startPrice > ~1e67. Seeder self-harm. INFO.
