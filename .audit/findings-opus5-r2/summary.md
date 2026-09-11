# EXNIHILO Security Audit Summary — Opus 5 R2

**Date:** 2026-08-20
**Baseline:** commit `5197494` (2026-07-27), the tree audited by the previous round
**Scope:** `EXNIHILOPool`, `PositionNFT`, `EXNIHILOFactory`, `EXNIHILORouter`,
`PoolDeployer`, `LpNFT`, `Faucet`, and — new and never previously audited —
`PreMarket`, `PreMarketFactory`, `LockedLpVault`
**Passes:** 11
**Primary question:** can LP funds be drained, or value stolen?

## Aggregate tally (deduplicated)

```
2 CRITICAL | 4 HIGH | 4 MEDIUM | 15 LOW | 18 INFO | 1 PROCESS
```

**Yes. Value can be stolen, by two unrelated mechanisms, and both are in code
that shipped after the last audit.**

This is the first round to return a non-clean result. It is also the first round
to audit the code it claims to audit on the first attempt — the delta below was
derived from `git`, per PROCESS-001.

## What was actually new

Derived from `git diff` and `git ls-files --others` against `5197494`, not asserted.

| Contract | Status | Lines |
|---|---|---|
| `PreMarket.sol` | **new, never audited** | 562 |
| `PreMarketFactory.sol` | **new, never audited** | 183 |
| `LockedLpVault.sol` | **new, never audited** | 350 |
| `EXNIHILOPool.sol` | modified | 587 |
| `PositionNFT.sol` | modified | 170 |
| `EXNIHILOFactory.sol` | modified | 47 |
| `PoolDeployer.sol` / `EXNIHILORouter.sol` | modified | −8 / 2 |

All uncommitted at audit time. Mainnet runs the **baseline**, not this tree: the
deployed factory ABI still exposes `defaultSwapFeeBps`, which this tree removed.
Every finding below is therefore **pre-launch**, not a live incident.

## Pass coverage

| Pass | File | C | H | M | L | I |
|------|------|---|---|---|---|---|
| Nemesis (Feynman + State, iterated) | `nemesis-verified.md` | 0 | 2 | 1 | 4 | 2 |
| Behavioral State Analysis | `bsa-verified.md` | 1 | 2 | 1 | 4 | 2 |
| DoS & Griefing | `dos-griefing-verified.md` | 1 | 0 | 1 | 4 | 8 |
| External Call Safety | `external-call-safety-verified.md` | 0 | 1 | 1 | 4 | 2 |
| Input & Arithmetic | `input-arithmetic-safety-verified.md` | 0 | 0 | 2 | 5 | 6 |
| Oracle & Flash Loan | `oracle-flashloan-verified.md` | 0 | 2 | 2 | 1 | 2 |
| Proxy & Upgrade | `proxy-upgrade-safety-verified.md` | 0 | 0 | 0 | 3 | 3 |
| Reentrancy | `reentrancy-verified.md` | 0 | 0 | 0 | 2 | 4 |
| Semantic Guard | `semantic-guard-verified.md` | 0 | 1 | 1 | 1 | 3 |
| Signature & Replay | `signature-replay-verified.md` | 0 | 0 | 0 | 0 | 1 |
| State Invariant | `state-invariant-verified.md` | 0 | 0 | 0 | 2 | 4 |

Per-pass numbers are pre-deduplication and sum higher than the aggregate: the two
critical findings were each reached independently by three or four passes.

## CRITICAL

### C-1 — The settlement guard does not aggregate; an LP can zero any holder's payout for free

`EXNIHILOPool.sol:1437-1441`. Found independently by **DoS & Griefing**,
**Oracle & Flash Loan**, and **Behavioral State Analysis**.

```solidity
function _armSettlementGuard(uint256 usdcValue) internal {
    if (usdcValue * BPS_DENOM >= backedAirUsd * SETTLE_GUARD_BPS) {
        lastLargeSwapBlock = block.number;
    }
}
```

There is no accumulator. The check compares **one call's** size against **current**
depth, so N swaps at 0.99% of depth never arm the guard while compounding to
roughly `1 − 0.99ᴺ` of it. Twenty such swaps plus a settlement fit in one block.

It is a per-transaction *size* check standing in for a cumulative *price-movement*
check, which is the property the subsystem was built to provide.

