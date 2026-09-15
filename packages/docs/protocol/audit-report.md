---
description: "EXNIHILO's fifth audit round, and the first that is not clean: 2 Critical, 4 High, 4 Medium in code written since the last round — none of it deployed."
---

# Audit Report — Opus 5 R2 (2026-08-20)

This is the complete result of the most recent audit round, published here rather
than only in the repository so it can be read, linked and quoted without cloning
anything. The per-pass reports it summarizes live in
[`.audit/findings-opus5-r2/`](https://github.com/Red-Goglz/EXNIHILO/tree/main/.audit/findings-opus5-r2).

::: danger This round is not clean
The four preceding rounds each returned 0 Critical and 0 High. **This one returns
2 Critical and 4 High.** Every one of them is in code written *after* the last
audit — the pre-market subsystem and the pool's new settlement guard.

**None of it is deployed.** Avalanche mainnet runs the previously audited
contracts; the affected code is a pending redeploy that has not shipped and, on
this result, must not ship in its current form.

Three of the six most serious findings sit directly behind a source comment
asserting they were impossible. That is the finding under the findings, and it is
[recorded below](#process-002-the-comments-were-load-bearing-and-some-were-wrong).
:::

::: tip Status since publication
C-2 and M-1 are fixed and H-2 is closed. The settlement guard and renewals behind C-1, H-1, H-3 and
M-4 no longer exist: positions now pay continuous funding instead of expiring. That redesign has not
itself been audited. See [Security](./security#audit-status).
:::

::: warning About the method
All five audit rounds were performed by **AI models, not a human security firm**.
No formal verification and no fuzzing campaign was run. Every round has surfaced
findings its predecessors missed, and this round additionally found **seven
substantive errors in the previously published report** — two findings that were
never real, and five conclusions reached on evidence that did not support them.

None of these reports should be treated as final.
:::

## Scope and result

**Date:** 2026-08-20
**Baseline:** commit `5197494` (2026-07-27) — the tree the previous round audited
**Contracts:** `EXNIHILOPool`, `PositionNFT`, `EXNIHILOFactory`, `EXNIHILORouter`,
`PoolDeployer`, `LpNFT`, `Faucet`, and — new, never previously audited —
`PreMarket`, `PreMarketFactory`, `LockedLpVault`
**Passes:** 11 independent analyses
**Primary question:** can LP funds be drained, or value stolen?

```
2 CRITICAL | 4 HIGH | 4 MEDIUM | 15 LOW | 18 INFO | 1 PROCESS
```

**Yes — value can be stolen, by two unrelated mechanisms.**

## What was actually audited

Per PROCESS-001 from the last round, the delta was derived from version control
rather than asserted in prose:

| Contract | Status | Lines |
|---|---|---|
| `PreMarket.sol` | **new, never audited** | 562 |
| `PreMarketFactory.sol` | **new, never audited** | 183 |
| `LockedLpVault.sol` | **new, never audited** | 350 |
| `EXNIHILOPool.sol` | modified | 587 |
| `PositionNFT.sol` | modified | 170 |
| `EXNIHILOFactory.sol` | modified | 47 |
| `PoolDeployer` / `EXNIHILORouter` | modified | −8 / 2 |

1,095 lines of entirely unreviewed code, plus a substantially rewritten pool.

The deployed mainnet factory still exposes `defaultSwapFeeBps`, which this tree
removes — independent confirmation that **the live protocol is the older, audited
code** and everything above is pre-launch.

## Pass coverage

| Pass | C | H | M | L | I |
|------|---|---|---|---|---|
| Nemesis (Feynman + State Inconsistency, iterated) | 0 | 2 | 1 | 4 | 2 |
| Behavioral State Analysis | 1 | 2 | 1 | 4 | 2 |
| DoS & Griefing | 1 | 0 | 1 | 4 | 8 |
| External Call Safety | 0 | 1 | 1 | 4 | 2 |
| Input & Arithmetic | 0 | 0 | 2 | 5 | 6 |
| Oracle & Flash Loan | 0 | 2 | 2 | 1 | 2 |
| Proxy & Upgrade | 0 | 0 | 0 | 3 | 3 |
| Reentrancy | 0 | 0 | 0 | 2 | 4 |
| Semantic Guard | 0 | 1 | 1 | 1 | 3 |
| Signature & Replay | 0 | 0 | 0 | 0 | 1 |
| State Invariant | 0 | 0 | 0 | 2 | 4 |

Per-pass numbers precede deduplication and sum higher than the headline: each
critical finding was reached independently by three or four passes that could not
see one another's work. That convergence is the strongest evidence in this report.

## The two critical findings

### C-1 — The settlement guard does not aggregate

`EXNIHILOPool.sol:1437`. Found independently by three passes.

The guard was introduced this round to stop settlement being priced at a
manipulated mark. It compares **one call's** size against **current** depth and
stores a block number. There is no accumulator, so a sequence of individually
sub-threshold swaps never arms it while compounding to an arbitrarily large move —
and the whole sequence, plus the settlement, fits in a single block.

It is a per-transaction *size* check standing in for a cumulative *price-movement*
check, which is the property it exists to provide.

The attack is **free rather than merely cheap**: the swap fee is retained in the
pool by not reducing the backed reserve, so an LP trading against its own pool
pays the fee to itself. Measured round-trip cost: **net $0.00**. Market creation
is permissionless, so anyone can occupy the LP role.

Three passes measured it separately. An expired holder's payout was suppressed
3,881.67 → 1,045.09 USDC in one; an opted-in auto-renew position was flipped into
a close paying **$0.00** in another; a third had the LP zero a **$6,043.68**
payout and retain **$6,104.72**, in one transaction, at no cost.

### C-2 — A pre-market's entire reserve becomes buyable for $1

`PreMarket.sol:379`. Found by the Nemesis pass; escalated from HIGH in review.

The buyout price has a fixed **$1 floor**, added so that a buyout is always
executable and reserves can never be stranded. Below that floor the cost is
*constant in the reserve size* — adding assets to the reserve does not raise the
price of taking it — while the buyout hands the payer the entire reserve,
including whatever they just deposited.

The result is an atomic, flash-loanable round trip that takes the reserve for the
floor price. Measured: **990,000 of 1,000,000 tokens for $1.00 net.** Away from
the floor the identical trip costs $2.93 million.

Every pre-market reaches the floor about 50 minutes after seeding, **by design**.

This is the round's clearest lesson in second-order effects: an anti-stranding
measure became a $1 price tag on the whole contract. Four separate passes arrived
at that floor from four different directions. It also does not achieve what it was
added for — a blocked transfer still strands both legs (M-3).

## High severity

| ID | Title | Note |
|---|---|---|
| **H-1** | The settlement guard's trigger set omits position opens | `openShort` writes both reserves a **long's** settlement reads, and `openLong` both a short's — neither arms the guard. The guard trips a swap at **1%** of USDC depth while the position cap permits an open at **20%**: a non-arming action twenty times larger than the arming threshold. Measured: a holder credited $11,936 instead of $25,756. Composed with C-1, **93.5%** of a $26,016 surplus was suppressed. |
| **H-2** | A holder can sandwich their own close | The guard deliberately exempts the position holder, reasoning they can already close at will — but the ordinary close paths carry no guard either. Measured $4,122 per close, 3.2% of pool USDC. **Reverses OFL-1/OFL-2**, accepted as uneconomical since the first round. |
| **H-3** | Renewal deadline stacking freezes LP principal | Renewals extend from the existing deadline rather than from now, with no absolute cap, and LP exit is blocked while any position is open. **$60.85** freezes 100% of an LP's principal for **100 years**, independent of pool size. **Kills LOW-BSA-1**, whose published mitigation does not work. |
| **H-4** | Pre-market buyout depends on the project token's `transferFrom` | The buyout cannot complete without the factory pulling the token reserve, executed with `tx.origin` set to the bidder. The buy path never touches `transferFrom`, so a whitelist keyed on it is invisible to buyers — and blocks every honest bid until the floor is reached. |

## Medium severity

- **M-1** — a pre-market seeded with USDC as the project token passes seeding and then reverts at buyout forever, with no refund path. Found by **five** passes independently.
- **M-2** — the auction start price is unbounded in both directions: too low makes C-2 live from block zero and lets the seeder recover their own leg for $1; too high overflows and bricks the buyout permanently.
- **M-3** — `PreMarket` has no refund, rescue or expiry path anywhere. Buyout is the only exit and requires three transfers across two arbitrary assets to all succeed; any one blocked strands both legs forever.
- **M-4** — the settlement guard is also a denial lever: ~$7.24 per block blocks all third-party settlement, and combined with the irreversible pool close it can lock an LP out of withdrawal indefinitely.

## Notable lower-severity findings

- The **token-side reserve invariant** is still the loose lower bound that the last round fixed on the USDC side — long collateral moves out of the tracked reserve and nothing represents it. Measured slack: **17% on the token leg, 0% on USDC**, and exactly 0 once the missing term is added. No exploit path today, but the assertion cannot detect a leak.
- `verifyMainnetPools.ts` is written against an ABI this tree removed and **cannot verify any pool**, so permissionless markets would ship with unverified source.
- The indexer hardcodes the currently live contract addresses; the deploy script rewrites only the site's copy. After a redeploy the site and indexer would follow different factories with nothing to detect it.
- The 2% → 1% protocol-fee change reached the contracts, docs, SDK, tests and indexer but **not the frontend**, which still displays **exactly double** the real protocol revenue.

## PROCESS-002 — the comments were load-bearing, and some were wrong

Last round's process finding was that audit *reports* had described the wrong
code. This round's is narrower and worse, because it is inside the code.

**Seven source comments assert security properties the code does not enforce**,
including the three that directly precede C-2, H-1 and M-1. In each case the
comment does not merely describe the code — it argues, with reasoning about
attackers and economics, that a particular attack is uneconomical or impossible.
For H-1 the argument is explicit and wrong: position opens are excluded from the
guard because they "pay a 5% fee", but 80% of that fee is rebated to the LP, who
is the attacker.

**And two tests were written to confirm a comment rather than to attack the code:**

- The regression test asserting that opening a position does not arm the guard
  sets up a **long** victim and attacks with `openLong` — the one pairing that
  provably moves nothing. It passes, and certifies H-1 as safe.
- The manipulation-safety grid samples its baseline *before* the position is
  opened, so it can only ever measure the from-scratch cycle — genuinely
  unprofitable, and swept across 28 cells to confirm it. The profitable shape is
  the incremental leg against an already-open position, which the grid
  structurally cannot see. It passes in full on this tree.

This codebase's comments are unusually rigorous, and prior rounds leaned on them.
That is exactly why the false ones did damage.

**The rule this yields:** a security claim in a comment is an unproven hypothesis
with a test owed, never a finding already closed. Where a comment states an
invariant, the test for it must fail when the invariant is removed.

## Corrections to the previously published report

| Prior claim | Correction |
|---|---|
| **NM-001** open — mint reachable before `initFactory` | **Never real.** The factory check precedes the caller check, at this commit and at the baseline. |
| **NM-002** open — factory approvals not revoked | **Never real.** Both approvals are revoked, and were at the audited baseline. |
| **IA-6** — >38 decimals overflows the swap math | Wrong by ~26 orders of magnitude; the real boundary is ~64 decimals. Downgraded to INFO. |
| **LOW-BSA-1** — LP exit bounded by pool close | The stated mitigation does not work. See H-3. |
| **OFL-1 / OFL-2** — manipulation uneconomical | True only of the shape that was tested. See H-2. |
| ERC-721 vector closed because minting uses `_mint` | It uses `_safeMint`. The vector is closed for a different reason. |
| "26 external functions" on the pool | Counted interface declarations. The real figure was 24, now 27; all 14 state-mutating externals are guarded. |

Two of these were findings the protocol has been carrying as open work for four
rounds, and neither ever existed.

## Structural properties — re-verified, still hold

These eliminate whole vulnerability classes, and were re-derived across the three
new contracts rather than carried forward:

- **No loops** in any contract → unbounded-loop and gas-limit DoS impossible.
- **No `unchecked` blocks** → an accounting desync fails closed, not open.
- **No `delegatecall`, no proxies, no CREATE2, no assembly, no initializers.**
- **No signatures** — confirmed by source search, by walking the OpenZeppelin 5.6.1 inheritance closure, and by a selector scan over all 171 public functions. Zero hits.
- **No oracles** — pricing is self-referential.
- **Pull payments** for all fees and third-party payouts.
- All contracts fit within the EIP-170 code-size limit.

`LockedLpVault` came through the vault and revenue-share threat sets **clean**:
the lock guarantee is real, the harvest arithmetic cannot underflow, and the two
roles are properly isolated.

## Test suite

**595 passing, 0 failing**, before and after the round — no contract was modified
during this audit.

The new contracts arrived **with** tests, unlike the previous round's fixes. The
gap is adversarial coverage rather than volume: the pre-market suite contains no
adversarial trading scenario at all, and the two tests described under PROCESS-002
certify precisely the findings they cannot see.

## Recommendations, in priority order

1. **Do not deploy this tree.** C-1 and C-2 are both live in it.
2. **Rebuild the settlement guard** around cumulative per-block price movement rather than per-call trade size, and arm it from every reserve-mutating path. Fixing only the trigger set leaves C-1; fixing only the aggregation leaves H-1.
3. **Guard the ordinary close paths, or drop the holder exemption** (H-2).
4. **Tie the buyout floor to seeded value** instead of a flat $1 — one change closes C-2 and defuses H-4 and M-2.
5. **Bound renewal deadlines absolutely**, and make the pool close date bind retroactively (H-3).
6. **Complete pre-market seed-time validation** and add a test that a third party can move the project token (M-1, M-2, H-4).
7. **Decide whether the pre-market gets a refund path.** Irreversibility is a deliberate selling point, but M-3 turns any counterparty misbehaviour into permanent loss.
8. **Add the missing token-side collateral accumulator** — the symmetric completion of last round's fix.
9. **Fix the pool verification script** before launch, and add the indexer to the redeploy runbook.
10. **Rewrite the two weak tests** to exercise the cross-side pairing and the incremental leg, and mutation-test both.
11. **Correct the seven false comments** and the frontend fee constant.

## Scope limits

**Reviewed in depth:** all of `PreMarket`, `PreMarketFactory` and `LockedLpVault`;
`EXNIHILOPool`'s custody, conservation, settlement, renewal and swap paths
including all three new subsystems; `EXNIHILOFactory.createMarket`; the
pre-market→market handoff.

**Reviewed at surface level:** `PositionNFT`'s SVG and metadata rendering — its
170-line diff was confirmed presentational and not to touch the mint or mutation
paths — plus `LpNFT` and `Faucet`.

Findings described as measured were executed in Hardhat against this tree. The
exploit scaffolding was removed after the round and archived outside the
repository. A clean pass is evidence of absence only to the depth that pass
reached, which the seven corrections above should make concrete.

## Earlier rounds

The four preceding rounds, their findings and their remediations are summarized on
the [Security](./security#audit-status) page. All reports:
[`.audit/`](https://github.com/Red-Goglz/EXNIHILO/tree/main/.audit).
