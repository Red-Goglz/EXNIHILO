# N E M E S I S — Verified Findings (Opus 5)

**Date:** 2026-07-27
**Model:** Claude Opus 5
**Scope:** `EXNIHILOPool`, `PositionNFT`, `EXNIHILOFactory`, `EXNIHILORouter`, `LpNFT`, `PoolDeployer`, `Faucet`
**Baselines:** `.audit/findings/` (2026-04-04), `.audit/findings-4.7/` (2026-04-18), `.audit/findings-fable5/` (2026-07-09)
**Primary question:** can LP funds be drained or value stolen?

---

## Executive result

```
0 CRITICAL | 0 HIGH | 0 MEDIUM | 2 LOW | 1 PROCESS
```

**No path was found by which LP funds can be drained or value stolen.**

The custody model is sound: pull payments throughout, correct access control on
every value-moving entry point, CEI ordering, and a reserve invariant that is now
an exact conservation law asserted on every state-changing path.

---

## PROCESS-001 — Prior audit reports do not describe the audited code

**Severity:** PROCESS (not a code defect, but it invalidated the safety story)

`.audit/findings-fable5/nemesis-verified.md` states:

> "The single post-audit commit (`fb520ab`, "fix indexer and pnl") changed only
> `PositionNFT`'s on-chain SVG / PnL-percent **display** … it does **not** touch
> pool accounting, custody, or any value-moving code."

At the time of this audit that was false. `git diff --stat HEAD` reports:

```
 packages/blockchain/contracts/AirToken.sol        |   92 --   (deleted)
 packages/blockchain/contracts/EXNIHILOFactory.sol |   77 +-
 packages/blockchain/contracts/EXNIHILOPool.sol    | 1171 ++++++++++++-------
 packages/blockchain/contracts/EXNIHILORouter.sol  |   57 +-
 packages/blockchain/contracts/PoolDeployer.sol    |    6 +-
 packages/blockchain/contracts/PositionNFT.sol     |  343 +++---
```

The entire renewal / auto-renew / keeper / claim subsystem — `renewPosition`,
`settleExpired`, `_tryAutoRenew`, `_autoRenewQuote`, `applyRenewal`, `claimFees`,
`claimProtocolFees`, `claimPayout`, `_settle`, `_creditPayout`, the impact-fee
math, and the position caps — had **never been audited** by any prior pass, yet
was deployed to Fuji.

**Fix:** commit the contracts so each audit has a truthful baseline, and treat
"delta since last audit" as something to be *derived from git*, never asserted.

---

## Findings

### NM-OP5-001 — `swap()` accepts a zero-output trade

**Severity:** LOW
**Location:** `EXNIHILOPool.sol` — `swap()`, `_cpAmountOut()`
**Discovery path:** Feynman Category 6 (ignored return / fallthrough)

`_cpAmountOut` returns `0` when `rawOut <= fee`:

```solidity
uint256 rawOut = (amountIn * reserveOut) / (reserveIn + amountIn);
uint256 fee    = (amountIn * reserveOut * swapFeeBps) / (reserveIn * BPS_DENOM);
if (rawOut <= fee) return 0;
```

The effective fee rate is `f · (1 + amountIn/reserveIn)`, so the zero branch is
reached when

```
amountIn / reserveIn  >=  BPS_DENOM/swapFeeBps - 1
```

— roughly **99× the reserve** at a 1% fee, 332× at 30bps. Neither `swap()` nor
`_swapUsdcToToken` / `_swapTokenToUsdc` rejects a zero output, so a caller who
also passes `minAmountOut = 0` has `amountIn` taken and receives nothing.

**Direction of loss:** the *pool* gains and the *caller* loses. This is not an LP
drain — LPs are the beneficiary. It is a caller-side footgun requiring both an
absurd trade size and no slippage protection.

**Why the fee formula itself is safe:** because the fee divides by `reserveIn`
rather than `reserveIn + amountIn`, the effective rate is always `>= swapFeeBps`.
It never *under*charges, which is the conservative direction.

**Fix — APPLIED.** `if (netOut == 0) revert InsufficientOutput();` added to both
`_swapUsdcToToken` and `_swapTokenToUsdc`.

