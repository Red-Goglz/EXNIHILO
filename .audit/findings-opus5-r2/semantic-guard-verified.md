# Semantic Guard Analysis — Verified (Opus 5 R2)

**Date:** 2026-08-20
**Baseline:** `.audit/findings-opus5/semantic-guard-verified.md` (tree `5197494`)
**Method:** Consistency Principle — the contract is its own specification. Where a
guard is applied across a family of functions, its absence in one member is the
defect candidate. Where the absence is deliberate, the contract's own stated
reason for the exemption is itself treated as a claim to be falsified.

**Scope actually covered.** Full guard matrix over every state-changing external
in `LockedLpVault.sol`, `PreMarket.sol`, `PreMarketFactory.sol`, `EXNIHILOPool.sol`,
`PositionNFT.sol`, `EXNIHILOFactory.sol`, `EXNIHILORouter.sol`, `LpNFT.sol`,
`PoolDeployer.sol`. Two findings were confirmed on-chain against the working tree
before being written up; the test file used for that was deleted afterwards and no
contract was modified.

```
0 CRITICAL | 1 HIGH | 1 MEDIUM | 1 LOW | 3 INFO
```

---

## SGA2-1 — HIGH — the settlement guard is armed by `swap` only, and the cross-side position open moves *exactly* the reserves it protects

**Guard:** `EXNIHILOPool.sol:1437` `_armSettlementGuard` / `EXNIHILOPool.sol:1452` `_assertSettlementUnguarded`
**Armed at:** `EXNIHILOPool.sol:1482` (`_swapTokenToUsdc`), `EXNIHILOPool.sol:1515` (`_swapUsdcToToken`) — those two sites only.
**Not armed at:** `EXNIHILOPool.sol:650-660` (`openLong`), `EXNIHILOPool.sol:780-791` (`openShort`)
**False claim under test:** `EXNIHILOPool.sol:1075-1078` — *"Requiring the test to clear by RENEW_MARGIN_BPS of the position's MARK means any flip needs a swap large enough to arm that guard."*

### The asymmetry

`_priceClose` reads a *different reserve pair per side* (`EXNIHILOPool.sol:1557-1590`):

| Victim | Reserves its settlement price reads |
|---|---|
| Long | `airTokenSupply` (in), `backedAirUsd` (out) — line 1564-1568 |
| Short | `airUsdSupply` (in), `backedAirToken` (out) — line 1578-1582 |

Now the writes:

| Path | `airTokenSupply` | `backedAirUsd` | `airUsdSupply` | `backedAirToken` | arms? |
|---|---|---|---|---|---|
| `_swapTokenToUsdc` 1486-1489 | ↑ | ↓ | ↓ | ↑ | **✓** |
| `_swapUsdcToToken` 1519-1522 | ↓ | ↑ | ↑ | ↓ | **✓** |
| `openShort` 784-791 | **↑** | **↓** | — | — | **✗** |
| `openLong` 656-660 | — | — | **↑** | **↓** | **✗** |

`openShort` moves both of a long's pricing reserves, and only those. `openLong`
moves both of a short's pricing reserves, and only those. Each is a *purer*
settlement-price weapon than a swap, which moves all four and partly self-cancels.

The existing regression test asserts the exemption is harmless — `AutoRenew.ts:871`
*"opening a position does not arm the guard"* — but it opens a **long** against a
**long** victim, the one pairing that provably cannot move anything (`openLong`
touches neither `airTokenSupply` nor `backedAirUsd`). The team knows this: the
comment at `AutoRenew.ts:249` says an `openLong` *"does not move A's surplus, only
OI."* The cross pairing was never tested.

### Confirmed exploit (measured against the working tree)

Pool with `backedAirUsd ≈ 10,600 USDC`. Victim is a 100 USDC long, `setAutoRenew`
enabled, expired, honestly clearing the margin:

