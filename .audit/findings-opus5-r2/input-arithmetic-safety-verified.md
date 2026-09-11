# Input & Arithmetic Safety — Verified (Opus 5 R2)

**Date:** 2026-08-20
**Baseline:** `.audit/findings-opus5/` @ `5197494`; tree audited = branch `mainnet-launch`, HEAD `c02af1d` plus uncommitted working-tree contract changes (per `SCOPE.md`).
**Scope actually covered:** `PreMarket.sol` (whole file — first audit), `PreMarketFactory.sol`, `LockedLpVault.sol`, `EXNIHILOPool.sol` ramps / renewal margin / fee split / `_cpAmountOut` / `_quoteShortfall` / settlement-guard arithmetic, `EXNIHILOFactory.createMarket` validation, `PositionNFT._netReturn`, plus a sweep of the site, indexer, docs and SDK for stale fee-ratio assumptions.

```
0 CRITICAL | 0 HIGH | 2 MEDIUM | 5 LOW | 6 INFO
```

Every claim below was executed against a local Hardhat fork of the working tree
before being written down. Probe files were deleted afterwards; the console
output is quoted inline where it is the evidence.

---

## IA-R2-1 — `token == usdc` seeds fine and then bricks `buyout()` permanently

**Severity:** MEDIUM
**Category:** Missing input validation → unrecoverable strand
**Where:** `packages/blockchain/contracts/PreMarketFactory.sol:120-121`, `packages/blockchain/contracts/PreMarket.sol:302-314`, `packages/blockchain/contracts/PreMarket.sol:515-519`, `packages/blockchain/contracts/EXNIHILOFactory.sol:196`

`EXNIHILOFactory.createMarket` gained a new guard this round:

```solidity
if (tokenAddress == usdc) revert TokenIsUsdc();   // EXNIHILOFactory.sol:196
```

`PreMarket.buyout()` is the only exit from a premarket, and it calls
`factory.createMarket(address(token), usdcIn, tokenOut)` at line 515. Nothing
on the premarket side mirrors the new check: `PreMarketFactory.createPreMarket`
validates only `token != 0`, `quote != 0`, `tokenAmount != 0`, `quoteAmount != 0`
(lines 120-121), and `PreMarket`'s constructor validates six addresses, both
amounts, `usdc == factory.usdc()`, `startPrice != 0` and the decay bounds
(lines 302-314) — but never `token != usdc`.

This directly contradicts the contract's own stated design rule
(`PreMarket.sol:107-109`):

> Market parameters are validated at seed time, not at buyout. With no expiry
> path, a pool constructor revert during buyout would strand the premarket's
> liquidity permanently rather than merely delaying it.

**Exploit / failure path** (executed, output verbatim):

1. `createPreMarket({ token: USDC, tokenAmount: 5000e6, quote: WAVAX, quoteAmount: 500e18, … })`
   — succeeds. `token reserve seeded: 5000000000`, `quote reserve seeded: 500000000000000000000`,
   `real USDC held by premarket: 5000000000`.
2. `buyout(MaxUint256, 0)` → reverts `TokenIsUsdc`.
3. Advance one year → still reverts.
4. The premarket's entire external surface is
   `buyout, buyoutCost, creator, currentPrice, decayBpsPerMinute, factory, getAmountOut,
   integrator, launchUsdc, launched, launchedPool, lpOwner, lpVault, quote, quoteReserve,
   quoteUnit, startPrice, startTime, swap, swapFeeBps, token, tokenReserve, usdc`
   — no withdraw, refund, rescue, expiry or owner. Both legs are lost forever.

The same brick reaches through a second door: if `token == usdc`, the two
`forceApprove` calls at `PreMarket.sol:512-513` write the *same* allowance slot,
so the second overwrites the first and `createMarket`'s second `safeTransferFrom`
fails on an exhausted allowance. One root cause, two ways to hit it.

**Why I believe it:** reproduced end to end. Loss is 100 % of both legs, is not
partial, and has no recovery mechanism anywhere in the contract graph.

**Why MEDIUM and not higher:** the loss is confined to the seeder's own assets
and requires a nonsensical configuration. Nothing is stealable by a third party.
But it is a silent, total, irreversible trap on a permissionless entry point, and
the contract explicitly promises that this class cannot happen.

**Fix:** add `if (p.token == usdc) revert TokenIsUsdc();` to
`PreMarketFactory.createPreMarket` (it already holds `usdc` as an immutable, read
from the market factory at line 102), or mirror it in `PreMarket`'s constructor
next to the existing `UsdcMismatch` check. Consider also rejecting
`p.token == p.quote`.