Applying it surfaced a second-order effect worth recording: six
manipulation-safety tests (`ManipulationSafety.ts` grid, `Parametric.ts` named
scenarios) exercise pumps of 100×–500× the LP's USDC — precisely the regime the
guard now rejects. They failed because their harnesses did not expect the swap
leg to revert.

The harnesses were updated to treat a reverting pump as "attack could not be
performed", matching the idiom those files already use for a reverting
`openSide` and a reverting close. **This does not weaken the assertions** — a
revert is strictly stronger than "executed but unprofitable", and the tests
still assert `drains.length == 0`. Suite restored to 394 passing / 8 failing
(the same pre-existing storage-slot failures).

---

### NM-OP5-002 — `factory.deployer()` can force-close every pool

**Severity:** LOW (centralization / griefing — no theft)
**Location:** `EXNIHILOFactory.sol:98` (`deployer`), `:272` (transfer), `EXNIHILOPool.sol` `closePool()`

`closePool()` is callable by the LP holder **or** `factory.deployer()`, a single
mutable EOA. That address can put every market in the protocol into wind-down.

It cannot steal: `closePool` moves no value, positions still settle normally,
LPs still withdraw via `removeLiquidity`. But it is unilateral power over every
LP's market, held by one key that can be transferred (`:272`) or zeroed to
relinquish the role.

**Fix:** if the emergency role is intended to persist, put it behind a timelock
or multisig. If it is a launch-only safety valve, zero it after launch.

---

## Verified sound — custody and conservation

Each of these was traced end-to-end; all are correct.

| Area | Result |
|---|---|
| `claimFees` / `claimProtocolFees` / `claimPayout` | `onlyLpHolder` / treasury-only / per-user `claimable`; CEI (zero-then-transfer); `nonReentrant` |
| `removeLiquidity` | `onlyLpHolder`; blocked while `openPositionCount != 0`; withdraws only backed reserves, leaving fees and `claimable` intact |
| `openPositionCount` | Cannot desync — `++` in the two opens, a single `--` in `_settle`, which is the only exit for every close path |
| `applyRenewal` (PositionNFT) | Gated `msg.sender == pos.pool`; no third party can mutate a position |
| Keeper cannot force-close a live position | `settleExpired` and `closePositionAfterDeadline` both revert `PositionNotExpired` while `block.timestamp < pos.deadline` |
| Keeper cannot bypass auto-renew | `closePositionAfterDeadline` reverts `AutoRenewActive`; `settleExpired` attempts renewal first |
| Auto-renew cannot drain a position | Requires holder opt-in, respects the holder's `maxFee`, and demands `surplus >= totalFee + KEEPER_BOUNTY` |
| Short-branch underflow on renewal | Impossible: a short's `surplus = lockedAmount - cost <= lockedAmount`, so `surplus >= cost` implies `lockedAmount >= cost` |
| Self-close access control | `closeLong` / `closeShort` require `holder == msg.sender` and check `pos.isLong`; all paths check `pos.pool == address(this)` |
| Fee-on-transfer tokens | `_transferIn` measures the balance delta and reverts `FeeOnTransferNotSupported` — closes the inbound half of prior finding ECS-1 |
| DoS-2 (blacklisted holder) | Not regressed. `_trySendUsdc` was replaced by the stronger `_creditPayout` pull-payment; third-party settlement credits `claimable`, only self-close transfers directly |
| `totalClaimable` coupling | `+=` only in `_creditPayout`, `-=` only in `claimPayout`; `totalClaimable == sum(claimable)` holds |
| Open-interest coupling | `longOpenInterest += usdcAmount` on open and `-= pos.airUsdMinted` on settle stay balanced because auto-renew increments **both** by `cost`; shorts touch neither on renewal, matching `-= pos.usdcIn` |
| `addLiquidity` | LP-only, ratio-checked to 1bp, CEI, invariant asserted. Single-LP-per-pool (LP NFT) means no shares and therefore no dilution or first-depositor vector |
| AMM fee direction | Effective swap fee is always `>= swapFeeBps` (see NM-OP5-001) — never undercharges |

---

## `totalShortCollateral` — new accumulator, verified non-desyncable

Added this pass, in response to the observation that `openShort` moves real USDC
out of `backedAirUsd` into the position's `lockedAmount`, where the reserve
invariant stopped tracking it. Untracked collateral meant the invariant passed
whether or not that collateral was still present — it could not detect a leak.

