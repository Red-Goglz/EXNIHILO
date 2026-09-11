# Audit Round Scope — Opus 5 R2 (2026-08-20)

**Read this before starting your pass. Every auditor in this round shares it.**

## Repo

`C:\dev\projects\exnihilo-dapp`, branch `mainnet-launch`, HEAD `c02af1d`.
Contracts live in `packages/blockchain/contracts/`. Tests in `packages/blockchain/test/`.

## The baseline — derived from git, never asserted

The last audit round (Opus 5, 2026-07-27) audited the tree at commit **`5197494`**.
`.audit/findings-opus5/` holds its per-pass reports.

Since `5197494` the contracts have changed as follows. **This was derived from
`git diff` and `git ls-files --others`, and it is the authority on what is new.**
The previous round's headline finding (PROCESS-001) was that a prior report
asserted its delta in prose and was wrong by 1,171 lines. Do not repeat that.

### Never audited by any prior pass — untracked, brand new

| Contract | Lines | Nature |
|---|---|---|
| `PreMarket.sol` | 562 | Standalone bonding-curve pre-market with decaying price, `swap`, `buyout`, and a `Launched` path that calls `IEXNIHILOMarketFactory.createMarket` |
| `PreMarketFactory.sol` | 183 | Deploys `PreMarket` instances, pulls seed token + quote |
| `LockedLpVault.sol` | 350 | Holds an LP NFT, harvests pool fees, splits them between an LP party and an integrator party, `IERC721Receiver` |

**These three are the highest-priority target in this round.** They have zero
prior audit coverage. Treat them as unreviewed code, not as a delta.

### Modified since the audited baseline (all uncommitted working-tree changes)

| Contract | Δ lines |
|---|---|
| `EXNIHILOPool.sol` | 587 |
| `PositionNFT.sol` | 170 |
| `EXNIHILOFactory.sol` | 47 |
| `PoolDeployer.sol` | −8 |
| `EXNIHILORouter.sol` | 2 |
| `test/ReentrantToken.sol` | +32 |

Get the exact diff with:

```bash
git diff -- packages/blockchain/contracts/
```

### What changed in the pool, thematically

Confirm each against the diff yourself; this list orients you, it does not replace reading.

1. **Fee split reweighted** — `LP_FEE_BPS` 300 → 400, `PROTOCOL_FEE_BPS` 200 → 100.
2. **`swapFeeBps` is now a `constant` 100** (1 %), no longer immutable per-pool.
   `defaultSwapFeeBps` removed from the factory and `MIN_SWAP_FEE_BPS` deleted.
3. **Position cap ramp (new).** `maxPositionUsd` / `maxPositionBps` storage and
   `setPositionCaps()` are gone. Replaced by `currentMaxPositionBps()`, ramping
   `CAP_START_BPS` 100 → `CAP_MAX_BPS` 2000 over `CAP_RAMP_DURATION` 24 h from
   the new `createdAt` immutable.
4. **Position duration ramp (new).** Immutable `positionDuration` is gone.
   Replaced by `currentPositionDuration()`, stepping over `DURATION_AGE_1..4`
   (1 h, 8 h, 24 h, 7 d) up to `DURATION_MAX` 30 days.
5. **Settlement guard (new).** `lastLargeSwapBlock`, `_armSettlementGuard`,
   `_assertSettlementUnguarded`, `SETTLE_GUARD_BPS` 100, `SETTLE_GUARD_BLOCKS` 5,
   `SettlementGuardActive` error, plus the `settlementGuardedUntilBlock()` and
   `settlementGuardArmingSize()` views.
6. **`KEEPER_BOUNTY` removed entirely.** The prior round recorded NM-003
   ("no keeper incentive") as *closed by `KEEPER_BOUNTY`". That closure is now void.
   Re-examine who is motivated to settle expired positions and what happens if
   nobody does.
7. **`RENEW_MARGIN_BPS` 200 (new)** — 2 % of mark as auto-renew margin.
8. **`_quoteShortfall()` (new)** internal view.
9. **New `Swap` event** carrying post-trade reserves.
10. **Factory `createMarket` signature shrank** — `maxPositionUsd`,
    `maxPositionBps`, `defaultSwapFeeBps`, `positionDuration` params dropped;
    `ZeroAddress` / `ZeroAmount` / `TokenIsUsdc` errors added.

### Deployment status — relevant to severity

Mainnet deploy happened at commit `c72f6a7` (2026-07-28), which carried the
**baseline** contracts, not this working tree. Live addresses are in
`packages/site/src/contracts/mainnetAddresses.json`. So the code you are auditing
is a **pending redeploy**, and findings in it are pre-launch, not live incidents.
Say so if it changes how you rate something.

## Primary question

**Can LP funds be drained, or value stolen?** Everything else is secondary.
Second question this round, because of the new contracts: **can a pre-market
seeder, an integrator, or a vault counterparty extract more than their share?**

## Rules for this round

1. **Cite `file:line` for every claim.** A finding without a location is not a finding.
2. **Every finding needs a concrete exploit or failure path** — specific inputs or
   state, leading to a specific wrong outcome. "Could be unsafe" is not a finding.
3. **Verify before you report.** Re-read the surrounding code and check whether an
   existing guard, modifier, or invariant already blocks your path. Prior rounds'
   value came from the verify step killing plausible-sounding false positives.
   Report what survived; it is fine to say a pass found nothing.
4. **Check the carried findings from `.audit/findings-opus5/` that fall in your
   area** and state whether each still holds, given the diff.
5. **Severity:** CRITICAL = funds directly stealable/drainable. HIGH = funds at
   risk under realistic conditions, or protocol insolvency. MEDIUM = value leak or
   broken accounting needing unusual conditions. LOW = griefing, precision, edge
   cases with bounded damage. INFO = hygiene, no exploit path.
6. **Do not modify contracts.** This round is analysis only. If you believe a fix
   is required, describe it precisely in your report and leave the code alone —
   the coordinator decides what changes.

## Deliverable

Write `<pass-name>-verified.md` into `.audit/findings-opus5-r2/` matching the
structure used in `.audit/findings-opus5/` — read a sibling file there first.
Open with a heading, the date `2026-08-20`, the scope you actually covered, and a
fenced tally line:

```
0 CRITICAL | 0 HIGH | 0 MEDIUM | 0 LOW | 0 INFO
```

Then a section per finding: ID, severity, `file:line`, the exploit path, and why
you believe it. Then a short section on what you checked and found clean, so the
next round knows what this pass actually covered.

Return to the coordinator a short summary: the tally, one line per finding, and
anything you want the other passes to know.