```
arming size a swap must reach (1 % of backedAirUsd) = 106.000000 USDC
victim surplus 8.878543 | renew fee 5.514680 | margin 2.177570 | headroom 1.186293
attacker: openShort(notional = 106.000000 USDC)   ← exactly the swap arming size
  → backedAirUsd fell 103.890495 (98 % of the arming size)
  → lastLargeSwapBlock unchanged — guard NEVER armed
  → victim surplus 8.878543 → 6.744099  (swing 2.134444, vs a 2.177570 margin)
  → verdict flips renewable → NOT renewable
attacker calls settleExpired(nftId, 0) in the very next call — no revert.
The holder's opted-in position is closed and the NFT burned.
```

At a larger position size the margin is not even close: a `1200` USDC short (well
under the `2120` USDC cap) moved `backedAirUsd` by `1078.909090` — **9× the arming
size** — and swung the surplus by `24.014111` against a `2.782058` margin, still
without arming.

### Why the fee-cost justification at `EXNIHILOPool.sol:391-392` does not hold

The comment exempts the open paths because they *"pay a 5 % fee of which the 1 %
protocol share is a real loss even to the LP."* Three things it misses:

1. **The LP is rebated 80 % of its own weapon.** Of the 5.30 USDC open fee, 4.24
   returns via `_accrueLpFee` (`EXNIHILOPool.sol:799`) plus the whole impact fee.
   Net unrecoverable cost to the sole LP: **1.06 USDC**, not 5.30.
2. **The short position itself is capital-neutral to the LP.** Open takes
   `backedAirUsd -= airUsdOut` into `totalShortCollateral` (788-791); an underwater
   settle returns `backedAirUsd += pos.lockedAmount` and `totalShortCollateral -=
   pos.lockedAmount` (1636-1638), and `pos.lockedAmount == airUsdOut` exactly. A
   profitable settle costs only the 1 % close fee. Either way the reserve
   round-trips. The LP is not taking directional risk it must pay to unwind.
3. **The distortion persists, so atomicity is not required.** A swap's
   manipulation is arbitraged away — which is the entire point of holding a third
   party off for `SETTLE_GUARD_BLOCKS`. Half of an `openShort`'s distortion is
   `airTokenSupply` inflation, pure synthetic debt that no arbitrage can touch
   until the short is closed. This route is *more* durable than the one the guard
   blocks, not less.

Against the measured numbers the LP spends 1.06 USDC net, keeps 2.11 USDC of a
payout it would otherwise have paid out, and sheds an option it was on the wrong
side of. ~+1 % of notional per expiry, repeatable, scaling linearly to the 20 %
position cap.

### It is not only the auto-renew flip

`settleExpired:1056-1057` states the guard protects *"both outcomes: the renew/close
decision below and, on the close path, the surplus `_settle` pays out."* The second
half is equally open. A position with **no** auto-renew, expired, is settled through
`closePositionAfterDeadline`; the same non-arming `openShort` cuts the credited
`netSurplus` (`_settle:1645-1646`) by the same 24 %.

The holder has no fallback here, and this is a guard-consistency point in its own
right: on `closeLong`/`closeShort` the slippage bound `minUsdcOut` is chosen by the
holder, who is the beneficiary. On `settleExpired:1050` and
`closePositionAfterDeadline:1170` the bound `minPayout` is chosen by **the caller** —
who on this path is the attacker, and will pass `0`. Last round recorded "slippage
protection is universal"; that is true syntactically but on the two permissionless
paths the bound is held by a party with no interest in enforcing it. The settlement
guard is the *only* thing standing in for it, which is why this hole is load-bearing.

### Why I believe it

Measured, not argued: the reserve deltas, the unchanged `lastLargeSwapBlock`, the
flipped verdict, and the burned NFT were all observed against this working tree.
The reserve mapping in the table above is read directly off `_priceClose` and the
two open paths and admits no alternative reading.

### Remediation shape (not applied — SCOPE rule 6)

