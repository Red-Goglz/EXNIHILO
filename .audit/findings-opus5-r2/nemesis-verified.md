# N E M E S I S — Verified Findings (Opus 5, Round 2)

**Date:** 2026-08-20
**Model:** Claude Opus 5
**Baseline:** `.audit/findings-opus5-r2/SCOPE.md` — repo `mainnet-launch` @ `c02af1d` plus
uncommitted working-tree contract changes, delta derived from `git diff`, not asserted.
**Scope covered by this pass:**

| Target | Treated as | Depth |
|---|---|---|
| `PreMarket.sol` (562 L) | unreviewed code | full line-by-line |
| `PreMarketFactory.sol` (183 L) | unreviewed code | full |
| `LockedLpVault.sol` (350 L) | unreviewed code | full |
| `EXNIHILOPool.sol` (587 L delta) | delta + all touched invariants | full on cap ramp, duration ramp, settlement guard, `KEEPER_BOUNTY` removal, `_renewFees`, `_settle`, `_tryAutoRenew` |
| `EXNIHILOFactory.sol` (47 L delta) | delta | full |
| `PositionNFT.sol` (170 L delta) | delta | mutation surface only (not SVG) |
| `PoolDeployer.sol`, `EXNIHILORouter.sol`, `LpNFT.sol` | delta | full (trivial) |

**Method:** the nemesis loop as specified — full Feynman pass, full state-inconsistency
pass enriched by its suspects, then targeted re-passes in both directions until
convergence (4 passes). Every finding below was verified by an executable PoC, not
by reasoning alone. PoCs live in `packages/blockchain/test/ZZNemesisR2.ts`
(19 passing; **delete after the round** — it is probe scaffolding, not a suite addition).
No contract was modified.

---

## Executive result

```
0 CRITICAL | 2 HIGH | 1 MEDIUM | 4 LOW | 2 INFO
```

**The primary question — can LP funds be drained — is still answered no.** The pool's
conservation algebra survives every new subsystem; I re-derived it by hand for the
auto-renew, settlement, and short-collateral paths and found it exact.

**The second question is answered yes, twice.**

1. A **market's own LP can steal the entire settlement equity of every expiring
   position in its market**, at a realised profit, by moving the settlement price with
   `openShort` — which the new settlement guard does not watch. Measured end to end
   with both branches wound down to zero open positions: holders credited
   **$819.48 → $0.00**, LP realised USDC **+$776.37**, `settlementGuardedUntilBlock()`
   **never left 0**.
2. A **`PreMarket`'s seeded token reserve is extractable for $1** once the Dutch
   auction decays past the `MIN_BUYOUT_USDC` floor, because the floor decouples the
   buyout cost from `quoteReserve` and so refunds a swapped-in quote leg for free.
   Measured: **990,000 of 1,000,000 tokens taken, $1.00 net USDC cost**, the launched
   market opening with 10,000 tokens instead of 1,000,000.

Both are in the pending redeploy, not on mainnet (mainnet carries the `c72f6a7`
baseline, which has neither contract and neither mechanism). They are pre-launch
defects, which is the good news; they are also both in code no prior pass has seen.

---

## NM-R2-001 — The settlement guard watches `swap` only; `openShort` moves the same two reserves and is 20× larger

**Severity:** HIGH (arguably CRITICAL — see *Severity note*)
**Locations:**
`EXNIHILOPool.sol:1437` (`_armSettlementGuard`, called only from `:1482` and `:1515`),
`EXNIHILOPool.sol:1452` (`_assertSettlementUnguarded`),
`EXNIHILOPool.sol:784` + `:788` (`openShort` mutations),
`EXNIHILOPool.sol:1562-1568` (`_priceClose`, long branch),
`EXNIHILOPool.sol:1100-1102` (`_autoRenewQuote` margin test),
docstring `EXNIHILOPool.sol:234-282` and `:386-394`.
**Discovery path:** Feynman Category 3 (consistency) in pass 1 → State mutation matrix
in pass 2 confirmed the coupled pair → Feynman pass 3 found the docstring's own
argument refutes its own exclusion.

### The question that exposed it

`_armSettlementGuard` is reachable from exactly two call sites, both inside `swap`.
Why is that sufficient? The guard exists (per its own docstring) because
"both expiry entry points read live AMM reserves — through `_priceClose` for the
payout and through `_renewFees` for the auto-renew decision". So the correct scope of
the guard is *every function that moves the reserves `_priceClose` reads*. Which are
they, exactly?

For a **long**, `_priceClose` reads precisely two values:

```solidity
uint256 airUsdOut = _cpAmountOut(
    pos.lockedAmount,
    airTokenSupply - pos.lockedAmount,   // reserveIn
    backedAirUsd                          // reserveOut
);
```

Now list every function that writes those two. `swap` token→USDC writes
`airTokenSupply += amountIn; backedAirUsd -= netOut` (`:1486`, `:1489`) — guarded.
`openShort` writes `airTokenSupply += airTokenMinted; backedAirUsd -= airUsdOut`
(`:784`, `:788`) — **structurally the identical move, in the identical direction, and
not guarded.** `closeShort` / `closeLong` / `settleExpired` also write both (`:1633-1659`)
— not guarded.

### Why the docstring's own reasoning refutes the docstring

Line 386-394 enumerates the alternatives and dismisses them:

> `removeLiquidity` reverts while any position is open, `addLiquidity` can only *raise*
> a position's priced surplus … and openLong/openShort pay a 5 % fee of which the 1 %
> protocol share is a real loss even to the LP. Swapping is the only near-free route,
> so it is the only one gated