---

## IA-R2-2 — `startPrice == 1` lets the seeder buy their own quote leg back for $1

**Severity:** MEDIUM
**Category:** Insufficient bounds on a value-controlling parameter
**Where:** `packages/blockchain/contracts/PreMarket.sol:313` (`InvalidPriceRange`), `:354-358` (`currentPrice`), `:379-382` (`_buyoutCost`), `:156` (`MIN_BUYOUT_USDC`), `:480` (`buyout` — no access control)

`InvalidPriceRange` is a name with no range behind it:

```solidity
if (c.startPrice == 0) revert InvalidPriceRange();   // PreMarket.sol:313
```

`startPrice == 1` is accepted. At `elapsed == 0` the drop is 0, so
`currentPrice() == 1`, and `_buyoutCost` gives
`priced = quoteOut × 1 / quoteUnit`, which floors to 0 for any 18-decimal
reserve below 1e18 whole units — clamped up to `MIN_BUYOUT_USDC` = $1.
`buyout()` has no access control and no cooldown, so the seeder can take it in
the very next block.

**Executed** (verbatim console output):

```
buyoutCost immediately after seeding: 1000000 USDC atoms for 500000000000000000000 quote
launchpad quote delta: 0 (seeded 500000000000000000000)
launchpad usdc  delta: -1000000
launched pool backedAirUsd  = 1000000
launched pool backedAirToken= 1000000000000000000000000
launched pool cap now       = 10000 (MIN_POSITION_FEE = 50000)
LP NFT owner = 0x64e2…7F56 (vault 0x64e2…7F56)
```

The seeder recovered all 500 WAVAX for $1. The "locked" market opened with
1,000,000 tokens against **$1** of USDC backing. Its day-0 leverage cap is
10,000 atoms ($0.01) — below `MIN_POSITION_FEE` ($0.05) — so no position can
ever be opened in it.

**Why this matters.** The contract header (`PreMarket.sol:73-79`) claims:

> Seeding is irreversible. There is no withdrawal, refund or expiry path … A
> launchpad can verify from the bytecode that its liquidity cannot be pulled back
> out, by anyone, ever.

That holds for the **token** leg — it goes into the pool and the LP NFT goes
straight to a `LockedLpVault`. It does **not** hold for the **quote** leg, which
is exactly the leg a launchpad bonds real value in. `startPrice` is the seeder's
own dial for how cheaply their quote comes back, and `MIN_BUYOUT_USDC` puts a
$1 floor under it. The docstring at `:174-177` acknowledges the risk of
underpricing as *"the reserve is sniped at that number"* — as harm to the
seeder from third parties. It does not consider the seeder as the sniper.

**Why MEDIUM:** no EXNIHILO LP or trader loses anything; the harmed party is
downstream of the protocol boundary (the launchpad's own users, who were told
liquidity was locked). But it is precisely the "can a pre-market seeder extract
more than their share?" question in `SCOPE.md`, and the answer is yes, for the
whole quote leg, at a price they choose.