**The attack is free, not merely cheap.** The swap fee is retained in the pool by
not reducing the backed reserve (`:566`, `:240-243`), so an LP swapping against
its own pool pays the fee to itself. Measured round-trip cost: **net 0.00 USDC**.
`createMarket` is permissionless, so anyone can be the LP.

Measured, independently:

| Pass | Result |
|---|---|
| DoS | payout 3,881.67 → 1,045.09 USDC; a near-boundary auto-renew went from reverting `AutoRenewActive` to succeeding with **0.00 USDC paid** |
| OFL | 14 sub-threshold swaps flipped an auto-renew verdict, payout −86%, `lastLargeSwapBlock` unchanged after every one |
| BSA | LP zeroed an expired trader's **$6,043.68** payout, kept **$6,104.72**, token leg byte-identical, **$0.00 cost**, one transaction |

Composed with H-1: **$26,016 surplus → $1,676 credited, 93.5% suppressed.**

### C-2 — A premarket's entire reserve is buyable for $1 once the auction floors

`PreMarket.sol:379-382`. Found by **Nemesis**; rated HIGH there and escalated here.

```solidity
uint256 priced = (quoteOut * price) / quoteUnit;
return priced < MIN_BUYOUT_USDC ? MIN_BUYOUT_USDC : priced;
```

Below the floor, `_buyoutCost` is **constant in `quoteReserve`**. Adding quote to
the reserve does not raise the price of taking it. And `buyout` hands the payer
the *entire* reserve — including the quote they just deposited.

So: swap quote→token (keep the tokens), then `buyout` for $1 and receive every
unit of quote back, own deposit included. Two ordinary external calls in one
transaction; `nonReentrant` releases between them.

Measured: **990,000 of 1,000,000 tokens taken for $1.00 net**, atomic and
flash-loanable; the launched market opens with the 10,000 remaining. Away from
the floor the identical trip costs $2.93M — the floor is the entire bug.

Escalated to CRITICAL because it needs no privileged role, no malicious token and
no race, drains both legs, and **every premarket reaches the floor after ~50
minutes by design**. With `startPrice` unbounded below (M-2) it is live from
block zero.

## HIGH

### H-1 — The settlement guard's trigger set omits position opens

`EXNIHILOPool.sol:1437`, armed only at `:1482` and `:1515`. Found independently by
**Semantic Guard**, **Oracle & Flash Loan**, **Nemesis**, and **BSA**.

`_priceClose` reads a different reserve pair per side. `openShort` (`:784`, `:788`)
writes both variables a **long's** settlement reads; `openLong` (`:656`, `:660`)
writes both a **short's** reads. Neither arms the guard at any size.

The gap is quantified by the protocol's own constants: the guard trips a swap at
`SETTLE_GUARD_BPS` = **1%** of `backedAirUsd`, while `currentMaxPositionBps` ramps
to `CAP_MAX_BPS` = **20%**. The protocol permits a non-arming action **20× larger
than the arming threshold**.

Measured: `openShort($36k)` then `closePositionAfterDeadline` in one transaction
credited the holder **$11,936 instead of $25,756** (OFL); eight auto-renew longs
credited **$819.48 → $0.00** with the LP realising **+$776.37** and the token leg
exactly zero (Nemesis); symmetric on shorts via `openLong`, **$272.68 → $0.00**.

The exclusion is deliberate and documented at `:385-394`, on the grounds that
opens "pay a 5% fee of which the 1% protocol share is a real loss even to the LP."
That reasoning fails because the attacker **is** the LP: with `LP_FEE_BPS` = 400 of
a 500 bps base fee, the LP is rebated 80% of the fee it pays itself.

`EXNIHILOPool.sol:1075-1078` states "any flip needs a swap large enough to arm
that guard." That sentence is false.

### H-2 — A holder can sandwich their own close

`EXNIHILOPool.sol:1453`. Found by **BSA**, corroborated from the opposite
direction by **OFL**.

`_assertSettlementUnguarded` exempts `msg.sender == holder` outright, reasoning
that the holder can already close at will via `closeLong`/`closeShort` so the
exemption grants nothing. But `closeLong`/`closeShort` carry **no guard either**,
so the holder can pump, close at the inflated mark, and unwind.

Measured **$4,122 per close, 3.2% of pool USDC**; profitable whenever mark exceeds
~1% of `backedAirUsd`, and the cap permits 20%.