Two errors. First, `closeLong` and `closeShort` are not in the list at all, and both
write `backedAirUsd`. Second — and this is the one that matters — the *same* docstring
argues, forty lines earlier (`:240-243`), that a swap round trip is near-free **for the
LP specifically** because "the round trip costs 2 × swapFeeBps, which the pool's sole
LP receives back into its own reserves". That argument applies verbatim to the 5 %
open fee: `LP_FEE_BPS` is 400 of the 500, and the whole impact fee is LP-bound
(`:1820`). So for the LP — the only party that profits from a confiscation, as the
docstring itself observes — the "real loss" is `PROTOCOL_FEE_BPS` alone, 1 % of
notional, and everything else returns to it.

### Why the size argument fails

`SETTLE_GUARD_BPS` is 100 (1 % of `backedAirUsd`). `currentMaxPositionBps()` ramps to
`CAP_MAX_BPS` = 2000. So a single `openShort` may legally be **20× the swap size that
arms the guard**, and the reserve move is proportional. The stated bound —

> Capping f at SETTLE_GUARD_BPS therefore caps the swing at SETTLE_GUARD_BPS × mark,
> and a margin of RENEW_MARGIN_BPS × mark above that bound cannot be crossed by any
> swap small enough to evade the guard.

— is true of swaps and false of the pool as a whole. `RENEW_MARGIN_BPS` (200 = 2 % of
mark) is sized against a 1 % swing. Measured swing from two `openShort` calls, both
inside the cap: **+$388.17 → −$67.62**, i.e. ≈118 % of mark, ≈59× the margin.

### Exploit path (PoC `NEMESIS-R2 / H1` and `/ I1`)

Setup: pool seeded 10,000 USDC / 1,000,000 token, past the 24 h cap ramp.
Eight longs of $200 notional each, held by four different traders, **all with
`setAutoRenew(true)`**. A 4,000 USDC swap pumps the price; six blocks are mined so the
guard from that swap has lapsed; seven days pass so all eight expire.

Honest state at that point (PoC H1):

```
total realizable surplus across 8 positions: $892.44
closePositionAfterDeadline on each of the 8: reverts AutoRenewActive
```

The holders' opt-in is doing exactly its job — no third party can end these positions.

Attack, executed by the LP NFT holder:

```
openShort(effectiveLeverageCap())   // notional $2,800.00, inside the cap
openShort(effectiveLeverageCap())   // notional $2,338.93, inside the cap
settlementGuardedUntilBlock()  ->  0        // guard never armed
lastLargeSwapBlock  36 -> 36                // unchanged
closePositionAfterDeadline(id) x 8 -> all 8 succeed
total credited to holders: $0.00
LP cash out (open fees): $418.03, of which $366.64 accrued back as lpFeesAccumulated
net cash cost to LP: $51.39
```

And the decisive measurement (PoC I1), with **both branches run to full wind-down** —
`closePool`, all positions settled, `removeLiquidity` called, `openPositionCount == 0`
in both — so these are realised holdings and not marks:

| | holders credited | LP USDC gain | LP token gain | open positions left |
|---|---|---|---|---|
| honest | **$819.48** | $13,255.44 | 756,771.965 | 0 |
| attack | **$0.00** | $14,031.81 | 756,771.965 | 0 |

**LP realised delta: +$776.37 USDC. Token delta: exactly 0 — no offsetting token-side
loss. Holder loss: $819.48.** The $43.11 gap between the two is `PROTOCOL_FEE_BPS` on
the manipulation's open fees, the only genuine leakage in the whole operation.

### The control-group PoC that proves it is the guard's fault

`NEMESIS-R2 / B3b` performs *the same reserve move in the same direction* through
`swap` (200,000 token in). `settlementGuardedUntilBlock()` becomes non-zero and
`closePositionAfterDeadline` reverts `SettlementGuardActive`. The guard works
perfectly on the path it watches and is simply absent on the cheaper one.

### Why I believe it

Three independent confirmations: (a) the two mutated state variables are literally
the two `_priceClose` arguments, read off the source; (b) `lastLargeSwapBlock` is
observably unchanged across the manipulation while the priced payout moves 118 % of
mark; (c) the end-to-end wealth comparison with both branches fully wound down shows
a positive realised delta for the attacker and a total loss for the victims. There is
no mitigating code — I traced `closePositionAfterDeadline` (`:1170-1187`) and
`settleExpired` (`:1050-1063`) and `_assertSettlementUnguarded` is the only gate, and
it reads only `lastLargeSwapBlock`.

### Severity note

Under the round's taxonomy this sits on the CRITICAL/HIGH line. It is direct, realised
theft ("funds directly stealable"), but it steals from *traders* rather than from LPs,
and it requires the attacker to hold the market's LP NFT. Since the LP role is
permissionless — anyone who calls `createMarket` holds it for their own market, and
the LP is by construction the traders' counterparty — I would not treat the
precondition as much of a barrier. **I am filing HIGH; if the coordinator's CRITICAL
bar includes theft from users and not only from LPs, promote it.**

### Fix (precise; not applied)

The invariant that must hold is: *any operation that can move a long's `airUsdOut` or
a short's buyback `cost` by more than `SETTLE_GUARD_BPS` of depth must arm the guard.*
Three changes, all one line each:

1. In `openShort`, after computing `airUsdOut` and before the effects block
   (i.e. immediately above `EXNIHILOPool.sol:788`), add
   `_armSettlementGuard(airUsdOut);`
2. In `openLong`, add `_armSettlementGuard(usdcAmount);` — see the symmetric case
   below; this is required, not defensive.
3. In `_settle`, arm on the USDC-denominated size of the settlement
   (`surplus` for the profitable branch, `pos.lockedAmount` for the underwater short
   branch). **This does forfeit the "keeper can batch several expiries in one block"
   property the docstring claims at `:394`** — the coordinator should decide whether
   that property is worth more than closing the batched-confiscation vector in H1,
   which is the variant that makes the attack pay. A middle option: exempt settlement
   from *arming* but require that a settlement transaction not be preceded in the same
   block by a position open, which preserves batching and kills the batch attack.

`_armSettlementGuard` already takes a USDC-denominated size and compares against
pre-mutation `backedAirUsd`, so all three call sites are drop-in.

