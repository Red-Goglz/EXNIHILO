# N E M E S I S — Verified Findings, Opus 5 R4

**Date:** 2026-09-24
**Tree:** `mainnet-launch` HEAD `2ce997a`, plus uncommitted changes to `EXNIHILOPool.sol` and
`EXNIHILOFactory.sol` that are comment-only (verified: every code line of `git diff` is a comment).
**Delta since R3 (`609723f`):** `344abcb`, `066d595`, `2789cf3` (twelve contract changes from an
external review, unaudited until now). `4ad4a9f` is site-only. Outside the pool and factory, only
`LockedLpVault._harvest` changed (saturating subtraction).
**Also checked:** the deployed mainnet contracts (`5197494`, live since 2026-07-28), in a worktree.

```
2 CRITICAL | 0 HIGH | 1 MEDIUM | 1 LOW | 4 INFO | 1 PROCESS
```

Suite at audit start: **673 passing.** PoCs: `poc/AuditR4Poc.ts` + `poc/AtomicShortAttacker.sol`
(copy into `packages/blockchain/test/` and `contracts/test/`); deployed-version PoC in
`poc/live-5197494/`. Every figure below is measured on-chain in Hardhat unless marked *model*; the
integer model (`nemesis-raw.md`) matched every on-chain figure to the cent.

## Deployment advisory — read first

**The deployed mainnet contracts are vulnerable to NM-R4-001 today**, and more easily than HEAD:
they have no clamp at all, so the manipulation does not even need to be atomic. Measured against
`5197494` bytecode: **+$14,516.65 per $100k of pool USDC per transaction.**
A mainnet read on 2026-09-24 (public RPC) found three markets on factory `0xBe6F…F85a` (RGOGLZ,
ARENA, PHAR), **all with `backedAirUsd = 0`. Nothing is at risk right now.** The factory is
permissionless and ownerless, so anyone who seeds a market there is exposed. Do not seed or promote
markets on it. The branch's site calls the new three-argument `createMarket`, which the live factory
does not have, so this branch's site cannot create markets there. A direct call to the factory still can.

**Do not deploy HEAD** until NM-R4-001 and NM-R4-002 are fixed together. Fixing either one alone
leaves the other open.

---

## NM-R4-001 — CRITICAL — A position opened and closed in one transaction settles at a price its opener just moved

**Status: FIXED 2026-09-25 (uncommitted).** `_priceCloseClamped` keeps the open block's snapshot
(`e.timestamp < pos.openedAt`) and sizes it at `fundingIndexAtOpen`; snapshots of an empty pool are
skipped. Tests: `AtomicManipulation.ts`, "closing". Mutation-checked: `<=` fails 3 tests; dropping the
opening-size rule fails the flush test (the new long quoted −$0.04 instead of −$1,108).

