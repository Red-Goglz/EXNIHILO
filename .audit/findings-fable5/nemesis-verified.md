# N E M E S I S — Verified Findings (Fable 5 re-audit)

**Date:** 2026-07-09
**Model:** Claude Fable 5
**Scope:** `EXNIHILOPool`, `PositionNFT`, `EXNIHILOFactory`, `EXNIHILORouter`, `LpNFT`, `AirToken`, `PoolDeployer`, `Faucet`
**Baselines:** `.audit/findings/` (Sonnet 4.6, 2026-04-04) and `.audit/findings-4.7/` (Opus 4.7, 2026-04-18)
**Method:** Full Nemesis loop — Phase 0 recon → Phase 1 dual mapping → Phase 2 Feynman interrogation → Phase 3 state cross-check → Phase 4 feedback loop → Phase 5 multi-tx tracing → Phase 6 verification. Converged in 3 passes.

---

## Executive result

```
0 CRITICAL | 0 HIGH | 0 MEDIUM | 4 LOW (open) | INFO items unchanged
```

No new critical/high/medium issues. All prior HIGH/MEDIUM remediations from the 4.7 pass
are **confirmed present** in the current source. The single post-audit commit (`fb520ab`,
"fix indexer and pnl") changed only `PositionNFT`'s on-chain SVG / PnL-percent **display**
(a `view` path wrapped in try/catch) — it does **not** touch pool accounting, custody, or
any value-moving code. No regression introduced.

---

## Delta since the last audit

The only contract change after the 4.7 audit is `PositionNFT.sol` (commit `fb520ab`):

- Renamed `P&L` → `PnL` in trait/label strings.
- Added an `Est. PnL %` attribute and an inline `(pct%)` in the SVG, computed as
  `pct = (ld.pnlAbs * 100) / pos.feesPaid`.
- Threaded `Position` into `_svgPnl`.

**Verification of the new code path:**
- Division `(ld.pnlAbs * 100) / pos.feesPaid` is guarded by `pos.feesPaid > 0` in both
  `_buildAttributes` (L203) and `_svgPnl` (L521); no divide-by-zero.
- `ld.pnlAbs` and `pos.feesPaid` are ≤ ~1e18 scale; `* 100` cannot overflow uint256.
- Entire `_readLive` chain is wrapped in try/catch, and `tokenURI` is `view` — it cannot
  revert a state-changing call or affect pool state. **SOUND.**

---

## Confirmed-present remediations (4.7 → now)

| Prior finding | Fix expected | Present in current code? |
|---|---|---|
| SI-001 / ECS-2 / NM-008 (HIGH/MED: `_trySendUsdc` strands funds, USDT no-return) | low-level `call` + returndata-length check; failed amount → `lpFeesAccumulated` | ✅ `EXNIHILOPool.sol:1368–1378` |
| NM-006 / IA-10 / OFL-4 (MED: router OI-race + permissionless `sweep`) | `_refundResidual` on all 4 entry points; `sweep()` deleted | ✅ `EXNIHILORouter.sol:93–98,112,127,146,162` — no `sweep` on ABI |
| SGA-2 / IA-8 (MED: `closeShort` underflow panic) | guard `airUsdSupply < pos.lockedAmount` | ✅ `EXNIHILOPool.sol:820` |
| OFL-3 (MED: no swap-fee floor enables flash arb) | `MIN_SWAP_FEE_BPS = 100`, enforced in constructor | ✅ `EXNIHILOPool.sol:180, 385` |
| IA-7 / NM-007 (setDeployer(0)) | documented as deliberate permissionless handoff | ✅ `EXNIHILOFactory.sol:262–276` |

---

## Independent re-derivation of core solvency (Phase 5)

I re-proved the two load-bearing invariants from scratch rather than trusting the prior write-ups.

**Reserve invariant `backedAirX ≤ airX.totalSupply()`** — holds across every mutation path.
Key non-obvious cases verified:
- `realizeLong` burns `lockedAmount` airToken while leaving `backedAirToken` untouched.
  Slack is guaranteed because `totalSupply − backedAirToken = syntheticShort + longsLockedInNFT
  ≥ this position's lockedAmount`, so `backedAirToken ≤ totalSupply − lockedAmount` after burn. ✅