### The attack is symmetric — `openLong` does the same thing to expiring shorts

A short's `_priceClose` (`:1577-1582`) reads `airUsdSupply` and `backedAirToken`.
`openLong` writes both: `airUsdSupply += usdcAmount` (`:656`) and
`backedAirToken -= airTokenOut` (`:660`). Both reduce `totalBuyable`, which raises the
buyback `cost`, which cuts the short's surplus.

**PoC `NEMESIS-R2 / J1`**, three auto-renew shorts of $300 each, dumped into profit and
expired:

```
honest total short surplus: $272.68
closePositionAfterDeadline on each of the 3: reverts AutoRenewActive
openLong($1,411.02)  -> short#0 payout  $90.89 -> $32.16
openLong($1,411.02)  -> short#0 payout          -> -$50.13
lastLargeSwapBlock  40 -> 40            // guard never armed
all 3 shorts force-closed, credited to holders: $0.00
```

Both sides of the book are exposed, by the mirror-image open. Any fix must cover both.

---

## NM-R2-002 — `MIN_BUYOUT_USDC` decouples the buyout cost from `quoteReserve`, making the seeded token reserve free

**Severity:** HIGH
**Locations:**
`PreMarket.sol:379-382` (`_buyoutCost`), `PreMarket.sol:354-358` (`currentPrice`),
`PreMarket.sol:416-452` (`swap`), `PreMarket.sol:488-508` (`buyout`),
rationale comment `PreMarket.sol:140-156`, design claim `PreMarket.sol:73-79` and `:92-99`.
**Discovery path:** Feynman Category 2 (ordering) on `buyout` → Category 4 (assumptions)
on the floor's own justification comment → State pass confirmed `quoteReserve` is both
the priced quantity and the delivered quantity, with an attacker-controlled write
between them.

### The question that exposed it

`_buyoutCost` is:

```solidity
uint256 priced = (quoteOut * price) / quoteUnit;
return priced < MIN_BUYOUT_USDC ? MIN_BUYOUT_USDC : priced;
```

`quoteOut` is `quoteReserve`. Below the floor this function is **constant in
`quoteReserve`**. So: what is the marginal cost of adding one more unit of quote to the
reserve immediately before a buyout? Zero. And what does the buyout do with the
reserve? `quote.safeTransfer(msg.sender, quoteOut)` at `:508` — hands **all of it**,
including whatever was just added, to the same caller.

That makes `swap(quote → token)` followed by `buyout` a **fully refunded round trip**,
and the token that came out of it is free. The 1 % AMM fee does not help: it is
"retained in the reserves" (`:120-131`), and the reserve is what the buyer takes.

### Why the "manipulation does not pay" argument does not cover it

`PreMarket.sol:92-99` argues that dumping into the curve means buying back along the
same curve and gaining nothing. That argument is correct — and I verified it — **only
while the buyout cost is proportional to `quoteReserve`.** PoC `A3` measures the
non-floor case at ~1 minute into the auction:

```
buyout cost before swap: $29,360.00
buyout cost after  swap: $2,964,350.00
marginal cost of the swapped-in quote: $2,934,990.00
```

The round trip is priced, and it loses. The floor removes that pricing entirely.

### Exploit path (PoC `NEMESIS-R2 / A2`)

Seed: 1,000,000 token + 500 quote (both 18 dec), `startPrice` $60, decay 200 bps/min.
Wait for the auction to decay past the floor (50 min at this rate — or zero minutes,
see NM-R2-004b below).

```
1.  flash-borrow 50,000 quote                     (100x the seeded reserve)
2.  swap(50000e18, 0, tokenToQuote=false, self)   -> receives 990,000 token
3.  buyoutCost()  ->  $1.00                       // unchanged despite a 101x reserve
4.  buyout(1e6, 0)                                -> receives 50,500 quote
5.  repay the flash loan
```

Measured result:

```
quote in : 50,000            quote net: +500.0   (the entire seeded reserve)
usdc net : -1.00
token stolen: 990,000.0 of 1,000,000.0
launched market token reserve: 10,000.0   (honest baseline A1: 1,000,000.0)
launched market usdc  reserve: 1.0
```

The whole operation is atomic and self-funding — every unit of quote borrowed comes
back inside the same transaction, so the flash loan closes. The project's `lpOwner`
receives an LP NFT, permanently locked in a `LockedLpVault`, over a market containing
$1 and 1 % of the token liquidity it was promised.

### The contract's stated guarantee is not true

`PreMarket.sol:73-79` promises:

> Seeding is irreversible. There is no withdrawal, refund or expiry path: the only way
> assets leave a premarket is a buyout … A launchpad can verify from the bytecode that
> its liquidity cannot be pulled back out, by anyone, ever

`swap` *is* a withdrawal path for both legs; it is only supposed to be a fairly-priced
one. Under the floor it is not priced at all. Separately — and this holds even with the
floor fixed — the same paragraph overstates the guarantee against a token issuer, who
mints `token` at zero cost and can therefore drain the quote leg through `swap` exactly
as they could from a locked Uniswap LP. That second point is a documentation defect
rather than a code defect (a locked LP has the same property), but a launchpad reading
"cannot be pulled back out, by anyone, ever" would be misled about the bonded value.

### Why I believe it

The PoC is deterministic, atomic, and asserts the exact quantities:
`quoteAfter - quoteBefore == SEED_QUOTE` (full refund), `usdcBefore - usdcAfter ==
1_000_000` (the floor exactly), and `tokenTaken >= 98 %` of the seed. The A1 baseline
in the same fixture shows the honest path leaves all 1,000,000 tokens in the launched
pool, isolating the delta to the manipulation. A3 shows the same round trip is
correctly priced away from the floor, isolating the cause to `_buyoutCost`.

### Fix (precise; not applied)