**Exhaustive mutation set.** A short's `lockedAmount` has exactly three mutation
points in `PositionNFT.sol`, and every one is mirrored:

| Mutation | Site | Accumulator |
|---|---|---|
| `mintShort` sets `lockedAmount = airUsdOut` | PositionNFT:270 | `+= airUsdOut` (Pool:700) |
| `applyRenewal` sets a new `lockedAmount` | PositionNFT:304 | auto-renew short: `-= cost` (Pool:1017); manual `renewPosition` passes it unchanged, so no adjustment is required |
| burn on settle | `_settle` | `-= pos.lockedAmount` in both the underwater (Pool:1377) and profitable (Pool:1400) branches |

`mintLong` also sets `lockedAmount`, but for longs it denominates **airToken**,
not USDC, and is correctly excluded.

**Conservation algebra**, profitable-short branch — liabilities move by
`+cost (backedAirUsd) − lockedAmount (accumulator) + closeFee (protocol fees)`.
Since `_priceClose` guarantees `restore + surplus == lockedAmount` exactly
(`restore = cost`, `surplus = lockedAmount − cost`), this reduces to
`−(surplus − closeFee)`, which equals the cash actually paid out. Balanced.
The underwater branch reduces to `−bountyPaid`, also exactly the cash out.

**Empirical verification:**

- Full suite: **394 passing, 8 failing** — the identical 8 pre-existing
  storage-forced `Coverage.ts` failures, no new ones, and **zero
  `ReserveInvariantViolated`** despite the invariant now being strictly tighter
  and asserted on every open/close/renew/settle path.
- On-chain probe: opening 3 shorts moved the accumulator
  `5,939,101 → 14,847,751`, exactly `+8,908,650 = sum(lockedAmount)` of the new
  positions.
- **`slack = 0` at every observation** — `usdcBalance` now equals
  `backedAirUsd + totalShortCollateral + lpFees + protocolFees + totalClaimable`
  exactly. Before the change there was untracked slack equal to the entire short
  collateral.

The invariant is now an exact conservation law rather than a loose lower bound.

---

## Carried forward from prior audits (still accepted)

- **OFL-1 / OFL-2** — flash-loan price manipulation around open/close. Still
  uneconomical, and now *harder*: the newly added OI-integral impact fee makes
  manipulation strictly more expensive than when these were accepted.
- **ECS-1** — rebasing tokens break accounting. The inbound half is now closed by
  `_transferIn`'s delta check; a token that rebases *while held* is still
  unsupported and remains a market-creator responsibility.
- **NM-004** — "anyone-can-renew enables LP exit griefing" is **closed**:
  `renewPosition` now requires `positionNFT.ownerOf(nftId) == msg.sender`.

---

## Scope limits of this pass

Reviewed in depth: `EXNIHILOPool` custody, accounting conservation, access
control, the keeper/auto-renew value flows, the swap math, and `PositionNFT`'s
position-mutation surface.

**Not reviewed in depth:** `EXNIHILOFactory.createMarket` input validation,
`EXNIHILORouter` beyond its fee-quoting path, `LpNFT`, `PoolDeployer`, `Faucet`,
and `PositionNFT`'s SVG/metadata rendering. The 10 non-Nemesis passes from the
prior rounds (DoS, external-call, input-arithmetic, oracle, proxy, reentrancy,
semantic-guard, signature-replay, state-invariant, BSA) have **not** been re-run
against the current source and should be, given PROCESS-001.

---

## Known-failing tests (pre-existing, unrelated)

8 `Coverage.ts` "storage-forced" tests fail because they hardcode a storage slot
map that OpenZeppelin 5.6 invalidated: `ReentrancyGuard` no longer declares a
sequential `uint256 private _status` (it uses a namespaced ERC-7201 slot), so
every pool variable shifted down by one. Confirmed against live storage — slot 0
is `maxPositionUsd` (`0x989680`), and `backedAirToken`/`backedAirUsd` sit at
slots 4/5, not the 5/6 the tests assume. Not a contract defect; the fix is to
decrement the slot map. `totalShortCollateral` was appended at the end of storage
specifically so it does not perturb existing offsets further.