**This reverses carried findings OFL-1/OFL-2**, accepted as "uneconomical" since
the first round. That verdict is correct for the full open→manipulate→close cycle
from scratch — BSA swept 28 cells and every one is negative. The profitable shape
is the **incremental** leg against an already-open position, which
`ManipulationSafety.ts` structurally cannot observe: it samples `before` at line
138, ahead of `openSide` at line 140.

### H-3 — Renewal deadline stacking freezes LP principal indefinitely

Found by **BSA**, independently by **Nemesis**.

Three sites compose:

- `renewPosition:1004-1005` extends from `pos.deadline`, not from now, so renewals **stack**. (`_tryAutoRenew:1122` correctly extends from now — the two disagree.)
- The only bound, `closeDate != 0 && newDeadline > closeDate` (`:1008`), applies solely after `closePool` and does **not** bound deadlines already stacked.
- `removeLiquidity:896` reverts on `openPositionCount != 0`.

A dust position renewed 1,217 times at the `MIN_POSITION_FEE` floor costs
**$60.85** and freezes 100% of LP principal for **100 years**, independent of pool
size. `DURATION_MAX` caps each increment at 30 days, not the total.

**This kills carried finding LOW-BSA-1**, whose published mitigation is "bounded
by `closePool`."

### H-4 — PreMarket buyout depends on the project token's `transferFrom`

`PreMarket.sol:512-519` → `EXNIHILOFactory.sol:205`. Found by **External Call Safety**.

`buyout` cannot complete without `createMarket` pulling the whole token reserve via
`safeTransferFrom`, executed with `tx.origin` = the bidder. The premarket's buy
path never touches it (`:447` uses plain `transfer`), so a `tx.origin`-keyed
whitelist is invisible to buyers.

Block every honest bid, wait for the floor, take the accumulated quote reserve for
$1. Nothing at seed time proves a **third party** can trigger the token's
`transferFrom`; `_pullExactTo` only proves the seeder can.

## MEDIUM

- **M-1 — `token == usdc` strands a premarket permanently.** Found by **five** passes. Neither `PreMarketFactory.sol:120-121` nor the `PreMarket` constructor checks it; `EXNIHILOFactory.sol:196` reverts `TokenIsUsdc` at buyout, forever, with no refund path.
- **M-2 — `startPrice` is unbounded in both directions.** `PreMarket.sol:313` rejects only `== 0`. Below: born at the buyout floor, making C-2 live immediately; the seeder recovers their own quote leg for $1, defeating the lock guarantee. Above: `currentPrice()` overflows and bricks `buyout` forever.
- **M-3 — No refund, rescue or expiry path anywhere in `PreMarket`.** `buyout` is the only exit and needs three transfers across two arbitrary assets to all succeed. Any one blocked strands both legs forever.
- **M-4 — The settlement guard is also a denial lever.** ~$7.24/block to block all third-party settlement; composed with the irreversible `closePool`, the LP is locked out of `removeLiquidity` indefinitely. Compounds the voided NM-003.

## Selected LOW

- **SI-001** — the **token-side** reserve invariant is still the loose lower bound that round 1 fixed on the USDC side. `openLong` moves collateral into `pos.lockedAmount` and nothing represents it. Over 360 randomised ops: USDC slack **0**, token slack **17,163 / 100,000 (17%)**, and adding `Σ longs.lockedAmount` gives slack **0**. Fix is a `totalLongCollateral` accumulator at `Pool:660`, `:1633`, `:1650`.
- **PU-003** — `verifyMainnetPools.ts` (new) is written against the removed ABI: `positionDuration()`, `maxPositionUsd()`, `maxPositionBps()` do not exist. It cannot verify any pool, so permissionless markets ship unverified.
- **PU-004** — `packages/indexer/src/chain.ts:26-38` hardcodes the live baseline addresses; `deployMainnet.ts` rewrites only the site's JSON. Post-redeploy the site and indexer follow different factories, and `INDEXED_CHAIN_ID` matches on both sides so nothing trips.
- **IA-R2-4** — the 200 → 100 bps reweighting missed the frontend: `FeedPage.tsx:446` computes `(usdcRaw * 200n) / 10_000n`, so displayed protocol revenue is **exactly 2×** reality. `LongShortPanel.tsx:19` likewise (display-only fallback).
- **PU-001** — `PoolDeployer.sol:14` has no `onlyFactory`; orphan pools are inert but the guard is absent. R1's proxy pass silently dropped this.
- **RE2-1** — `PreMarketFactory.sol:133-158` constructs the `PreMarket` with reserves recorded before funding it, so the child is briefly a live AMM holding nothing. Closed only incidentally, by `_pullExactTo`'s recipient-balance check and the pull order — neither is a guard.
- **IA-R2-7 / ECS-R2-3** — both vault claim paths call `_harvest()` unconditionally, so one reverting `pool.claimFees` freezes balances already accrued and already held.
- **IA-R2-6** — vault split truncation: 100 × (1-atom donate + harvest) yields LP 100 / integrator 0. Bounded to donated dust, gas-negative.
- **LOW-DOS-4** — `LockedLpVault.sol:216` hardcodes `claimFees(address(this))`, discarding the `to` escape hatch the pool provides.
- **NM-R2-005** — arming size scales with depth, so a very small market is permanently guarded.
- **IA-R2-5** — `decimals()` fallback to 18 on a genuinely 6-dec quote prices a $30,000 reserve at the $1 floor.