The required invariant: **the USDC a buyer pays must be strictly increasing in
`quoteReserve`, at every price.** The floor as written is not, and neither is
`currentPrice()`'s floor of `1` (one micro-USDC per *whole* quote unit ≈ zero for an
18-decimal quote), so flooring the price instead of the total does not fix it either.

Two options, in order of preference:

- **(a) Break the atomicity.** Record `lastQuoteInBlock = block.number` in `swap` when
  `tokenToQuote == false`, and in `buyout` revert while
  `block.number <= lastQuoteInBlock + N` (N small, e.g. 2). A flash loan can no longer
  be used, and an attacker who holds the quote across blocks must survive a window in
  which any rival can take the now-much-larger reserve for the same $1 — which is a
  strictly better trade for that rival, so the position is not holdable. This creates
  no strand risk: the buyout stays executable in every later block, which is the
  property `:140-156` was protecting.
- **(b) Cap what the buyout delivers.** Store the seeded `quoteAmount` as an immutable
  and have `buyout` transfer `min(quoteReserve, seededQuote)` to the buyer, leaving any
  excess for the launched market. Marginal quote is then never refunded at all. This
  changes the auction's semantics (`buyoutCost()` and the `BoughtOut` event both need
  the same clamp) and is the bigger change, but it removes the vector by construction
  rather than by timing.

Do **not** simply raise `MIN_BUYOUT_USDC`; that moves the threshold without restoring
monotonicity.

---

## NM-R2-003 — `renewPosition` stacks deadlines without bound, so `closeDate` guarantees nothing and `removeLiquidity` can be denied indefinitely

**Severity:** MEDIUM
**Locations:** `EXNIHILOPool.sol:1004-1008` (`renewPosition`),
`EXNIHILOPool.sol:511` (`closePool`), `EXNIHILOPool.sol:896-897` (`removeLiquidity`),
claims at `EXNIHILOPool.sol:224-227` and `:494-497`.
**Discovery path:** Feynman Category 3 — `renewPosition` and `_tryAutoRenew` compute
`newDeadline` differently, and only one of them is safe.

### The asymmetry

```solidity
// renewPosition, :1004-1005
uint256 base = pos.deadline > block.timestamp ? pos.deadline : block.timestamp;
uint256 newDeadline = base + currentPositionDuration();

// _tryAutoRenew, :1122
uint256 newDeadline = block.timestamp + currentPositionDuration();
```

The auto-renew form cannot stack — it always measures from now. The manual form
extends from the existing deadline, has no cooldown, and no cap. Calling it k times in
k consecutive blocks moves the deadline forward by `k × currentPositionDuration()`.

### Why the stated guarantee fails

`currentPositionDuration()`'s own docstring reasons about the safety of `closeDate`:

> MUST be non-decreasing in market age. closePool sets
> `closeDate = now + currentPositionDuration()`, and the guarantee that every
> outstanding position has expired by closeDate depends on no earlier position having
> been issued a longer lifetime.

Non-decreasing issuance is **necessary but not sufficient**. It bounds a position's
deadline at `openedAt + D(openedAt) ≤ tc + D(tc)`, but renewal replaces that with
`deadline + D`, and the induction does not carry. `closePool`'s own NatSpec (`:494-497`)
then states the false conclusion outright:

> After closeDate all positions are guaranteed expired and can be closed via
> `closePositionAfterDeadline()`, allowing the LP to call `removeLiquidity()`.

### Exploit path (PoC `NEMESIS-R2 / C1`)

```
open long, notional $100          deadline = T + 7d
renewPosition x 5 (consecutive)   deadline = T + 35d   (+35 days measured)
LP calls closePool()              closeDate = T + 7d   (measured: 6s after open)
time -> closeDate + 1
closePositionAfterDeadline  ->  reverts PositionNotExpired
removeLiquidity             ->  reverts OpenPositionsExist
```

At market age ≥ 7 days each renewal buys 30 days. A position of $100 notional whose
mark is floored at `N` (the `_renewFees` floor at `:1791`, which applies to any losing
position) pays roughly `MIN(5 % of N) + impact` per renewal — on the order of $5 —
so ~$500 buys about 8 years of denial of the LP's entire liquidity. The LP has no
counter: it cannot `closePool` pre-emptively enough, because the stacking can be done
at any time including before `closePool` is ever considered, and once stacked the
deadline is immovable.