Arming from the open paths (`airUsdOut` for `openShort`, `usdcAmount` for `openLong`
— each is that path's displacement of the victim side's reserve) raises the bar but
does **not** close it: five blocks of arbitrage restores the `backedAirUsd` /
`backedAirToken` half and leaves the synthetic-supply half untouched, roughly half
the swing. A closure likely needs either the expiry pricing to exclude same-side OI
opened after the position expired, or `RENEW_MARGIN_BPS` re-based on total reserve
displacement since expiry rather than on swap size. Coordinator's call.

**Deployment note:** all of `_armSettlementGuard`, `_assertSettlementUnguarded`,
`RENEW_MARGIN_BPS` and the `settleExpired` auto-renew branch are new since the
audited baseline and are **not** on the mainnet deploy at `c72f6a7`. This is a
pre-launch defect in new code, not a live incident.

---

## SGA2-2 — MEDIUM — `PreMarket` validates one of the factory's two token preconditions at seed time and misses the other, stranding the seed permanently

**Missing guard:** `PreMarket.sol:302-314` (constructor) and `PreMarketFactory.sol:120-121`
**Revert it fails to anticipate:** `EXNIHILOFactory.sol:196` — `if (tokenAddress == usdc) revert TokenIsUsdc();`
**Stated rule it violates:** `PreMarket.sol:107-110` — *"Market parameters are validated at seed time, not at buyout. With no expiry path, a pool constructor revert during buyout would strand the premarket's liquidity permanently rather than merely delaying it."*

### The asymmetry

`EXNIHILOFactory.createMarket` has exactly two address preconditions on
`tokenAddress`. `PreMarket`'s constructor checks the factory's `usdc` for agreement
(`PreMarket.sol:311`, `UsdcMismatch`) and checks `c.token != address(0)`
(`PreMarket.sol:302`) — but never compares the two. `PreMarketFactory` repeats the
zero check (`:120`) and likewise not the equality.

`TokenIsUsdc` is **new in this round's factory delta** (SCOPE item 10). `PreMarket`
is new code written against the new factory, and this is the one precondition that
did not make it across.

### Confirmed exploit (measured against the working tree)

```
pmFactory.createPreMarket({ token: <USDC>, tokenAmount: 50,000 USDC,
                            quote: <WAVAX>, quoteAmount: 500, ... })   → SUCCEEDS
  premarket now holds 50,000.000000 USDC + 500e18 quote, registered in isPreMarket
buyout(maxUsdc = MAX, minQuoteOut = 0)   → reverts EXNIHILOFactory.TokenIsUsdc
+365 days later, auction fully decayed to the floor
buyout(...)                               → reverts EXNIHILOFactory.TokenIsUsdc
```

`buyout` is the only exit. The full external surface of `PreMarket` is
`buyout, buyoutCost, creator, currentPrice, decayBpsPerMinute, factory,
getAmountOut, integrator, launchUsdc, launched, launchedPool, lpOwner, lpVault,
quote, quoteReserve, quoteUnit, startPrice, startTime, swap, swapFeeBps, token,
tokenReserve, usdc` — no `withdraw`, `rescue`, `refund`, `cancel`, `sweep`, or
`emergencyWithdraw`. Both legs are locked for good.

### Why I believe it

Executed end to end. The seed transfer really lands (`50000000000` atoms measured in
the premarket), and the buyout revert is the factory's own `TokenIsUsdc`, before and
after full decay. `PreMarketFactory` is permissionless, so nothing gates the
mistake.

### Severity reasoning

Not stealable — only the seeder loses, and only by supplying USDC as the project
token. But the loss is total, permanent, and irreversible, and the contract
explicitly promises the class of check that would have caught it. MEDIUM rather
than LOW because the amount is unbounded (whole seed) and the damage is not
recoverable by any party.

### Adjacent, same root, not separately findable

The same "any `createMarket` revert at buyout is permanent" exposure exists for
conditions that *cannot* be validated at seed: a token that blocklists the
`PreMarket` address after seeding, or a rebasing token whose balance drifts below
`tokenReserve` before buyout. Both make `createMarket`'s `safeTransferFrom` fail
forever. Worth the coordinator's attention as a structural argument for an escape
hatch, but it is not a missing guard and I am not counting it as a finding.