- `openShort` synthetic `airToken.mint` grows supply, `backedAirToken` unchanged → slack grows. ✅
- `realizeShort` `backedAirToken += airTokenMinted` matches the supply the synthetic mint
  already added at open → invariant preserved. ✅

**USDC solvency `poolUSDC = backedAirUsd + lpFeesAccumulated + Σ(short_locked)`** — holds through
open/close/realize/expire and the `_trySendUsdc` failure branch. Verified the failure branch is
self-balancing: `backedAirUsd −= surplus` is exactly offset by `lpFeesAccumulated += (netSurplus + closeFee)`
when both sends fail, and by the partial equivalents when only one fails. ✅

**Fee accounting** — for every open/renew path, the net USDC pulled into the pool
(`totalFee − protocolFee`) equals the `lpFee` credited to `lpFeesAccumulated`, including the
`MIN_POSITION_FEE` floor branch and the additive `impactFee`. ✅

**Open-interest counters** — `longOpenInterest`/`shortOpenInterest` increments at open exactly
match the decrement values at every close/realize/expire path (`airUsdMinted == usdcAmount` for
longs; `usdcIn == usdcNotional` for shorts). No drift. ✅

**closeShort proportional-cost math** — `airUsdCostForDebt = ceil(lockedAmount·airTokenMinted/totalBuyable)`
cannot exceed `lockedAmount` given the `totalBuyable ≥ airTokenMinted` guard, so `surplus` never
underflows; concavity of the CP curve makes the estimate conservative (pool never overpays). ✅

---

## Open findings (all LOW — carried forward, unchanged severity)

These were already documented and accepted/deferred in prior passes. Re-confirmed still open:

| ID | File | Note |
|----|------|------|
| NM-001 | `PositionNFT.sol:231–232` | `mint*` callable in the pre-`initFactory` window (`factory==0` skips the pool check). Mitigated by atomic deployment; fake NFTs can't touch real pools. Still unfixed in code. |
| NM-002 | `EXNIHILOFactory.sol:243–246` | `forceApprove` residuals not cleared after `addLiquidity`. Defense-in-depth only; factory holds no tokens between calls. |
| NM-003 | `EXNIHILOPool.sol:1045` | No caller incentive for `closePositionAfterDeadline`. Mitigated — LP self-triggers before `removeLiquidity`. |
| NM-004 | `EXNIHILOPool.sol:997` | Anyone-can-renew enables LP-exit griefing; countered by `closePool()` forced expiry. |

Plus the standing accepted items: ECS-1 (rebasing/FoT tokens are the creator's token-choice risk),
IA-6 (>38-decimal tokens overflow `_cpAmountOut` — pathological), RE-1 (theoretical ERC-777 read-only
reentrancy), DoS-1 (rotatable blacklisted treasury), OFL-1/2 (uneconomical flash-loan arb at the
100 bps floor), PU-001 (`PoolDeployer.deploy` has no `onlyFactory` guard — orphan-pool spam, no
fund path).

### Faucet.sol (testnet-only, first time in scope)
`Faucet` is a testnet MockUSDC/AVAX dispenser. `owner` is a plain address with no two-step transfer,
`claim()` sends AVAX via low-level `call` after the cooldown state write (CEI-correct, no reentrancy
benefit). No production-fund exposure. **INFO only — not deployed to mainnet.**

---

## Conclusion

The EXNIHILO contracts remain in the same strong state the 4.7 pass left them: strict CEI,
`nonReentrant` on all state-changing externals, a runtime `_assertReserveInvariant()` after every
value move, `_transferIn` balance-delta rejection of non-standard tokens, and a single-LP-NFT model
that avoids share-accounting rounding attacks. The post-4.7 change is display-only and introduces no
new risk. The four open LOWs are design tradeoffs or deployment hygiene, none threatening user funds.

**No action required for fund safety. Optional hygiene fixes: NM-001 (require `factory != 0` before
mint) and NM-002 (clear factory approvals) remain the cheapest defense-in-depth wins.**