Damage is denial of exit, not theft — the LP keeps earning swap and open fees the whole
time, and ~80 % of every renewal fee the griefer pays lands in `lpFeesAccumulated`. That
is what holds this at MEDIUM rather than HIGH. But it does invalidate a guarantee the
contract states twice, and the previous round closed NM-004 ("anyone-can-renew enables
LP exit griefing") on the strength of the holder-only check — which bounds *who* can
stack, not *how far*.

### Fix (precise; not applied)

Clamp the manual renewal the same way the automatic one is already clamped. At
`EXNIHILOPool.sol:1005`, replace

```solidity
uint256 newDeadline = base + currentPositionDuration();
```

with a cap on total forward extension, e.g.

```solidity
uint256 newDeadline = base + currentPositionDuration();
uint256 ceiling = block.timestamp + 2 * currentPositionDuration();
if (newDeadline > ceiling) newDeadline = ceiling;
```

which preserves the "renew before you expire without losing the tail" ergonomics that
motivated extending from `pos.deadline`, while bounding the outstanding deadline at
`2 × D` from now and therefore restoring the `closeDate` guarantee (`closePool` would
then need `closeDate = now + 2 * currentPositionDuration()` to match). Correct the two
docstrings either way.

---

## NM-R2-004 — `PreMarket` accepts a token the market factory will reject, stranding both legs permanently

**Severity:** LOW
**Locations:** `PreMarket.sol:301-333` (constructor validation),
`PreMarketFactory.sol:117-163` (`createPreMarket`), versus
`EXNIHILOFactory.sol:195-197` (`createMarket` validation),
design note `PreMarket.sol:106-109`.
**Discovery path:** Feynman Category 3 against carried finding NM-005.

`createMarket` now validates `tokenAddress != 0`, `tokenAddress != usdc`, and both
amounts non-zero (this is the NM-005 fix — see carried findings). `PreMarket`'s
constructor validates `c.token != 0` but **not** `c.token != c.usdc`, and
`PreMarketFactory` validates neither. The contract's own security note says:

> Market parameters are validated at seed time, not at buyout. With no expiry path, a
> pool constructor revert during buyout would strand the premarket's liquidity
> permanently rather than merely delaying it.

That is exactly the right principle, and `token == usdc` is the case it misses.

**PoC `NEMESIS-R2 / F1`:** `createMarket(usdc, …)` reverts `TokenIsUsdc` as expected;
`createPreMarket({token: usdc, …})` succeeds, takes 1,000 USDC and 500 quote into
custody, and every subsequent `buyout` reverts `TokenIsUsdc` forever. There is no
refund, expiry, or withdrawal path anywhere in `PreMarket`, so both legs are gone.

Self-inflicted by the seeder, and the loss is theirs — hence LOW. It matters because
`PreMarketFactory` is pitched as the programmatic entry point a launchpad calls
("one call, any quote asset"), and a launchpad passing an unvalidated user-supplied
address hits it.

**Fix:** in `PreMarket`'s constructor, after the `UsdcMismatch` check at `:311`, add
`if (c.token == c.usdc) revert TokenIsUsdc();` and `if (c.token == c.quote) revert …`.
Mirroring `createMarket`'s full validation set at seed time is the general form.

---

## NM-R2-004b — `startPrice` has no lower bound, so a premarket can be born at the buyout floor

**Severity:** LOW on its own; it is the **enabling condition for NM-R2-002**
**Location:** `PreMarket.sol:313` (`if (c.startPrice == 0) revert InvalidPriceRange();`)

Only zero is rejected. `startPrice = 1` is accepted, and `_buyoutCost` then returns
`MIN_BUYOUT_USDC` from block zero.

**PoC `NEMESIS-R2 / F2`:** a premarket seeded with `startPrice = 1` and 500 quote
reports `buyoutCost() == $1.00` in the block it is created.

Taken alone this is the documented "underestimating gets the reserve sniped at that
number" footgun (`PreMarketFactory.sol:79-82`). Combined with NM-R2-002 it is worse
than documented: the sniper takes the token reserve as well, and does not have to wait
the 50 minutes of decay. The same holds for any quote token whose `decimals()` over-
reports relative to its real scale — `quoteUnit = 10 ** c.quoteDecimals` at `:324` is
taken on trust from a `try/catch` in `PreMarketFactory:127-131`.

**Fix:** whatever floor is chosen for NM-R2-002 must also be enforced on `startPrice`
at seed time — e.g. require the seeded reserve to price above `MIN_BUYOUT_USDC` at
`startPrice`, `(quoteAmount * startPrice) / quoteUnit >= MIN_BUYOUT_USDC`, which makes
"born at the floor" unrepresentable and is one line in the constructor.

---

## NM-R2-005 — The settlement guard's arming size scales with depth, so a thin market is permanently guarded

**Severity:** LOW
**Locations:** `EXNIHILOPool.sol:1438` (`_armSettlementGuard` threshold),
`EXNIHILOPool.sol:1211-1213` (`settlementGuardArmingSize`)

`_armSettlementGuard` arms when `usdcValue * BPS_DENOM >= backedAirUsd * SETTLE_GUARD_BPS`,
i.e. at 1 % of `backedAirUsd`. On a market launched with $1 of USDC — which
NM-R2-002 produces, and which `createMarket` accepts (`usdcAmount != 0` is the only
bound) — the arming size is $0.0001. Every trade arms the guard, so third-party
settlement of expired positions is blocked essentially permanently, and only the
position holder (exempt at `:1453`) can ever settle. `removeLiquidity` is then gated
behind the holders' willingness to act.

Separately, the coordinator asked whether a griefer can hold the guard armed. Arithmetic:
one arm costs a swap of 1 % of `backedAirUsd`, whose `swapFeeBps` cost is 1 % of that
= 0.01 % of depth, and it must be repeated every `SETTLE_GUARD_BLOCKS` (5, ≈10 s on
Avalanche). Alternating direction to stay price-neutral makes it ≈0.02 % of depth per
10 s ≈ **7 % of depth per hour**, all of it retained in the pool, i.e. paid to the LP.
Sustained denial is therefore uneconomical; minutes-to-an-hour denial is cheap. Since
the party being denied is the LP (the holder is exempt) and the LP is the fee
recipient, this self-limits. **LOW, bounded damage** — but note it interacts with
NM-R2-003: a griefer who has both stacked a deadline and can afford to arm the guard
denies the LP's exit on two independent axes.

**Fix (optional):** floor the arming size in absolute terms, e.g.
`max(backedAirUsd * SETTLE_GUARD_BPS / BPS_DENOM, MIN_POSITION_FEE)`, so a
degenerate-depth pool does not treat dust as a manipulation.

---

## NM-R2-006 — `KEEPER_BOUNTY` removal re-opens NM-003: auto-renew now has no funded actor

**Severity:** LOW (liveness / incentive, no direct loss)
**Locations:** `EXNIHILOPool.sol:1019-1063` (`settleExpired`, and the comment at
`:1022-1028` that replaces the bounty), `EXNIHILOPool.sol:1170-1187`
(`closePositionAfterDeadline`)

The previous round recorded NM-003 as closed *because* `KEEPER_BOUNTY` existed. That
closure is void; re-derived from scratch:

**Who calls settlement now, and what do they earn?**

| Actor | Path | Payoff | Verdict |
|---|---|---|---|
| Profitable holder | `closeLong`/`closeShort` (no expiry check) or `settleExpired` | their own surplus, paid directly | strongly motivated |
| Underwater holder | — | nothing | never acts |
| **LP NFT holder** | `closePositionAfterDeadline` | the position's entire `lockedAmount` returns to its backed reserves; synthetic debt cancelled; `openPositionCount--` unblocks `removeLiquidity` | **the funded keeper** |
| LP, on a renewable position | `settleExpired` | the renewal fee (4/5 of 5 % of mark + the whole impact slice) | strongly motivated |
| Anyone else | either | **zero** | acts only altruistically |

So the removal is defensible: the bounty's job is done better by the LP's own
incentives, and the comment's reasoning ("a bounty carved from the settlement flow
could exceed the payout it was carved from and hand a keeper the holder's entire
profit") is sound — that was a real defect in the old design.

**What is the protocol's state if nobody ever calls it?** The position simply stays
open. The holder can still `closeLong`/`closeShort` (neither has an expiry check) and
can still `renewPosition` (`base = max(deadline, now)` handles the expired case). The
synthetic debt stays in `airUsdSupply`/`airTokenSupply`, continuing to distort SWAP-2/3
for everyone, and `removeLiquidity` stays blocked. Nothing corrupts; it is pure
liveness.

**The residual defect** is narrower than NM-003 was, and specific to auto-renew: a
holder who opts in and stops watching — which is the entire product promise — depends
on *somebody* calling `settleExpired` in the window where the position still clears
`totalFee + margin`. Nobody is paid to. The natural caller is the LP, and for a
`PreMarket`-launched market the LP is a `LockedLpVault`, a passive contract with no
keeper; the `lpOwner` must run a bot. If nobody does, the position's surplus drifts
below the renew band, at which point *anyone* may close it, and the opt-in has bought
nothing. **Compounding with NM-R2-001:** the one party with both the motive and the
funding to call `settleExpired` is also the one party that profits from settling it at
a manipulated price. Fixing NM-R2-001 is what makes this incentive structure safe.

**Fix:** none required in the contract. Recommend documenting that auto-renew is
best-effort and depends on a keeper, and shipping one — the same bot the LP wants for
`removeLiquidity` liveness.

---

## NM-R2-007 — `LockedLpVault` floors the integrator's cut on every harvest, and `harvest()` is permissionless

**Severity:** INFO
**Locations:** `LockedLpVault.sol:225-226` (`_harvest` split),
`LockedLpVault.sol:201-203` (`harvest`, permissionless),
`LockedLpVault.sol:317-326` (`pending`)

`integratorCut = (amount * integratorBps) / BPS_DENOM; lpCut = amount - integratorCut;`
— "dust favours the LP", as documented. But `harvest()` takes no argument, has no
minimum, and anyone may call it, so the split can be applied at whatever granularity
the caller chooses.

**PoC `NEMESIS-R2 / D1`:** with `integratorBps = 5000`, harvesting 1 unit twice gives
`lp = 2, integrator = 0`; a single 2-unit harvest would have paid the integrator 1.
The LP (or a bot on its behalf) can therefore keep the integrator's share at zero by
harvesting one micro-USDC at a time.

Maximum extraction is 0.5 micro-USDC per harvest against ~50k gas, so it is
economically absurd — this is INFO, not a finding you would act on. Recorded because
the coordinator asked directly whether one party can claim the other's cut, and this
is the only mechanism by which the answer is not a flat no.

**Also noted, no action needed:** `claimLpFees` / `claimIntegratorFees` call `_harvest()`
and then `revert NothingToClaim()` if the caller's own accrual is zero, rolling the
harvest back. Harmless — anyone can call `harvest()` standalone — but it means the
integrator cannot use `claimIntegratorFees` to harvest when its cut rounds to zero.

---

## NM-R2-008 — `PreMarket.buyout` hands control to an arbitrary token while `launched` is true but `launchedPool` / `lpVault` are still zero

**Severity:** INFO
**Location:** `PreMarket.sol:501-543`

Ordering inside `buyout`:

```
:501  launched     = true;      tokenReserve = quoteReserve = 0;
:508  quote.safeTransfer(msg.sender, quoteOut);   <-- arbitrary callee-controlled token
:515  factory.createMarket(...)
:526  launchedPool = pool;
:539  lpVault      = address(vault);
```

`quote` is chosen by the seeder and may be any ERC-20, including one with a transfer
hook. During that hook the premarket is observable in a state that never exists
otherwise: `launched() == true` while `launchedPool() == address(0)` and
`lpVault() == address(0)`.

Re-entry into `swap` or `buyout` is blocked (`nonReentrant`, same guard), and I could
find no way to move value from the intermediate state. It is a read-only reentrancy
surface for a third-party integrator that keys off `launched` and then reads
`launchedPool`. **Fix (defensive, optional):** move `:508` below `:543`, or write
`launchedPool` / `lpVault` before any outbound transfer.

Same file, same severity: a direct token transfer to a `PreMarket` address is stranded
— `buyout` forwards `tokenReserve`, not `balanceOf`, so any donated excess is
unreachable forever. Unlike `LockedLpVault`, which deliberately sweeps donations
(`:212-221`), `PreMarket` has no such path.

---

## Carried findings from `.audit/findings-opus5/` — status against the current tree

| ID | Original | Status now | Evidence |
|---|---|---|---|
| **NM-001** — PositionNFT mint reachable before `initFactory` | LOW | **CLOSED** | `PositionNFT.sol:279` and `:308` now open with `if (factory == address(0)) revert FactoryNotSet();`. The old form (`if (factory != address(0) && !isPool(pool))`) skipped the check when unset; the new form makes minting impossible until wired. |
| **NM-002** — factory residual approvals | LOW | **CLOSED** | `EXNIHILOFactory.sol:245-246` calls `forceApprove(pool, 0)` on both legs after `addLiquidity`. `PreMarket.sol:523-524` mirrors it for its own `createMarket` call, so the new contract did not reintroduce it. |
| **NM-005** — `createMarket` lacks token validation | INFO | **CLOSED in the factory, REOPENED in `PreMarket`** | `EXNIHILOFactory.sol:195-197` now rejects zero address, `tokenAddress == usdc`, and zero amounts. `PreMarket`/`PreMarketFactory` do not — see NM-R2-004, where the consequence is worse than the original because there is no retry. |
| **NM-OP5-001** — `swap()` accepts a zero-output trade | LOW (fixed last round) | **STILL FIXED** | `EXNIHILOPool.sol:1476` and `:1510` both `revert InsufficientOutput()` on `netOut == 0`. The fee is now also ceil-divided (`:1722`), which strictly strengthens it. |
| **NM-OP5-002** — `factory.deployer()` can force-close every pool | LOW | **STILL OPEN, and escalated** | `EXNIHILOFactory.sol:93` + `:273-276`, `EXNIHILOPool.sol:501-514` unchanged. New consequence: a `PreMarket`-launched market's LP is a `LockedLpVault`, which by design has no `closePool` and no `removeLiquidity`. A deployer-forced close on such a market permanently stops `openLong`/`openShort` (`:624`, `:749`) while the liquidity can never be withdrawn — so the position-fee stream that the "the fee stream stays claimable by the project and the integrator" pitch (`PreMarket.sol:78-79`) rests on is ended irreversibly by a single external EOA. Recommendation is unchanged and now more pressing: timelock/multisig the role, or zero it at launch. |
| **NM-004** — anyone-can-renew LP exit griefing | closed last round | **partially reopened as NM-R2-003** | The holder-only check at `:995` holds and bounds *who* can renew. It does not bound *how far*, which is the residual. |
| **OFL-1 / OFL-2** — flash-loan manipulation around open/close | accepted | **still accepted, but re-scope** | The impact fee and the 1 % swap-fee floor still make the classic atomic open→move→close round trip lossy, and the project's own `ManipulationSafety.ts` / `Parametric.ts` grids still pass. NM-R2-001 is *not* a variant of these: it does not try to profit from the price move itself, it uses the move only to flip somebody else's settlement branch. |
| **ECS-1** — rebasing tokens | accepted | **unchanged** | `_transferIn` (`:1844`) and `PreMarket._pullExact` (`:555`) and `PreMarketFactory._pullExactTo` (`:176`) all check the balance delta on inbound. Rebase-while-held is still unsupported and still a market-creator responsibility. |

---

## Verified sound — traced end to end, no defect found

| Area | Result |
|---|---|
| **Pool USDC conservation, every path** | Re-derived by hand for the three new/changed flows. Profitable long: `−surplus (backedAirUsd) + closeFee (protocolFees) + netSurplus (out or claimable) = 0`. Profitable short: `restore − lockedAmount + closeFee + netSurplus = 0`, exact because `_priceClose` guarantees `restore + surplus == lockedAmount`. Auto-renew long: `−cost (backedAirUsd) + cost (fees) = 0`. Auto-renew short: `−cost (totalShortCollateral) + cost (fees) = 0`. All balanced. |
| **`airUsdSupply` under auto-renew** | The long branch grows `airUsdMinted` by `cost` without growing `airUsdSupply`, so `_settle` later decrements `airUsdSupply` by more than the position ever added. Traced: net change over a position's life is `−(Σcost + surplus)` on both `airUsdSupply` and `backedAirUsd`, so `backedAirUsd ≤ airUsdSupply` is preserved and no underflow is reachable (`backedAirUsd -= cost` at `:1131` would have reverted first). |
| **Open-interest coupling under the new ramps** | `longOpenInterest` gains `usdcAmount` at open and `cost` at every auto-renew (`:1132`), and loses `pos.airUsdMinted` at settle — which is exactly `N + Σcost`. `shortOpenInterest` gains `usdcNotional` and loses `pos.usdcIn`, which `applyRenewal` never mutates. Both balance. Manual `renewPosition` touches neither, correctly, since it pays cash. |
| **`totalShortCollateral`** | Still non-desyncable after the `KEEPER_BOUNTY` removal deleted the `bountyPaid` clamps. Mutations: `+airUsdOut` (`:791`), `−cost` on auto-renew (`:1140`), `−pos.lockedAmount` in both settle branches (`:1638`, `:1659`). Mirrors `lockedAmount` exactly at every point. |
| **Duration ramp cannot move a deadline backwards** | `currentPositionDuration()` is non-decreasing in `block.timestamp - createdAt`, and nothing reads a stale duration — the `positionDuration` immutable is gone and all five call sites read live. `renewPosition` extends from `max(deadline, now)`; `_tryAutoRenew` from `now` on an already-expired position. Neither can shorten a deadline, so no holder can be surprised into an early expiry. (The *forward* direction is NM-R2-003.) |
| **Cap ramp** | `currentMaxPositionBps()` is a pure function of time with no setter and no writable input; `_checkLeverageCap` reads live `backedAirUsd`. Inflating `backedAirUsd` with a same-transaction swap does widen the cap, but the resulting position is opened at the price the inflating swap created, so the evasion is self-defeating on the long side and is the pre-existing OFL-1/OFL-2 shape on the short side. Not a new hole; the removed `maxPositionUsd`/`maxPositionBps` had the identical live read. |
| **`LockedLpVault` split, both directions** | `lpAccrued + integratorAccrued == usdc.balanceOf(vault)` immediately after every `_harvest`, and each claim zeroes only its own side. Neither party can reach the other's balance: `claimLpFees` pays `lpAccrued` only, `claimIntegratorFees` pays `integratorAccrued` only, and the only other USDC outflow in the contract does not exist. `pending()` agrees with what the claims pay to the unit — PoC D2: pending `6172840 / 6172839`, paid `6172840 / 6172839`, sum exactly the deposited `12345679`. |
| **`LockedLpVault` zero-yield harvest** | `_harvest` returns 0 before any state write when `amount == 0` (`:223`), and skips `pool.claimFees` when the pool has nothing (`:215`), avoiding the pool's `ZeroAmount` revert. A harvest arriving between accrual and claim is handled because both claims call `_harvest()` first (`:248`, `:269`). |
| **`LockedLpVault` role transfer** | `setLp`/`setIntegrator` are each gated on the *current* holder and carry the accrued balance with the role — documented, and PoC D3 confirms the old holder loses access (`NotLp`) and the new holder receives the full prior accrual. No third party can trigger either, so no balance can be stranded or stolen by a transfer. |
| **`LockedLpVault` lock guarantee** | Grepped the contract for `removeLiquidity`, `addLiquidity`, `closePool`, `transferFrom`, `safeTransferFrom`, `approve`, `setApprovalForAll` on `lpNft` — none present. `LpNFT` has no burn and no privileged transfer (`LpNFT.sol` is 76 lines; `mint` is the only mutator and is factory-gated). The NFT genuinely cannot leave. |
| **`LockedLpVault` constructor pairing** | `poolOf(lpNftId_) != pool_` reverts `PoolMismatch` (`:179`), and `usdc` is read from the pool (`:188`) rather than passed, so the two cannot disagree. `PreMarket` supplies `lpNftAddr` from `factory.lpNftContract()`, so the whole chain is factory-derived. |
| **`PreMarket` reserve/balance agreement** | `PreMarketFactory._pullExactTo` sends both legs straight to the premarket with an exact-delta check, so recorded reserves match real balances before `createPreMarket` returns. `swap` and `buyout` move reserves and balances by identical amounts. `buyout` forwards exactly `tokenReserve` and `usdcIn` to `createMarket` and exactly `quoteReserve` to the buyer — nothing double-counted, nothing left behind except donations (NM-R2-008). |
| **`PreMarket` reserves cannot be fully drained by swapping** | `getAmountOut` returns `floor(a·Ro/(b+a))` with `b = reserveIn · BPS_DENOM ≥ 1`, so the fraction is strictly below 1 and the output is at most `reserveOut − 1`. Both legs stay ≥ 1, so `createMarket`'s `tokenAmount != 0` can never be tripped by trading. The constructor comment at `:487-489` is correct. |
| **`buyout` racing a `swap` in the same block** | Both are `nonReentrant` on the same guard, so they cannot interleave. Sequenced within a block, `maxUsdc` protects the buyer against a quote-in swap raising the cost and `minQuoteOut` protects against a token-in swap draining the reserve; cost is proportional to `quoteOut`, so a partial drain reduces both together. Correct **except at the floor**, where proportionality is lost — that is NM-R2-002, and it is the only failure of this pair. |
| **`PreMarket` handoff to `createMarket`** | `token.forceApprove(factory, tokenOut)` / `usdc.forceApprove(factory, usdcIn)` then `createMarket(token, usdcIn, tokenOut)` then both approvals revoked. The LP NFT arrives at the premarket (`createMarket` transfers to `msg.sender`) and is forwarded to the vault in the same transaction, so no block exists in which it is withdrawable. Verified by PoC A1: the launched pool's `backedAirToken` equals the seeded `tokenAmount` exactly. |
| **Reentrancy across the new contracts** | `PreMarket.swap`/`buyout`, `PreMarketFactory.createPreMarket`, `LockedLpVault.harvest`/`claimLpFees`/`claimIntegratorFees` are all `nonReentrant`, all with CEI ordering (reserves and flags written before transfers). `LockedLpVault._harvest` calls into the pool's own `nonReentrant claimFees` from a different guard, which is correct and not a conflict. |
| **`_cpAmountOut` ceil-divide change** | Rounding the fee up is conservative in every consumer: it lowers a long's `airUsdOut` and raises a short's buyback `cost`, so `_priceClose` never over-credits a holder and the pool never owes more than it holds. |
| **Pull-payment property (DoS-2)** | Not regressed by any of the new code. `_creditPayout` is a pure state write; `claimPayout`, `claimFees`, `claimProtocolFees` and both vault claims take a destination, so a USDC-blacklisted party can always redirect and can never block anyone else's operation. |

---

## Scope limits of this pass

**Reviewed in depth:** the three new contracts in full; the pool's cap ramp, duration
ramp, settlement guard, fee reweighting, `KEEPER_BOUNTY` removal, `_renewFees`,
`_openFees`, `_priceClose`, `_settle`, `_tryAutoRenew`, `_quoteShortfall`, and the
whole conservation algebra; the factory and `PositionNFT` deltas.

**Not reviewed in depth:** `PositionNFT`'s SVG/metadata rendering and `_netReturn`
display math (display only, no value path); `EXNIHILORouter` beyond confirming its
2-line delta is a comment; `Faucet.sol` (unchanged, testnet-only); the indexer's
reading of the new `Swap` event.

**Test-suite note the coordinator should act on:** the project's existing test at
`AutoRenew.ts:871`, "opening a position does not arm the guard", asserts the *safe*
half of NM-R2-001 and so reads as coverage of it. It opens a **long** against a
**long** victim — the one cross-pairing that genuinely has no effect, because
`openLong` writes `airUsdSupply` and `backedAirToken` while a long settles against
`airTokenSupply` and `backedAirUsd`. It therefore passes for the wrong reason and hides
the two pairings that do bite. Re-point it at `openShort`→long and `openLong`→short
(PoCs B3 and J1) when fixing.

**Suite state at time of writing:** `npx hardhat test` from `packages/blockchain`
gives **617 passing, 4 failing**, and all four failures are in other passes' probe
files (`ZZAuditProbe.ts`, `ZZTempSgaVerify.ts`, `_dosPoC.ts`), not in the project's
own tests. The 8 storage-slot `Coverage.ts` failures the previous round recorded are
gone. My own probe file adds 19 passing.