---

## SGA2-3 — LOW — `LockedLpVault.onERC721Received` accepts any NFT from any contract, in a vault with no way to send one back

**Location:** `LockedLpVault.sol:342-349`

The vault validates NFT identity rigorously everywhere else — the constructor
rejects a mismatched pairing with `PoolMismatch` (`:179`) and `isFunded()` checks
`lpNft.ownerOf(lpNftId) == address(this)` (`:331`). The one place an NFT actually
arrives performs no check at all: it ignores `operator`, `from`, `tokenId` and
`msg.sender` and unconditionally returns the magic value.

**Failure path.** Anyone `safeTransferFrom`s any ERC-721 to the vault. The hook
accepts it. The vault contains no `transferFrom`, `safeTransferFrom`, `approve` or
`setApprovalForAll` call — by design, that is its entire selling point (`:46-52`) —
so the NFT is permanently, irrecoverably lost. This is not hypothetical for a
contract whose advertised role is "send your LP NFT here": a wrong `tokenId` or the
wrong LP NFT for a sibling market is exactly the mistake the interface invites.

**Why tightening costs nothing.** `PreMarket.buyout:543` moves the NFT in with plain
`transferFrom`, which never invokes the hook. The hook exists solely so a wallet
using `safeTransferFrom` cannot fail (`:336-341`). Restricting it to
`msg.sender == address(lpNft) && tokenId == lpNftId` preserves that use entirely and
turns an irreversible loss into a revert.

---

## SGA2-4 — INFO — `setLp` / `setIntegrator` lack `nonReentrant`, and nothing marks the exemption as deliberate

**Location:** `LockedLpVault.sol:291` (`setLp`), `LockedLpVault.sol:303` (`setIntegrator`)

Guard matrix for `LockedLpVault`'s state-changing externals:

| Function | `nonReentrant` | Authorization | Zero-address | Empty check |
|---|---|---|---|---|
| `harvest` 201 | ✓ | permissionless (by design) | n/a | returns 0 |
| `claimLpFees` 244 | ✓ | `msg.sender != lp` → `NotLp` | `to != 0` | `NothingToClaim` |
| `claimIntegratorFees` 265 | ✓ | `msg.sender != integrator` → `NotIntegrator` | `to != 0` | `NothingToClaim` |
| `setLp` 291 | **✗** | `msg.sender != lp` → `NotLp` | `newLp != 0` | n/a |
| `setIntegrator` 303 | **✗** | `msg.sender != integrator` → `NotIntegrator` | `newIntegrator != 0` | n/a |
| `onERC721Received` 342 | ✗ (pure) | **none** — see SGA2-3 | n/a | n/a |

**The `NotLp` / `NotIntegrator` families are perfectly symmetric.** Two functions
each, each guarded, each with the matching zero-address rule, each with the
counterpart error. There is no missing authorization check anywhere in this
contract — I looked for one specifically and it is not there.

**Verdict on the `nonReentrant` gap: safe in effect, unmarked as intentional.**

1. Neither setter makes any external call, so classic reentrancy is impossible.
2. Cross-function entry would have to come from a token callback inside
   `usdc.safeTransfer` (`:256`, `:277`) or `pool.claimFees` (`:216`). Such a
   callback runs with `msg.sender == token`, and both setters gate on
   `msg.sender == lp` / `== integrator` — it can only reach them if the token
   contract *is* the role holder.
3. Even then the claim functions are strict CEI: `lpAccrued = 0` and
   `lpClaimedTotal += amount` are written before the transfer (`:253-256`).
   Rotating `lp` mid-transfer cannot re-open a claim that is already zeroed, and
   re-entering `claimLpFees` itself is caught by `nonReentrant`.
4. Neither setter reads or writes any accounting state.

This is the same shape as last round's INFO-SGA-1, and it is flagged for the same
reason: 3 of 5 state-changing externals carry the modifier and nothing in the code
says why the other 2 do not. Either add it (a one-off ~2.4k gas on a function called
approximately never) or add the one-line comment.