**Discovery path:** Feynman P1 (the ring filter, and R3's reasoning for dismissing NM-R3-006) →
model → State P2 (the short close burns the synthetic debt and never withdraws tokens) → Feynman P3
(the swap fee is on the pre-swap spot value, so splitting a swap avoids it).

**Code.**
- `EXNIHILOPool.sol:930`: `if (e.timestamp <= pos.openedAt) continue;`. For a position opened in
  the current block, every ring entry is at or before `openedAt`: the block's own snapshot is written
  by the block's first mutation, before the open. **The clamp reduces to the live price.**
- `:1019-1024`: a short close credits `locked − surplus` to `backedAirUsd` and burns the debt from
  `airTokenSupply`. It takes no tokens out of `backedAirToken`. Tokens dumped to cheapen the
  buyback are still in the pool afterwards, at a price the close has only raised by the buyback
  cost.
- `:1409-1425`: the swap fee is charged on the input's **pre-swap spot value**. That makes one huge
  swap expensive, but the same move split into 20 swaps pays about 1 % of actual output per leg.

**Trigger (one transaction, flash-loanable, no preconditions, any market older than a few minutes):**
1. `openShort` ×3 at the cap.
2. Sell tokens into SWAP-1 in 20 chunks: 5.8× the token reserve, borrowed.
3. `closeShort` ×3. SWAP-2 shares `backedAirToken` with SWAP-1, so the buyback is nearly free.
4. Buy the same number of tokens back in 20 chunks, then repay the loan.

**Measured** (pool 100k USDC / 100k tokens, 24 h old):

| Shape | Attacker, USDC realised | Notes |
|---|---|---|
| 1 short at cap, 1 dump + 1 rebuy | **+$1,793.71** | 1.79 % of pool USDC at any price and scale ($10k, $1M, P = $1000) |
| 2 shorts at cap, single swaps | **+$2,431.15** | |
| 3 shorts, dump 5.8× in 5 swaps | **+$14,334.90** | |
| 3 shorts, dump 5.8× in 20 swaps | **+$17,467.45** | LP backed USDC −$22,856, LP fees +$4,488; 3.0 M gas |
| Long, pump 2.2× in 20 swaps, sell back | **+$2,788.47** | single-swap long mirror: −$262 |
| Same short shape, 3 separate txs (control) | reverts `PositionUnderwater` | the clamp works across blocks |
| Fresh market, 1 % cap: 60 × 1 % shorts, chunked | +$14,752 (*model*) | the cap is per position; block gas is the limit |

It repeats. Sixty single-swap cycles take a $100k pool's USDC reserve down to $14.1k (*model*).
On a `LockedLpVault` market this also breaks the launchpad's promise: liquidity that "can never be
pulled" can be drained by anyone, the token's creator included.

**Why no test caught it.** `ManipulationSafety.ts`'s grid runs open, move and close as separate
transactions, which the clamp catches. It also marks leftover tokens at the pre-attack price
instead of buying them back from the pool at the depressed price. The atomic-sandwich test only
covers a position opened in an earlier block. R3 closed NM-R3-006 (this exact blind spot) on the
strength of that grid.

**History.** Not introduced by `2789cf3`. The R3 tree's prorated buyback overcharged enough to make
the single-short shape lose (−$142, *model*), but the overcharge shrinks with position size, so
splitting into 32 shorts gave +$1,128 (*model*; the deployed-tree PoC gives the same figure, +$1,129.74).
`2789cf3`'s exact inverse removed that margin. The deployed contracts use the prorated cost and
have no clamp: +$1,129.74 split, **+$14,516.65 chunked**, both on-chain.

**Fix (verified).** Include the open block's snapshot in the clamp:

```solidity
// EXNIHILOPool.sol:930
if (e.timestamp < pos.openedAt) continue;
```

With that one change, every PoC above reverts `PositionUnderwater`, and the full suite passes
(673/673). Also value any snapshot at or before `openedAt` at the position's opening size:
use `pos.fundingIndexAtOpen` instead of the snapshot's index. Otherwise a flush earlier in the same
block, which rebases the index to RAY, makes the snapshot shrink a new position and holds its close
back for 5 blocks. This fix alone is **not sufficient**; see NM-R4-002.

---

## NM-R4-002 — CRITICAL — Opens are priced at live reserves: manipulate the open, close honestly later

**Status: FIXED 2026-09-25 (uncommitted).** Ring-based entry clamp: `_openLongOut` /
`_openShortTerms` price an open at the worst of live reserves and every block open in the window
(most debt, least collateral for a short). New view `quoteOpen(notional, isLong)`, wired into the
ABI package, SDK (`quoteOpen`) and site (`useOpenQuote`, replacing the local `quoteLong` /
`quoteShort`). Tests: `AtomicManipulation.ts`, "opening". Mutation-checked: removing the entry loops
fails 4 tests. Suite 681 passing; every PoC in `poc/AuditR4Poc.ts` except the 5-block hold (NM-R4-003,
still +$4,633) now reverts `PositionUnderwater`.

**Discovery path:** cross-feed P3→P4. Checking whether the NM-R4-001 fix covered every route turned
up the entry side, which no reference protects at all.

**Code.** `openLong` `:378-383` and `openShort` `:452-457` price at live reserves. The ring is
consulted only at close. SWAP-2 and SWAP-3 share `backedAirToken` / `backedAirUsd` with SWAP-1, so
a spot move reprices the entry.

**Trigger.** One transaction: move the price with chunked swaps, open at the moved price, move it
back. The position now carries a profit at honest prices. Close it in any later block: every ring
snapshot is honest, so the clamp has nothing to catch.

**Measured** (100k / 100k, 20-chunk swaps, close 10 blocks later):

| Side | Attacker, USDC realised | On HEAD | With the NM-R4-001 fix |
|---|---|---|---|
| Short: pump 160k USDC → 2 shorts → unpump | **+$2,598.78** | yes | **identical** |
| Long: dump 1.6× tokens → long → rebuy | **+$4,355.98** | yes | **identical** |

Nothing is held across a block boundary except the position, and funding over the few seconds
before the close is negligible.

**Fix (prototype verified).** Price every open at the worse of live reserves and this block's
opening snapshot:

```solidity
// openLong, after airTokenOut
PriceSnapshot storage o = priceRing[priceRingHead];          // this block, written by the modifier
uint256 atOpen = _cpAmountOut(usdcAmount, o.usdSupply, o.backedToken);
if (atOpen < airTokenOut) airTokenOut = atOpen;

// openShort, after airUsdOut: more debt and less collateral, never better
uint256 mOpen = (usdcNotional * o.tokenSupply) / o.backedUsd;
uint256 lOpen = _cpAmountOut(mOpen, o.tokenSupply, o.backedUsd);
if (mOpen > airTokenMinted) airTokenMinted = mOpen;
if (lOpen < airUsdOut) airUsdOut = lOpen;
```

The identities still hold, because state updates use whatever `m` and `L` are chosen. With both
fixes applied, all NM-R4-001 and NM-R4-002 PoCs revert and the full suite passes (673/673). A one-snapshot entry clamp still lets an
attacker who holds the move across a single block boundary through: they can order their own
transaction first in the next block. Use the worst of the whole ring, symmetric with the close.
Honest cost: an open never gets a better price than the block opened with.

---

## NM-R4-003 — MEDIUM — The clamp window is the only barrier, and its no-arbitrage bound is ~10× what R3 measured

With both fixes in place, the same trade still pays if the move is held across the window.
Measured, with the prototype fixes applied: 3 shorts, dump 5.8× in 20 swaps, **5 quiet blocks**, close, rebuy →
**+$4,633.03** per $100k. R3 recorded this class (R2 H-2 residual) at +$478–$851. Chunked swaps are
what make it about ten times larger. `docs/protocol/security.md` lists H-2 as "Closed by the
5-block close-price clamp".

It needs nobody to trade against a price crash of up to about 97 % for about 10 seconds. Any
arbitrage makes it heavily unprofitable: the attacker's dumped tokens are bought cheaply by someone
else. That is realistic only on a thin launchpad market with no bots, or for a block producer.
**Fix:** a time-based window (e.g. 60 s rather than 5 blocks) on both entry and exit; correct the
docs' "closed".

## NM-R4-004 — LOW — The claim paths assert the token leg, so a token-side deficit freezes USDC claims

**Status: FIXED 2026-09-25 (uncommitted).** The three claim paths call `_assertUsdcCovered()`,
the USDC half of `_assertReserveInvariant`, which now calls it too. Tests: `ClaimPaths.ts`.
Mutation-checked both ways: the full invariant fails the token-shortfall test, and no check fails the
USDC-shortfall test. Suite 683 passing.

`claimFees` `:559`, `claimProtocolFees` `:575`, `claimPayout` `:590` (all added in `2789cf3`) call
the full `_assertReserveInvariant`, which also checks the token balance. A token whose pool balance
falls outside the pool's control (negative rebase, admin burn, seizure) now blocks every USDC
claim: LP fees, protocol fees and holders' sweep credits. Before, USDC could still leave. **Fix:**
assert only the USDC leg on the three USDC claim paths.

## INFO

- **NM-R4-005** — `_buybackCost` `:1427-1428` says the bisection "is sound because _cpAmountOut
  is monotonic". It is not: output falls once the input exceeds 9 × the input reserve. The search
  is still correct, because the caller guarantees `hi` is feasible and the feasible set is an
  interval. `if (lo > hi) lo = 0` is dead code. Related: `_priceCloseAt` `:894-899` reads a
  deep-profit short as unpriceable when `backedAirUsd` has been drained below about `locked / 9`.
- **NM-R4-006** — The factory's 6–18 decimals bound (`EXNIHILOFactory.sol:112-122`) does not bound
  the value of a unit; the seed ratio does. 100 wei seeded against $100k makes one wei worth $1,000.
- **NM-R4-007** — `MIN_FUNDING_INDEX` refuses opens after about 17 years at the base rate, but about
  1.4 years at the 4× utilization cap. It lifts only when the whole book empties. Sustained cap
  utilization is uneconomic under the impact fee.
- **NM-R4-008** — A fee on the pre-swap spot value is not a manipulation cost: split the swap and it
  falls to about 1 % of actual output. It only penalises honest large swappers. It is a contributing
  factor in 001–003, so any future manipulation argument should use the chunked figure.

## PROCESS-R4 — Manipulation safety was certified on shapes that cannot reveal it

`ManipulationSafety.ts` asserts that "the OI-integral impact fee … provably dominates both the
manipulation profit and the round-trip slippage". Its grid uses separate transactions and single
swaps, marks leftover tokens at P0 instead of trading back against the pool, and never manipulates
the entry. NM-R3-006 was closed by pointing at that grid. The same pattern as R2's PROCESS-002: a test
written to confirm the property rather than to attack it. **Owed:** atomic, chunked and
entry-manipulation grids, with every leg unwound against the pool itself, kept as regression tests
next to the fixes.

---

## Checked and clean (this round's delta)

- **`_settleCarriedFunding`**: at the point it runs, the modifier's accrual has just shown the
  release to be zero, so aggregate × (1 − f) < 1 unit. Existing holders pay less than one collateral
  unit in total, the joiner is not billed, and aggregates stay ≥ Σ positions.
- **`_liveAt` zeroing / `MIN_FUNDING_INDEX` / `_flushResidue` rebase**: a zeroed position settles
  zeros and its residue waits for the flush; the flush moves every residue with its counterpart. The
  identities hold exactly across every mutator. The USDC and token flows were re-checked term by term.
- **`mulDiv` in `_released` / `_liveAt`**: no overflow at any reserve size.
- **`sweepDustBatch`**: skip conditions sound, and `ownerOf` cannot revert for a live position.
- **Router**: the executed fee is always ≤ the quote, since accrual only deepens `backedAirUsd`.
- **`LockedLpVault` saturation**: sound. No path lets the vault close the pool or move the NFT.
- **`closePool` LP-only**, and the deployer role is gone. `PreMarket` / `PreMarketFactory` are
  unchanged since R3 apart from comments.

## Recommendations, in order

1. Treat the live factory as unsafe: no seeding or promotion until the redeploy.
2. Before any redeploy, fix NM-R4-001 and NM-R4-002 together, with ring-based clamps on both entry
   and exit.
3. Add the atomic, chunked and entry-manipulation grids from `poc/` as regression tests, and
   mutation-check them by reverting each fix.
4. Move the clamp window to time rather than blocks (NM-R4-003), and correct `security.md`'s "H-2 closed".
5. Narrow the claim-path assertion to USDC (NM-R4-004).

## Scope limits

One Nemesis pass with an integer model and on-chain PoCs. The model's search space was bounded
(k ≤ 3 positions at HEAD, ≤ 100 swap chunks, grids over size and move), so the maxima above are
lower bounds. Not covered: fuzzing, formal verification, the indexer, the SDK, the site. The
deployed contracts were tested only for NM-R4-001.