## Corrections to the previously published report

Seven. Each was re-derived from the code or from `git`, not carried.

| Prior claim | Correction | Confirmed by |
|---|---|---|
| **NM-001** open — PositionNFT mint reachable before `initFactory` | **False positive.** `PositionNFT.sol:279-281`/`:308-310` check `FactoryNotSet()` *before* `msg.sender != pool`, identically at the baseline. The window never existed. | 3 passes + coordinator |
| **NM-002** open — factory residual approvals not revoked | **False positive.** `forceApprove(pool, 0)` on both legs at `EXNIHILOFactory.sol:245-246`, present at the audited baseline. | 3 passes + coordinator |
| **IA-6** — tokens with >38 decimals overflow `_cpAmountOut` | Wrong by ~26 orders of magnitude. Every call site pairs a USDC-scale factor with a token-scale one, never token². Measured boundary ~64 decimals. Downgrade to INFO. | Input & Arithmetic |
| **LOW-BSA-1** — LP exit bounded by `closePool` | The mitigation is **false**; see H-3. | BSA, Nemesis |
| **OFL-1 / OFL-2** — flash-loan manipulation uneconomical | True only for the shape that was tested. See H-2. | BSA, OFL |
| ERC-721 hook vector closed because `PositionNFT` uses `_mint` | It uses `_safeMint` at both sites, at the baseline too. Vector is closed, for a different reason. | External Call Safety |
| "`EXNIHILOPool` declares 26 external functions" | Included `IPositionNFT`/`ILpNFT` interface declarations. Contract body: baseline **24** → now **27**. All 14 mutators carry `nonReentrant`. | Reentrancy |

## PROCESS-002 — comments asserting properties the code does not enforce

Last round's PROCESS-001 was *reports describing the wrong code*. This round's is
narrower and more dangerous, because it is inside the code.

Seven documented invariants are false:

| Site | Claims | Reality |
|---|---|---|
| `EXNIHILOPool.sol:1075` | "any flip needs a swap large enough to arm that guard" | H-1 — opens flip it, 20× under the threshold |
| `PreMarket.sol:107-109` | "validated at seed time, not at buyout" | M-1, M-2 — `token == usdc` and `startPrice` are not |
| `PreMarket.sol:466-471` | "no state in which they are stranded" | M-3 — any blocked transfer strands both legs |
| `PreMarket.sol:77-79` | "cannot be pulled back out, by anyone, ever" | M-2 — quote leg exits via `swap`, or for $1 |
| `EXNIHILOFactory.sol:67` | "onERC721Received implemented" | It is not; `safeTransferFrom` reverts `ERC721InvalidReceiver` |
| `EXNIHILOFactory.sol:230` | "the returned id must equal our prediction" | Never compared |
| `LockedLpVault.sol:40, 65` | LP stream is "3% of notional" | 4% since this round |

**And two tests were written to confirm a comment rather than to attack the code:**