**Fix options** (coordinator's call): a floor on `startPrice` relative to
`quoteUnit`; a minimum time between `createPreMarket` and a `buyout` by
`creator`; or — least invasive and honest — amend the header so the guarantee is
scoped to the token leg and `startPrice` is documented as the trust assumption
it is. Note that a floor on `startPrice` alone is not sufficient: the decay
reaches 1 unit in `BPS_DENOM × 60 / decayBpsPerMinute` seconds (60 s at the
maximum legal rate), after which the same self-buy is available at
`MIN_BUYOUT_USDC` regardless of `startPrice`.

---

## IA-R2-3 — `startPrice` has no upper bound; `currentPrice()` overflows and bricks the buyout

**Severity:** LOW
**Category:** Unbounded input → arithmetic overflow → unrecoverable strand
**Where:** `packages/blockchain/contracts/PreMarket.sol:313`, `:356`

```solidity
uint256 drop = (startPrice * decayBpsPerMinute * elapsed) / (BPS_DENOM * 60);
return drop >= startPrice ? 1 : startPrice - drop;
```

The `drop >= startPrice` guard correctly prevents underflow, and multiply-before-
divide is correct. But the guard is evaluated *after* the product, and `elapsed`
grows without bound while `startPrice` has no ceiling. `currentPrice()` reverts
permanently once

```
startPrice × decayBpsPerMinute × elapsed  ≥  2²⁵⁶
```

`buyout()` calls `currentPrice()` at line 491, so the premarket becomes
unbuyable — and, as in IA-R2-1, there is no other exit.

**Executed:** `startPrice = 2²⁵⁶ / 1e6 = 1.1579e71`, `decayBpsPerMinute = 10000`.
Constructor accepted it. `currentPrice()` returned normally at elapsed = 1, 50,
99, 100; **reverted at elapsed = 101**, and `buyout()` reverted with it. Reserves
stranded.

**Reachability:** for a premarket to survive N seconds you need
`startPrice < 2²⁵⁶ / (decayBpsPerMinute × N)`. At the intended
`decayBpsPerMinute = 200` and a 10-year horizon that is `startPrice < 1.8e66`
— i.e. $1.8e60 per whole quote unit. No honest configuration comes within 55
orders of magnitude. LOW, and self-inflicted, but the fix is one line
(`if (c.startPrice == 0 || c.startPrice > SOME_MAX) revert InvalidPriceRange();`)
and it makes the error name true.

---

## IA-R2-4 — the site still books protocol revenue at the old 200 bps

**Severity:** LOW
**Category:** Stale ratio after the fee-split change (off-chain only)
**Where:** `packages/site/src/components/trade/LongShortPanel.tsx:19` and `:238`; `packages/site/src/pages/FeedPage.tsx:446`

```ts
const PROTOCOL_FEE_BPS = 200n;                      // LongShortPanel.tsx:19
const protocolFeeRaw = (usdcRaw * PROTOCOL_FEE_BPS) / 10_000n;   // :238
const protocolFeeRaw = (usdcRaw * 200n) / 10_000n;  // FeedPage.tsx:446
```

`PROTOCOL_FEE_BPS` is now **100**. Both sites feed the `revenue:` field of an
analytics event, so every position open is reported at **2× the protocol's
actual take**. No contract effect and no user-facing number is wrong — but any
revenue dashboard built on this event is wrong by a factor of two, and this is
the only place in the repo that still hard-codes the old ratio in executable code.

**Everything else is consistent.** Verified `LP_FEE_BPS = 400` / `PROTOCOL_FEE_BPS = 100`
sum to 500 at every use site: `EXNIHILOPool.sol:1743-1749`, `packages/sdk/src/constants.ts:16-22`,
`packages/docs/protocol/fees.md:13,53,92-93`, `packages/docs/lp/fees.md:43-49`,
`packages/docs/trading/opening-a-{long,short}.md`, and all thirteen test files.
The indexer correctly does **not** derive the split from bps — it diffs the pool's
own lifetime accumulators (`packages/indexer/src/index.ts`, `syncFees`) — so it is
unaffected. Its comment at `src/index.ts:73` still says "3%/2%" but the code is right.

**Stale comments only** (no code effect): `LockedLpVault.sol:40` and `:65` both
say the LP stream is "3 % of notional"; `packages/blockchain/scripts/deployLocal.ts:14`
says the treasury "receives 2% protocol fee".

---

## IA-R2-5 — a quote token without `decimals()` prices its whole reserve at the $1 floor

**Severity:** LOW
**Category:** Mixed-decimal precision loss on an un-overridable inferred parameter
**Where:** `packages/blockchain/contracts/PreMarketFactory.sol:126-131`, `packages/blockchain/contracts/PreMarket.sol:324`, `:380`

`PreMarketFactory` infers the quote's decimals and falls back to 18 when
`decimals()` is absent or reverts. `quoteUnit = 10 ** quoteDecimals` is then
immutable (`PreMarket.sol:324`) and divides the buyout price
(`priced = quoteOut * price / quoteUnit`, `:380`). The seeder cannot override it —
it is read, never supplied.

For a quote asset that is genuinely 6-decimal but does not expose `decimals()`,
the fallback overstates `quoteUnit` by 1e12:

```
priced with true 6 dec      : 30000000000 USDC atoms  ($30,000)
priced with 18-dec fallback : 0  ->  clamped to MIN_BUYOUT_USDC ($1)
```

A $30,000 reserve becomes buyable for $1 from the first second of the auction.
Recoverable if the seeder knows to scale `startPrice` up by 1e12 (there is no
upper bound to stop them — see IA-R2-3), but nothing surfaces the mismatch, and
the `Seeded` event does not carry `quoteDecimals`.

**Fix:** accept `quoteDecimals` as a caller parameter cross-checked against the
`try` result, or emit it in `PreMarketCreated` so a seeder can verify before the
auction opens.

---

## IA-R2-6 — `LockedLpVault` split truncation gives the integrator zero on dust harvests

**Severity:** LOW
**Category:** Rounding direction / dust
**Where:** `packages/blockchain/contracts/LockedLpVault.sol:225-226`, `:317-326`

```solidity
uint256 integratorCut = (amount * integratorBps) / BPS_DENOM;
uint256 lpCut         = amount - integratorCut; // dust favours the LP
```

The integrator's cut floors; the LP takes the remainder. `harvest()` is
permissionless and `amount` is measured as *unearmarked balance*, so any USDC
sent directly to the vault is harvestable — which means the harvest size is
attacker-chosen, not fee-driven.

**Executed** with `integratorBps = 5000` (the value `PreMarket` hard-wires at
`PreMarket.sol:136`):

```
after 100x(1 atom donate + harvest):  lpAccrued=100  integratorAccrued=0   harvestedTotal=100
after one 100-atom donation:          lpAccrued=150  integratorAccrued=50
```

100 atoms split 100/0 when fed one at a time, and 50/50 in one shot. The
truncation is complete, not partial, below 2 atoms.

**Why it is only LOW.** The vault's real income cannot be chunked: `_harvest`
calls `pool.claimFees(address(this))`, which drains the pool's whole
`lpFeesAccumulated` in one transfer — there is no way to make the pool pay out
1 atom at a time. And the pool's minimum LP accrual is `MIN_POSITION_FEE × 4/5`
= 40,000 atoms, which splits exactly. So the leak is confined to donated dust,
costs the griefer ≥ 1 atom plus a full `harvest()` gas bill to deny ≤ 1 atom,
and is deeply gas-negative. Damage is bounded at 1 atom per harvest.

`pending()` (`:317-326`) computes the integrator cut from the *combined*
unharvested total, so it over-reports the integrator by up to 1 atom per
harvest that will actually intervene. Display only.

**Fix (optional):** carry the remainder forward, or round the integrator cut up
and give the LP the remainder — either kills the asymmetry. Not worth a redeploy
on its own.

---

## IA-R2-7 — every claim path calls `_harvest()`, so one revert locks both parties out

**Severity:** LOW
**Category:** Unguarded subtraction on an unconditional code path
**Where:** `packages/blockchain/contracts/LockedLpVault.sol:212-233`, `:244-258`, `:265-279`, `:317-326`

```solidity
amount = usdc.balanceOf(address(this)) - lpAccrued - integratorAccrued;   // :221
```

The comment is correct that this cannot underflow *from this contract's own
operations*: after any `_harvest`, `lpAccrued + integratorAccrued == balance`
exactly, and each claim decrements the accrued side and the balance by the same
amount. I verified the invariant across `harvest`, `claimLpFees` and
`claimIntegratorFees`, including their ordering.

It is only safe as long as the balance never falls by any other means.
`claimLpFees` (`:248`) and `claimIntegratorFees` (`:269`) both call `_harvest()`
**unconditionally, before reading their own accrued balance**, so if
`_harvest()` ever reverts — the subtraction underflowing on a seizing or
rebasing-down quote asset, or `pool.claimFees` reverting because the vault does
not hold the LP NFT — then *already-accrued, already-owned* balances become
permanently unclaimable by both parties. `pending()` reverts with it.

Not reachable with Circle USDC on Avalanche (blacklisting freezes, it does not
seize), and `PreMarket.buyout` always funds the vault in the same transaction it
deploys it. But a stand-alone `LockedLpVault` can be deployed by anyone against
any pool, and its constructor does not require the NFT to have arrived (it says
so at `:176-179`). **Fix is free:** let the claim functions tolerate a failed
harvest (`try`/`catch` around `_harvest()`, or split `claimX` from `harvest`).

---

## Carried findings from `.audit/findings-opus5/`

### IA-3 (LOW, open) — open fees round down; mitigated by `MIN_POSITION_FEE`. **Still holds, mitigation re-verified under the new split.**

`_baseFees` (`EXNIHILOPool.sol:1738-1751`) floors both shares, but the
`MIN_POSITION_FEE` clamp means no position pays zero. I re-checked the floor
split under the new 400/100 weights:

```
protocolFee = 50000 × 100 / 500 = 10000
lpFee       = 50000 − 10000     = 40000
sum         = 50000             = MIN_POSITION_FEE   (exact, no dust)
```

The `PROTOCOL_FEE_BPS + LP_FEE_BPS` denominator at line 1748 divides
`MIN_POSITION_FEE` evenly under both the old ratio (20000/30000) and the new one,
so the change introduced no rounding dust. Unchanged; keep IA-3 open as a
documented, mitigated rounding note.

### IA-6 (LOW, open) — ">38 decimals can overflow `_cpAmountOut`". **The threshold in the previous report is wrong by ~26 orders of magnitude. Recommend downgrading to INFO.**

The previous round stated tokens above 38 decimals overflow `_cpAmountOut`.
That would be true if both factors of `amountIn * reserveOut` were token-scale.
They never are. Every call site pairs a USDC-scale factor with a token-scale one:

| Call site | `amountIn` | `reserveOut` |
|---|---|---|
| `_swapTokenToUsdc` (`:1473`) | token | USDC |
| `_swapUsdcToToken` (`:1507`) | USDC | token |
| `openLong` (`:639`) | USDC | token |
| `openShort` (`:773`) | token | USDC |
| `_priceClose` long (`:1564`) | token | USDC |
| `_priceClose` short (`:1578`) | USDC | token |
| `_quoteShortfall` (`:1408`) | USDC | token |

So the binding constraint is `usdcTradeSize × tokenReserve × 100 < 2²⁵⁶`, not
`tokenReserve²`.

**Measured** (100,000 USDC seed, 1,000 whole tokens, a $1,000 swap and a $100 long):

| token decimals | `createMarket` | USDC→token swap | `openLong` | `spotPrice` |
|---|---|---|---|---|
| 36, 38, 40, 50, 60 | OK | OK | OK | OK |
| 64 | OK | **arith revert** | OK | OK |
| 66 | OK | arith revert | **revert** | OK |
| 68, 70, 72 | OK | arith revert | revert | **revert** |

38 decimals is entirely fine. The real boundary is ~64 decimals at these reserve
sizes — for an 18-decimal token it would need a reserve above 1.16e48 *whole*
tokens. No ERC-20 in existence is close, and `createMarket` cannot even be given
such an amount from a normal client (ethers rejected 1e43 as out of `uint256`
range in my probe at 77+ decimals).

**Does the new factory validation change it?** No. `TokenIsUsdc` and `ZeroAmount`
(`EXNIHILOFactory.sol:196-197`) bound neither `decimals()` nor reserve
magnitude, and `tokenDecimals` still comes from an unbounded
`try IERC20Decimals(tokenAddress).decimals()` with an 18 fallback
(`:209-214`). A `decimals()` of 78 or more would additionally revert
`10 ** uint256(tokenDecimals)` in `spotPrice`/`_longPrice`/`_shortPrice` — but
those three are view-only (`_longPrice`/`_shortPrice` are reached only from
`indexerState`, `longPrice()`, `shortPrice()`; grep confirms no state-changing
caller), so even that only breaks display and indexing, never settlement.

Every failure mode is a revert, never a silent wrap. **Recommend: reclassify
IA-6 as INFO with the corrected threshold, and record that a `decimals()` bound
in `createMarket` is cosmetic rather than protective.**

### IA-4 / IA-5 (INFO) — unchanged and still immaterial.
### ECS-1 inbound half — still closed. `_transferIn` (`:1844-1850`), `PreMarket._pullExact` (`:555-561`) and `PreMarketFactory._pullExactTo` (`:176-182`) all use the exact-delta form.
### INFO-IA-1 / NM-005 — `createMarket` token validation. Partially addressed: `ZeroAddress`, `TokenIsUsdc`, `ZeroAmount` are new (`EXNIHILOFactory.sol:195-197`). The `decimals()` try/catch is unchanged and a hostile token is still accepted. Self-inflicted for the creator; a frontend allowlist is still the right answer.

---

## INFO

**INFO-1 — `_quoteShortfall`'s magnitude never reaches the certificate.**
`quoteClose` now returns `-int256(_quoteShortfall(pos))` when unpriceable
(`EXNIHILOPool.sol:1387`), and the doc comment says the certificate can show it.
It cannot: `PositionNFT._netReturn` (`PositionNFT.sol:200-216`) floors `payout`
at zero, so an unpriceable position always renders exactly `-premium / -100 %`
regardless of the shortfall value. The shortfall is used only as a *readiness*
signal (`ld.pnlReady = ready || pnl != 0`, `:444`) — flipping "N/A" to
"-100 %". The behaviour is right; the comment overstates it. Display-only,
inside `try`/`catch`, no accounting reach.

**INFO-2 — `settlementGuardArmingSize()` understates the real threshold by up to 1 atom.**
The view returns `(backedAirUsd * SETTLE_GUARD_BPS) / BPS_DENOM` (`:1212`, floored),
while `_armSettlementGuard` tests `usdcValue * BPS_DENOM >= backedAirUsd * SETTLE_GUARD_BPS`
(`:1438`, exact). With `backedAirUsd = 150` the view says 1 but a swap of 1 does
not arm. Keeper diagnostics only.

**INFO-3 — arming threshold is direction-asymmetric by one swap fee.**
`_swapTokenToUsdc` arms on `netOut` (fee-deducted, `:1482`) while
`_swapUsdcToToken` arms on `amountIn` (gross, `:1515`). Both are "the USDC leg",
but a token→USDC swap needs ~1 % more gross size to arm. Immaterial against a
100 bps threshold; noting it so it is not rediscovered.

**INFO-4 — the decay curve lands on the floor as a cliff, not a taper.**
At `decayBpsPerMinute = 200`, measured `price = 20000` at elapsed 2999 and
`price = 1` at elapsed 3000 — a 20,000× drop in one second, and `buyoutCost`
falls to `MIN_BUYOUT_USDC` with it. Harmless in practice (the reserve is already
99.97 % discounted by then), but it is a discontinuity a bidder's off-chain model
will not reproduce if it interpolates.

**INFO-5 — USDC donated to a `PreMarket` is stranded.**
`buyout` approves and hands over exactly `usdcIn` (`:513`, `:515`) and has no
sweep. Any USDC sitting in the premarket beforehand stays there after launch.
Trivial amounts, no exploit, but there is no owner to recover it.

**INFO-6 — day-0 cap can sit below the minimum fee.**
`currentMaxPositionBps()` starts at 100 bps, so a market with
`backedAirUsd < ~$5` has a leverage cap below `MIN_POSITION_FEE` ($0.05) and
literally cannot host a position. Measured on the IA-R2-2 market:
`cap = 10000` atoms vs `MIN_POSITION_FEE = 50000`. Below roughly $100 of opening
USDC depth the floor fee exceeds 5 % of the largest legal position on day 0.
Usability, not safety.

---

## Checked and found clean

**Overflow / underflow.** Still zero `unchecked` blocks across all nine
contracts (`grep -rn "unchecked" contracts/*.sol` → no matches, including the
three new files). Every decrement I traced reverts rather than wraps.

**The PreMarket round trip is strictly lossy — proven, not just tested.**
`getAmountOut` (`PreMarket.sol:395-403`) is the Uniswap-V2 form with the fee on
the input. Writing `a = 1 − swapFeeBps/BPS_DENOM = 0.99`, floor division gives
`y ≤ a·x·R_q/(R_t + a·x)`, hence
`(R_t + x)(R_q − y) ≥ k·(R_t + x)/(R_t + a·x) > k` for any `x > 0`. A round trip
returns the output side to `R_q` exactly, so `k'' = (R_t + x − x')·R_q > R_t·R_q`
forces `x' < x` **strictly, at every reserve ratio, in both orderings, and
independently of the auction clock** — the decay does not enter `getAmountOut`
at all. Floor division only widens the margin. I also swept it empirically over
`{1, 2, 3, 10, 1000, 1e12, 1e12, 1e18, 1e21, 1e23, 1e25}` in both directions:
every size either lost value or returned 0 and was rejected by the `ZeroOutput`
guard at `:430`. Dust cannot round-trip for free; the smallest token→quote input
that produces non-zero output is ~1e12 wei against the seeded ratio.

The composed round trip (swap → buyout → trade in the launched pool) is also
lossy: the buyout rescales the quote axis by the constant `price/quoteUnit`, so
the pool's curve continues the premarket's, and the return leg pays
`EXNIHILOPool._cpAmountOut`'s fee — which is *larger* than the V2 fee for the
same size, because it divides by `reserveIn` rather than `reserveIn + amountIn`.
Analytically, a "dump then buy out cheap" attack nets
`fQ·[P − P_true/(0.99(1−f))]` against the honest baseline, which is negative for
every `f ∈ (0,1)` whenever the auction price `P` is at or below spot — the 1 %
swap fee exactly cancels the intended 1 % start premium, and CP slippage is
superlinear in `f` while the auction discount is linear.

**Decay-curve bounds.** `currentPrice()` cannot underflow (`drop >= startPrice`
guard, `:357`), cannot reach 0 (floors at 1), and is monotone non-increasing.
Measured at every legal decay rate: 100 %/min floors at exactly elapsed 60,
2 %/min at 3000, 0.01 %/min (the minimum) at 600 000 (~6.9 days). `startPrice = 1`
yields `price = 1` from the first second. `InvalidDecayRate`'s bounds
(`0 < d ≤ BPS_DENOM`, `:314`) do keep the curve well-behaved; the gap is on the
price side (IA-R2-2, IA-R2-3). Rounding directions are correct and opposed:
`drop` floors so `currentPrice` rounds **up** (favours the premarket), `priced`
floors so the cost rounds **down** (favours the buyer). Combined error ≤ 1 USDC
atom.

**`_buyoutCost` mixed decimals.** `quoteOut * price / quoteUnit` is
multiply-before-divide with a single truncation. Verified against the repo's own
6-decimal-quote test (`test/PreMarket.ts:1349`) and re-derived: truncation is
bounded at 1 USDC atom for any `quoteDecimals`. The only pathology is the
inferred-decimals mismatch (IA-R2-5), not the arithmetic.

**Cap ramp — every boundary walked.** `currentMaxPositionBps()`
(`EXNIHILOPool.sol:1290-1295`) with `createdAt = block.timestamp` set in the
constructor (`:552`), so `elapsed` can never underflow. Measured:

```
age=0      capBps=100    (CAP_START_BPS, exact)
age=1      capBps=100
age=3599   capBps=179
age=3600   capBps=179    (cap ramp is continuous across duration steps)
age=28799  capBps=733
age=86398  capBps=1999
age=86399  capBps=1999
age=86400  capBps=2000   (CAP_MAX_BPS, exact at the threshold)
age=86401  capBps=2000
age=2^31   capBps=2000   (68 years — no drift, no overflow)
```

Multiplication order is correct (`(CAP_MAX_BPS − CAP_START_BPS) * elapsed` before
the divide) and `1900 × elapsed < 1.64e8` inside the ramp — it cannot overflow.
Against a large `backedAirUsd`: `_checkLeverageCap` (`:1829`) and
`effectiveLeverageCap()` (`:1325`) compute `backedAirUsd × 2000` before dividing,
which overflows only above 5.79e73 USDC atoms — 57 orders of magnitude past
USDC's entire supply. Clean.

**Duration ramp — every boundary walked.**

```
age=0/1/3599 → 3600      age=3600/28799 → 28800
age=28800    → 86400     age=86400/604799 → 604800
age=604800   → 2592000   age=2^31 → 2592000
```

Thresholds are exclusive (`age < DURATION_AGE_n`), so at exactly each boundary
the caller gets the **longer** duration — non-decreasing, which is the property
`closePool` (`:511`) depends on. Since `duration(t)` is non-decreasing and
`openTime ≤ now`, `openTime + duration(openTime) ≤ now + duration(now) = closeDate`
for every outstanding position, so the "all expired by closeDate" guarantee
holds. Renewal paths respect it too: `renewPosition` rejects
`newDeadline > closeDate` (`:1008`) and `_autoRenewQuote` refuses when
`block.timestamp + currentPositionDuration() > closeDate` (`:1105`) — the same
expression `_tryAutoRenew` then uses for `newDeadline` (`:1122`), so the two
cannot disagree within a block.

**`RENEW_MARGIN_BPS` and `_quoteShortfall` — the specific question asked.**

`margin = ((n + surplus) * RENEW_MARGIN_BPS) / BPS_DENOM` (`:1101`).

- *Can it overflow?* `n` and `surplus` are USDC-scale and bounded by pool
  reserves; `×200` is 57 orders from the ceiling. No.
- *Can it round to zero and let a position renew that cannot pay?* **No — and
  the reason is structural, not incidental.** `margin == 0` requires
  `n + surplus < 50`. But `_baseFees` clamps `totalFee ≥ MIN_POSITION_FEE`
  = 50,000 on every path (`:1746-1750`), and the gate is
  `if (surplus < totalFee + margin) return false` (`:1102`). So any renewal
  needs `surplus ≥ 50,000`, which forces `n + surplus ≥ 50,000` and therefore
  `margin ≥ 1,000`. The margin is never zero on any path that could renew. I
  swept `n, surplus ∈ [0, 200)` to confirm the only `margin == 0` region is
  disjoint from the renewable region.
- *Can it block a position that can pay?* Yes, deliberately, by 2 % of mark —
  documented at `:1080-1086`, and the position is paid its surplus on the close
  instead. Not a defect.
- *Underflow on the charge?* `_tryAutoRenew` (`:1116-1151`) is reached only when
  `surplus ≥ totalFee + margin`. For a long, `surplus < backedAirUsd` (it is
  `airUsdOut − airUsdMinted` with `airUsdOut < backedAirUsd`), so
  `backedAirUsd -= cost` (`:1131`) cannot underflow. For a short,
  `surplus = lockedAmount − buybackCost ≤ lockedAmount`, so `cost ≤ lockedAmount`
  and both `pos.lockedAmount - cost` (`:1142`) and
  `totalShortCollateral -= cost` (`:1140`) are safe. `airUsdSupply ≥ lockedAmount`
  is already established by `_priceClose`'s `priceable` gate, which
  `surplus > 0` implies.

`_quoteShortfall` (`:1404-1418`): division guarded by the `totalBuyable == 0`
early return, ceil-divide matches `_priceClose`, `cost > lockedAmount ? … : 0`
cannot underflow. Product magnitudes are the same class as IA-6 and equally
unreachable. It is view-only and reached only through `quoteClose`, itself
wrapped in `try`/`catch` at `PositionNFT.sol:441`.

**`_cpAmountOut` ceil-fee change (new this round).** The fee is now rounded up
(`:1722`) instead of floored. Direction verified correct at every caller: a
larger fee means a smaller `airUsdOut` for a long and a smaller `totalBuyable`
(hence a larger ceil-divided `cost`) for a short — the pool never overpays. The
`feeNum == 0` short-circuit only triggers on `amountIn == 0`, which every caller
rejects separately. It does mean `fee ≥ 1` for any positive input, so dust trades
now yield 0 and are rejected — the intended fix for the prior round's
NM-OP5-001, confirmed still in place at `:1476`, `:1510`, `PreMarket.sol:430`.
The one behavioural cost is that a position sitting exactly on the
`totalBuyable < airTokenMinted` boundary can flip to unpriceable one atom earlier;
such a position is already deeply underwater and still settles at expiry with its
collateral returning to the LP, so no value moves.

**Fee-split arithmetic.** Re-derived at every use site; see IA-R2-4 for the
audit trail. Base fee sums to 500 bps everywhere, the `MIN_POSITION_FEE` floor
splits exactly with no dust, and nothing on-chain assumes the old ratio.

**Zero-value / zero-address validation on the new contracts.**
`PreMarket` constructor: six address checks plus both amounts, `usdc` cross-check
against the factory, `startPrice`, decay bounds (`:302-314`).
`PreMarket.swap`: `amountIn == 0`, `to == 0`, `amountOut == 0` (`:422-431`).
`PreMarket.buyout`: `launched`, `maxUsdc`, `minQuoteOut` (`:484-498`) — guards in
the correct direction.
`PreMarketFactory.createPreMarket`: `:120-121`.
`LockedLpVault` constructor: `:171-179`, including the `poolOf(lpNftId) == pool`
cross-check; claim functions guard `to == 0` and `amount == 0`; `setLp`/
`setIntegrator` reject zero (`:293`, `:305`). The one gap in this family is
`token != usdc` — IA-R2-1.

**Reserve non-drainability in `PreMarket`.** `getAmountOut` returns strictly less
than `reserveOut` for every input (the denominator strictly exceeds the numerator
factor), so `reserveOut - amountOut > 0` always and the `swap` subtractions at
`:436`/`:439` cannot underflow. `buyout` therefore always finds
`tokenOut ≥ 1`, which is what keeps `addLiquidity`'s `ZeroAmount` guard from
firing. The `MIN_BUYOUT_USDC` floor covers the other leg.

**`LockedLpVault` accrual invariant.** `lpAccrued + integratorAccrued == balance`
after every `_harvest`, and each claim decrements accrued and balance by the same
amount — so the subtraction at `:221` cannot underflow from this contract's own
operations. Traced through all three entry points. The residual risk is external
(IA-R2-7).

**ERC-4626-style share inflation.** Still not applicable, and now doubly so:
`LockedLpVault` holds exactly one NFT, has no shares, no `deposit`, and no
price to manipulate; `PreMarket` has no share token either. No first-depositor
vector anywhere.

**Casts.** No new narrowing casts. `quoteClose`'s `int256`/`-int256`
(`EXNIHILOPool.sol:1387-1389`) and `PositionNFT`'s `uint256(pnl)` /
`uint256(-pnl)` (`:444`) remain the only signed conversions, all bounded by pool
reserves and all inside display paths. `PositionNFT._netReturn`'s
`pct = premium == 0 ? 0 : (usdcAbs * 100) / premium` (`:215`) guards its own
division by zero. No `uint128`/`uint64`/`uint32` narrowing exists in the
protocol.