---

## SGA2-5 — INFO — the claim functions inherit `_harvest`'s unfunded-vault revert, freezing an already-accrued balance

**Location:** `LockedLpVault.sol:212-218` (`_harvest`), reached unconditionally from
`claimLpFees:248` and `claimIntegratorFees:269`

`_harvest` guards **one** of `pool.claimFees`'s two reachable reverts and not the
other:

- `ZeroAmount` (`EXNIHILOPool.sol:929`) — guarded, by `if (pool.lpFeesAccumulated() != 0)` at `:215`.
- `OnlyLpHolder` (`EXNIHILOPool.sol:483`) — **not guarded**, although the vault
  already owns the exact predicate as a view: `isFunded()` at `:330-332`.

**Failure path.** A vault deployed but never handed the NFT. USDC is donated to it
(the contract advertises this at `:205-210` and `LockedLpVault.ts:428` tests it)
while `pool.lpFeesAccumulated() == 0`, so `harvest()` succeeds and credits
`lpAccrued`. The pool later accrues fees from ordinary trading. From that point
`claimLpFees` and `claimIntegratorFees` both revert `OnlyLpHolder` inside `_harvest`
before ever reaching the accrued balance they were called to pay out. The already-
credited funds are frozen for as long as the NFT is absent, and forever if it never
arrives.

**Why this is INFO and not LOW.** `PreMarket.buyout` is the only in-repo deployer of
a vault and it constructs the vault and transfers the NFT in the same transaction
(`PreMarket.sol:531-543`); no script or frontend deploys one standalone. And once
funded a vault can never lose the NFT — it holds no `transferFrom`, `approve` or
`setApprovalForAll` call. So the state is only reachable by deploying a vault by
hand and not funding it. `LockedLpVault.ts:443` already tests that bare `harvest()`
reverts in that state; what is untested is that the *claims* inherit it. A
`if (isFunded())` wrapper on the `claimFees` call at `:215` would decouple them.

---

## INFO-SGA-2 (carried from `.audit/findings-opus5/`) — still holds, and the delta strengthened it

`_assertReserveInvariant` is called at 7 sites: `openLong:680`, `openShort:811`,
`addLiquidity:884`, `_tryAutoRenew:1148`, `_swapTokenToUsdc:1495`,
`_swapUsdcToToken:1528`, `_settle:1674`. Of the paths that mutate backed reserves,
`removeLiquidity:896` remains the only one without it.

Re-verified against the current code, including the new `totalShortCollateral` term
in the invariant (`:1914-1921`): `removeLiquidity` requires `openPositionCount == 0`
(`:897`), and `totalShortCollateral` is incremented only in `openShort:791` and
decremented by the same `pos.lockedAmount` in both `_settle` short branches
(`:1638`, `:1659`) and by `cost` in `_tryAutoRenew:1140` alongside the matching
`lockedAmount - cost` written to the NFT (`:1142`). So `totalShortCollateral == 0`
whenever `removeLiquidity` can run, and the function zeroes both reserves while
transferring exactly those amounts. The invariant holds afterwards by construction.

Notably the **new** equity-funded renewal path *does* assert (`:1148`), which is
right: it moves `backedAirUsd`. The cash-funded `renewPosition:994` still does not,
and still does not need to — it pulls `totalFee` and credits exactly `totalFee`
(`_renewFees` keeps `protocolFee + lpFee == totalFee` including the impact term,
`:1791-1800`). The family is now cleaner than it was last round, not worse.

---

## INFO-SGA-1 (carried) — **CLOSED, by deletion, verified**

`setPositionCaps` is gone from the source. Confirmed it was removed rather than
renamed or relocated: `grep` across `contracts/` returns no definition, and the
suite asserts its absence from the deployed ABI in three independent places —
`EXNIHILOPool.ts:996`, `EXNIHILOFactory.ts:292-293`, `PositionCapRamp.ts:262`
(which also asserts `maxPositionUsd` and `maxPositionBps` are gone), plus
`LockedLpVault.ts:284` asserting the vault exposes no such function. Its replacement
`currentMaxPositionBps():1290` is a `view` with no setter and no privileged caller,
so the reentrancy column that the finding was about no longer has a row to fill.