- `AutoRenew.ts:871` — "opening a position does not arm the guard" — sets up a **long** victim and attacks with `openLong`. A long prices against `airTokenSupply`/`backedAirUsd`; `openLong` moves the *short* pair. It exercises the one pairing that provably moves nothing, passes, and certifies H-1 as safe.
- `ManipulationSafety.ts:138` — samples `before` ahead of `openSide` at `:140`, so the grid can only ever measure the unprofitable from-scratch cycle, never the profitable incremental one. It passes in full on this tree.

This codebase's comments are unusually rigorous, reasoning explicitly about
attackers and economics. Prior rounds leaned on them. That is precisely why the
false ones did damage: **three of this round's six most serious findings sit
directly behind a comment asserting they were impossible.**

**Action:** treat a security claim in a comment as an unproven hypothesis with a
test owed, not as a finding already closed. Where a comment states an invariant,
the test for it must fail when the invariant is removed.

## Structural properties — re-verified, still hold

Across all ten contracts including the three new ones:

- **No loops** → unbounded-loop and gas-limit DoS impossible.
- **No `unchecked`** → accounting desync fails closed.
- **No `delegatecall`, no proxies, no CREATE2, no assembly, no initializers.**
- **No signatures** — re-derived by grep, by walking the OZ 5.6.1 inheritance closure (`SafeERC20.safePermit` does not exist in v5), and by a selector scan over all 171 public functions. Zero hits.
- **No oracles** — pricing is self-referential.
- **Pull payments** for all fees and third-party payouts.
- All contracts fit EIP-170; `PositionNFT` is closest at 20,005 / 24,576 bytes.

## Test suite

**595 passing, 0 failing** at audit start and after cleanup, on the tree as found.

The new contracts arrived **with** tests — `PreMarket.ts` (98), `LockedLpVault.ts`
(59), plus both ramp suites — a real improvement over the prior round, where the
fixes shipped testless. The eight `Coverage.ts` storage-slot failures from last
round are gone.

The gap is adversarial coverage, not volume: `test/PreMarket.ts` contains no
adversarial trading scenario, and the two weak tests above certify exactly the
findings they cannot see.

## Recommendations, in priority order

1. **Do not deploy this tree.** C-1 and C-2 are both live in it.
2. **Rebuild the settlement guard around cumulative per-block price movement**, not per-call trade size, and arm it from every reserve-mutating path including `openLong`/`openShort` — or drop the guard and price settlement from a source a single block cannot move. Fixing only the trigger set leaves C-1; fixing only aggregation leaves H-1.
3. **Guard `closeLong`/`closeShort`, or remove the holder exemption** (H-2).
4. **Tie `MIN_BUYOUT_USDC` to seeded value** rather than a flat $1. One change closes C-2 and defuses H-4 and M-2. Note it does not fix M-3 — the floor never prevented stranding in the first place.
5. **Bound renewal deadlines absolutely** and make `closeDate` bind retroactively (H-3).
6. **Complete `PreMarket` seed-time validation**: `token != usdc`, `startPrice` bounds both ways, and a test that a third party can move the token (M-1, M-2, H-4).
7. **Decide whether `PreMarket` gets a refund path.** Its irreversibility is a deliberate selling point, but M-3 shows it converts any counterparty misbehaviour into permanent loss.
8. **Add the `totalLongCollateral` accumulator** (SI-001) — the symmetric completion of last round's fix.
9. **Fix `verifyMainnetPools.ts`** before launch (PU-003), and add the indexer to the redeploy runbook (PU-004).
10. **Rewrite `AutoRenew.ts:871` and the `ManipulationSafety` grid** to exercise the cross-side pairing and the incremental leg. Mutation-test both.
11. **Correct the seven false comments** and the frontend fee constant.

## Scope limits

**Reviewed in depth:** all of `PreMarket`, `PreMarketFactory`, `LockedLpVault`;
`EXNIHILOPool`'s custody, conservation, settlement, renewal and swap paths
including all three new subsystems; `EXNIHILOFactory.createMarket`; the
premarket→market handoff.

**Reviewed at surface level:** `PositionNFT`'s SVG and metadata rendering (the
170-line diff is presentational and was confirmed not to touch the mint or
mutation paths), `LpNFT`, `Faucet`.

Eleven AI analysis passes, no human security firm, no formal verification, no
fuzzing campaign. Findings marked "measured" were executed in Hardhat against this
tree; the exploit scaffolding was removed after the round and archived outside the
repository. A clean pass is evidence of absence only to the depth that pass
reached — as the seven corrections above demonstrate.