---

## Checked and clean

**Every settlement-reachable path is covered, with no back door.** `_settle` is
called from exactly four sites: `closeLong:718`, `closeShort:843`,
`settleExpired:1062`, `closePositionAfterDeadline:1186`. The two permissionless ones
call `_assertSettlementUnguarded` first (`:1058`, `:1176`). The two holder ones do
not need it: both establish `positionNFT.ownerOf(nftId) == msg.sender` before
settling (`:711-712`, `:836-837`), which is exactly the branch the assertion
short-circuits on at `:1453`. Four of four accounted for. No internal caller of
`_settle` bypasses it, and no external function reaches it by another route. The
`msg.sender == holder` exemption is correct and necessary — without it an armed
guard could trap a holder in their own position.

**The ramped cap is enforced on every position-opening path.** `_checkLeverageCap`
is called at `openLong:629` and `openShort:754`, which are the only two functions
that mint a position. It reads `currentMaxPositionBps()` (`:1829`), so the ramp is
live rather than snapshotted. `EXNIHILORouter` cannot reach around it: its
`openLong:75` and `openShort:90` forward straight to the pool's own entry points and
add nothing, and all three router entry points carry `onlyPool(pool)` (`:44-47`) plus
the same `_refundResidual` cleanup. `_tryAutoRenew:1132` grows a long's
`longOpenInterest` by `cost` without re-checking the cap, and that is correct rather
than a gap — `effectiveLeverageCap()` moves with `backedAirUsd`, so a live position
routinely sits above the current cap purely from reserve movement. The cap is an
entry control, never an ongoing invariant, and re-checking it at renewal would
invent an invariant the contract does not claim.

**`PreMarket`'s `AlreadyLaunched` family is complete.** The contract has exactly two
state-changing externals — `swap:416` and `buyout:480` — and both check `launched`
first (`:422`, `:484`). I enumerated the full external surface from the compiled ABI
to be sure nothing was missed; everything else is `view` or `pure`. `launched` is set
in the EFFECTS block at `:501` before every interaction, so neither a malicious
`quote` token (transferred at `:508`, before any approval is granted) nor a malicious
`token` (pulled during `createMarket` at `:515`) can re-enter a still-open AMM.
`buyout` correctly omits the `to != address(0)` check that `swap:424` carries — it
has no `to`, output goes to `msg.sender`. `buyoutCost():369` reports
`(MIN_BUYOUT_USDC, 0)` after launch, which is misleading but inert since `buyout`
reverts. The reserves-stay-non-zero claim at `:486-487` is sound: `getAmountOut`'s
denominator strictly exceeds its numerator's `amountInWithFee` term (`:402`), so no
swap can fully drain a side.

**`PositionNFT`'s only-pool / only-factory family is intact.** The 170-line delta is
entirely presentational — `_netReturn`, the `_readLive` PnL handling, and SVG
geometry. `git diff` hunks start at line 170 and none touch an access-controlled
function. Re-verified anyway: `mintLong:279-281` and `mintShort:308-310` each carry
all three checks (`FactoryNotSet`, `msg.sender == pool`, `factory.isPool(pool)`);
`applyRenewal:348-349` and `release:405-406` each carry `PositionNotFound` +
`msg.sender == pos.pool`; `setAutoRenew:368-369` carries `PositionNotFound` +
`OnlyTokenOwner`; `initFactory:126-128` is deployer-only and one-shot. The apparent
asymmetry — mint re-checks factory registration, `applyRenewal`/`release` do not — is
sound: `pos.pool` can only have been written by a mint that already passed
`isPool`, and `EXNIHILOFactory` has no deregistration path (`isPool` is written once
at `:254` and never cleared). `_update:389-399` clears the auto-renew opt-in on every
ownership change including the burn inside `release`, so no keeper authorization
survives a transfer.

**`pos.pool == address(this)` is now universal, including on views.** All seven
`nftId`-taking functions check it: `closeLong:715`, `closeShort:840`,
`renewPosition:998`, `settleExpired:1052`, `closePositionAfterDeadline:1172`,
`quoteRenewFee:1353`, `quoteClose:1384`. Last round this held for the six
state-changing members; the two new views adopted it too.

**`closeDate` handling is consistently split by function kind.** The two open paths
hard-block (`PoolClosing` at `:624`, `:749`); the two renewal paths instead bound the
new deadline (`RenewalExceedsCloseDate` at `:1008`, and the equivalent early return
at `:1105`). The two use different bases — `max(pos.deadline, now)` vs
`block.timestamp` — which is equivalent, because `_autoRenewQuote` is only reachable
for expired positions (`:1053`, `:1173`) and `_tryAutoRenew:1122` computes the
deadline the same way the quote did. `swap` and `addLiquidity` deliberately stay open
so a closing pool can still price and settle. No inconsistency.

**`LockedLpVault`'s fee split cannot be gamed by either counterparty.**
`integratorBps` is immutable (`:102`), the split is applied to each harvested lump in
one place (`:225-230`), and both claims zero only their own accrual. The
balance-based `amount = balanceOf - lpAccrued - integratorAccrued` (`:221`) cannot
underflow: the only outflows are the two claims, each transferring exactly the
accrual it zeroes (`:253-256`, `:274-277`), so `balance >= lpAccrued +
integratorAccrued` is preserved by every path. Dust favours the LP by construction
(`:226`); grinding it by harvesting one atom at a time would cost more gas per atom
than the atom is worth, and pool-side accruals arrive in lumps of at least
`MIN_POSITION_FEE × 4/5` anyway, on which the 5000-bps split rounds exactly. A dead
integrator key strands only the integrator's own accrual and does not disturb the LP
side. The vault genuinely contains no `removeLiquidity`, `addLiquidity`, `closePool`,
`transferFrom` or `approve` call — the lock guarantee at `:46-52` holds as written.

**`minPayout` on the expiry paths is ignored when auto-renew fires** — `_tryAutoRenew`
returns before `_settle` at `:1060`. Not a defect: the caller is not the beneficiary,
and the holder's own bound is the `maxFee` they set via `setAutoRenew`, which
`_autoRenewQuote:1098` enforces. Noted because a keeper reading `settleExpired`'s
signature would reasonably expect otherwise.

**`EXNIHILOFactory.createMarket` ordering is safe despite registering last.**
`isPool[pool] = true` is written at `:254`, after `addLiquidity:241`. That is fine —
`addLiquidity` does not consult the registry — and the pool cannot mint a position
before registration because `mintLong`/`mintShort` check `isPool`. `LpNFT.mint:68-69`
is factory-gated and the id prediction (`allPools.length`, `:224`) is structurally
sound since both counters start at zero and advance together.

---

## For the other passes

- **Reentrancy pass:** SGA2-1 needs no reentrancy at all — `openShort` and
  `settleExpired` are two ordinary sequential external calls, so `nonReentrant` on
  both is irrelevant to it. Please do not mark it covered by the reentrancy analysis.
- **Economic / NM pass:** SCOPE item 6 voids NM-003's closure. Worth pairing with
  SGA2-1: with `KEEPER_BOUNTY` gone, the only party with a standing reason to call
  `settleExpired` on someone else's position is the LP — who is also the sole
  beneficiary of manipulating what that call pays out. The incentive gap and the
  guard gap point at the same actor.
- **Arithmetic pass:** `PreMarket.currentPrice:356` computes
  `startPrice * decayBpsPerMinute * elapsed` unbounded, and `_buyoutCost:380`
  computes `quoteOut * price`, with `startPrice` validated only as non-zero
  (`:313`). Overflow needs a `startPrice` around 1e63, i.e. nonsensical input, so I
  did not raise it — but if either overflows the result is the same permanent
  lockup as SGA2-2, so it may be worth a bound in your pass.
