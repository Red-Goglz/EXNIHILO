# Reentrancy — Verified (Opus 5 R2)

**Date:** 2026-08-20
**Baseline:** `.audit/findings-opus5/reentrancy-verified.md` (commit `5197494`); this pass
covers HEAD `c02af1d` plus the uncommitted working tree.
**Scope:** `PreMarket`, `PreMarketFactory`, `LockedLpVault` (all three unaudited),
the `EXNIHILOPool` delta, `PositionNFT`, `EXNIHILOFactory`, `EXNIHILORouter`, `LpNFT`,
`test/ReentrantToken`. All four variants: classic, cross-function, cross-contract, read-only.

```
0 CRITICAL | 0 HIGH | 0 MEDIUM | 2 LOW (1 new, 1 carried/accepted) | 4 INFO
```

Nothing found in this pass lets LP funds be drained or value be stolen. The one new
LOW is a cross-contract window that is real and reachable but currently closed by an
incidental check rather than by any guard. Three of the four INFO items were verified
empirically with throwaway Hardhat probes (since deleted; no contract or test file in
the repo was modified).

---

## Guard coverage — recounted from the contract body

The prior round reported "26 external functions" in `EXNIHILOPool` with one unguarded
exception. That count included declarations from the `IPositionNFT` / `ILpNFT` /
`IEXNIHILOFactory` interface blocks at `EXNIHILOPool.sol:39-87` (e.g. `getAutoRenew`,
listed there as a pool view, is `IPositionNFT.getAutoRenew` at line 69). Recounting only
functions declared inside `contract EXNIHILOPool` (starts at `EXNIHILOPool.sol:163`):

| | Baseline | Now |
|---|---|---|
| State-mutating `external` | 15 | **14** |
| `view` / `pure` `external`+`public` | 9 | **13** |
| **Total in-contract** | **24** | **27** |

Derived from `git diff -U0 -- contracts/EXNIHILOPool.sol`, which shows exactly one
removed declaration (`setPositionCaps`) and four added views
(`currentMaxPositionBps`, `currentPositionDuration`, `settlementGuardedUntilBlock`,
`settlementGuardArmingSize`), plus two internal helpers and a re-signature of the two
swap helpers.

**All 14 state-mutating external functions carry `nonReentrant`**, verified
mechanically over the parsed signature list: `closePool` (501), `swap` (574),
`openLong` (619), `closeLong` (710), `openShort` (744), `closeShort` (835),
`addLiquidity` (863), `removeLiquidity` (896), `claimFees` (926),
`claimProtocolFees` (944), `claimPayout` (963), `renewPosition` (994),
`settleExpired` (1050), `closePositionAfterDeadline` (1170). There is now **no**
unguarded mutator in the pool.

Per-contract coverage of the rest:

| Contract | Mutating externals | Guarded | Unguarded |
|---|---|---|---|
| `PreMarket` | 2 — `swap` (416), `buyout` (480) | 2 | 0 |
| `PreMarketFactory` | 1 — `createPreMarket` (117) | 1 | 0 |
| `LockedLpVault` | 5 | 3 | 2 — `setLp` (291), `setIntegrator` (303) — see INFO-RE2-4 |
| `EXNIHILOFactory` | 2 — `createMarket` (182), `setDeployer` (273) | 1 | 1 — `setDeployer`, no external call in its path |
| `EXNIHILORouter` | 3 | 3 | 0 |
| `PositionNFT` | 6 | 0 (no `ReentrancyGuard` at all) | 6 — analysed clean, see below |

`ReentrancyGuard` is declared on `PreMarket`, `PreMarketFactory` and `LockedLpVault`,
and in each case the modifier is genuinely applied, not merely inherited.

---

## RE2-1 — LOW — the child `PreMarket` is live and callable during the factory's seeding pulls

**Files:** `PreMarketFactory.sol:133-158`, `PreMarket.sol:301-333`, `PreMarket.sol:416`, `PreMarket.sol:480`
**Variant:** cross-contract
**Guard status:** unguarded across the boundary (each contract holds its own separate `_status` slot)

### The window

`createPreMarket` constructs the `PreMarket` first and funds it second:

```
133   preMarket = address(new PreMarket(Config{...}, p.tokenAmount, p.quoteAmount));
154   _pullExactTo(p.token,  msg.sender, preMarket, p.tokenAmount);
155   _pullExactTo(p.quote,  msg.sender, preMarket, p.quoteAmount);
157   isPreMarket[preMarket] = true;
158   allPreMarkets.push(preMarket);
```

The constructor writes `tokenReserve = tokenAmount; quoteReserve = quoteAmount`
(`PreMarket.sol:329-330`) while the contract holds nothing. Between line 133 and line 155
the premarket is a fully live, publicly callable AMM whose recorded reserves overstate
its real balances, and whose auction (`buyout`) is armed over a quote reserve it does not
hold. `PreMarketFactory`'s `nonReentrant` does not extend to it — the guards are separate
instances in separate contracts.

`p.token` and `p.quote` are arbitrary caller-supplied ERC-20s, and `_pullExactTo` hands
them control twice each: once at `IERC20(asset).balanceOf(to)` (`PreMarketFactory.sol:177`)
and once at `safeTransferFrom` (line 178).

### Verified reachable

Three probes, using the repo's own `ReentrantToken` as the quote asset, with the
premarket address predicted as `CREATE(pmFactory, nonce 1)`:

| Re-entrant call made during the quote pull | Revert returned |
|---|---|
| `preMarket.swap(0, 0, false, x)` | `ZeroAmount` |
| `preMarket.buyout(0, 0)` | `CostExceedsMax` |
| `pmFactory.createPreMarket(...)` (re-enter the **parent**) | `ReentrancyGuardReentrantCall` |

The first two are the **child's own input validation** — the function bodies executed.
`buyout` in particular got as far as pricing the auction off `quoteReserve`, i.e. off
reserves the contract did not hold. No reentrancy guard fired in either case. Only the
third — re-entering the parent — is blocked by a guard.

That third case is exactly and only what the repo tests: `test/PreMarket.ts:1296`,
*"blocks re-entering createPreMarket while it is seeding"*. The suite proves the boundary
that was never at risk and does not touch the one that is.

### Why it is not currently exploitable

I tried to drain it and it reverted. Seeding a real token as `p.token` and a hostile
token as `p.quote`, then re-entering `swap(100e18, 0, false, attacker)` during the quote
pull to take real tokens out against worthless quote in, fails with
**`FeeOnTransferNotSupported`**, attacker balance 0.

Two things close it, and neither is a reentrancy guard:

1. **`_pullExactTo` measures the delta on the *recipient*, not on the factory**
   (`PreMarketFactory.sol:177-181`). Any re-entrant call that changes the premarket's
   balance of the asset currently being pulled breaks `balanceAfter - balanceBefore == amount`.
   Every state-changing entry point on `PreMarket` moves one or both legs, so during the
   quote pull every one of them trips this check. The check exists to reject
   fee-on-transfer tokens; blocking reentrancy is a side effect.
2. **Pull order: token at line 154, quote at line 155.** During the token pull the
   premarket holds zero quote, so `swap(tokenToQuote=true)` and `buyout` both revert on
   an insufficient quote balance before anything moves. The dangerous ordering — valuable
   asset already in, hostile asset being pulled — is the *second* pull, which is the one
   the delta check covers.

The residual hole is a token that lies in `balanceOf`. But a fully hostile asset makes
the seeded reserve fake regardless of reentrancy, and every leg of a fresh premarket comes
from `msg.sender`, so the loss lands on the party that chose the asset. **LOW**, not higher:
I could not construct a path where a non-consenting party loses funds.

### Why it is still worth fixing

The defense is incidental and one edit away from evaporating:

- Swapping lines 154 and 155 (quote first) opens the drain directly.
- Relaxing `_pullExactTo` to a `balanceAfter >= balanceBefore` style check — the usual
  "support fee-on-transfer" change — opens it.
- Adding any withdrawal, refund, or expiry path to `PreMarket` (currently absent by
  design, see `PreMarket.sol:73-79`) gives the window a target that does not move the
  pulled leg.

Precise fix, cheapest first: move `isPreMarket[preMarket] = true; allPreMarkets.push(...)`
(lines 157-158) above the two pulls, and pull both legs **into the factory** before
deploying the `PreMarket`, forwarding them with plain `safeTransfer` after construction.
That removes the window rather than relying on the delta check to cover it. Failing that,
at minimum add a test that re-enters the **child** during seeding, so the ordering
dependency is pinned.

**Deployment note:** `PreMarket`/`PreMarketFactory` are not on mainnet — this is
pre-launch, not a live incident.

---

## INFO-RE2-2 — every `openLong` / `openShort` caller gets an arbitrary-code callback, for free

**File:** `EXNIHILOPool.sol:670` and `:801` → `PositionNFT.sol:296` and `:325`
**Variant:** callback (ERC-721 receiver hook)
**Guard status:** guarded — but the entry point is free and completely untested

`PositionNFT.mintLong` / `mintShort` end in `_safeMint(to, tokenId)`, and `to` is the
pool's caller-supplied `recipient`. So **any caller can obtain code execution inside
`openLong` / `openShort` simply by passing a contract address** — no hostile underlying
token, no ERC-777, no market-creator cooperation. This is a materially cheaper entry
point than carried RE-1, which needs a hook-bearing underlying.

Verified both directions:

- `openLong(1000e6, 0, <EXNIHILOFactory address>)` reverts
  `ERC721InvalidReceiver(0x98eD…7313)` — the hook is genuinely invoked.
- `openLong(1000e6, 0, <LockedLpVault address>)` succeeds and the vault owns the NFT —
  a contract recipient's hook ran inside `openLong` and the transaction committed.

**Not exploitable, for three independent reasons**, each checked:

1. All pool effects precede the mint. `openLong` writes `openPositionCount`,
   `longOpenInterest`, `airUsdSupply`, `backedAirToken` at 650-660, pulls the fee and
   accrues both fee counters at 666-668, and only then mints at 670. Nothing after 670
   except `_assertReserveInvariant()` (a view) at 680 and the event. `openShort` is the
   same shape (779-811). So the state a re-entrant observer reads is the committed
   post-trade state, not a half-updated one.
2. Re-entering the pool is blocked — all 14 mutators are `nonReentrant`.
3. Re-entering `PositionNFT` is blocked by its own access control, not by a guard
   (it has none): `mintLong`/`mintShort`/`applyRenewal`/`release` are all
   `msg.sender == pool` gated (`PositionNFT.sol:280-281, 309-310, 349, 406`), and the
   hook's `msg.sender` is the attacker, not a pool. `setAutoRenew` is owner-gated and
   the attacker does own the token at that instant — but `openLong` never reads
   auto-renew, so setting it changes nothing the caller could not do in the next block.
   `_update` (389) writes only after `super._update`, which makes no external call.
   OZ 5.x `_safeMint` completes `_mint` → `_update` (including all `ERC721Enumerable`
   bookkeeping) *before* `_checkOnERC721Received`, so no enumeration state is observable
   half-written.

Cross-contract targets from inside the hook were checked and are all dead ends:
`LockedLpVault.harvest()` re-enters `pool.claimFees` and reverts on the held pool guard
(self-DoS only); `EXNIHILORouter` is contract-wide `nonReentrant`; no pool reads another
pool's state.

**Recommendation:** no code change required. Add a test — there is currently
**no `onERC721Received` implementation anywhere in `contracts/test/`** and no test that
passes a contract as `recipient`. This is the protocol's cheapest reentrancy entry point
and its behaviour is asserted nowhere.

**Integration note for other passes:** because `_safeMint` reverts for non-receiver
contracts, and `EXNIHILORouter.openLong/openShort` pass `msg.sender` as recipient
(`EXNIHILORouter.sol:84, 99`), a contract that does not implement `onERC721Received`
cannot open a position at all — directly or through the router.

---

## INFO-RE2-3 — `LockedLpVault.onERC721Received` accepts any NFT from anyone, permanently

**File:** `LockedLpVault.sol:342-349`
**Variant:** callback
**Guard status:** n/a — the function is `pure`

The hook returns the magic selector unconditionally. It checks neither
`msg.sender == address(lpNft)` nor `tokenId == lpNftId`.

**It cannot be used to re-enter anything.** It is `external pure`, touches no storage and
makes no call, so there is no state for it to observe or corrupt and no path from it into
`harvest` / `claimLpFees` / `claimIntegratorFees`. The "ReentrancyGuard + IERC721Receiver"
combination is inert here.

It does mean the vault accepts an NFT it should reject. Verified: a `PositionNFT` minted
to a trader, then `safeTransferFrom`'d into the vault, is **accepted**, and since the
vault has no `transferFrom`/`approve`/rescue path by design (`LockedLpVault.sol:46-56`)
it is stuck there forever. Damage is bounded to whoever sent it — self-inflicted, no
protocol impact. Tightening the hook to
`if (msg.sender != address(lpNft) || tokenId != lpNftId) revert;` would cost nothing and
would preserve the documented purpose at lines 336-341 (letting a wallet move the LP NFT
in with `safeTransferFrom`).

---

## INFO-RE2-4 — `LockedLpVault.setLp` / `setIntegrator` are the vault's only unguarded mutators

**File:** `LockedLpVault.sol:291`, `:303`
**Variant:** cross-function
**Guard status:** unguarded — analysed clean

Both write role state and neither carries `nonReentrant`. Traced and found not exploitable:

- Neither role address is read after an external call in any guarded function.
  `claimLpFees` reads `lp` at 245, before `_harvest()` at 248 and before the transfer at
  256. `claimIntegratorFees` has the identical shape (266 / 269 / 277).
- Both claims zero their accumulator **before** transferring: `lpAccrued = 0` at 253
  precedes `usdc.safeTransfer` at 256; `integratorAccrued = 0` at 274 precedes the
  transfer at 277. A re-entrant read sees zero and hits `NothingToClaim()`.
- The only re-entrant caller that could pass `msg.sender != lp` is `lp` itself acting in
  its own token hook — self-harm, and it could call `setLp` in the next block anyway.

**`_harvest` reachability, checked explicitly** (the task flagged this): `_harvest()` is
called from exactly three sites — `harvest()` at 202, `claimLpFees` at 248,
`claimIntegratorFees` at 269 — and all three are `nonReentrant`. There is no unguarded
path to `_harvest`. Its internal ordering is also sound: `pool.claimFees` (216) and
`usdc.balanceOf` (221) are external calls, but the accrual writes at 228-230 come after
them and nothing else in the contract writes `lpAccrued` / `integratorAccrued`.

The vault's balance-based accounting (`amount = balanceOf(this) - lpAccrued - integratorAccrued`,
line 221) preserves `balance >= lpAccrued + integratorAccrued` across every path, so the
"cannot underflow" comment at 219 holds — the only USDC exits are the two claims, each
of which decrements its accumulator by exactly the amount transferred.

---

## INFO-RE2-5 — `EXNIHILOFactory` claims an `onERC721Received` it does not have

**File:** `EXNIHILOFactory.sol:67`

> `*   - onERC721Received implemented so the factory can safely receive LP NFTs.`

It is not implemented. `grep` over `contracts/` finds `onERC721Received` only in
`LockedLpVault`. Verified by probe: `openLong` with the factory as recipient reverts
`ERC721InvalidReceiver` naming the factory address.

The factory *does* safely receive LP NFTs today, but by a different mechanism than the
comment claims: `LpNFT.mint` uses `_mint`, not `_safeMint` (`LpNFT.sol:74`), and the
handoff at `EXNIHILOFactory.sol:250` is a plain `transferFrom`. Both are hook-free.
`PreMarket.sol:542` relies on the same property and states it correctly.

Consequence if believed: changing `LpNFT.mint` to `_safeMint` — a normal-looking
hardening edit — would revert **every** `createMarket`, and would also permanently brick
`PreMarket.buyout`, whose only exit for a seeded premarket is that call
(`PreMarket.sol:73-79`, no refund/expiry path). Fix the comment, or add the receiver.

---

## Carried findings

### RE-1 (carried, accepted) — read-only reentrancy with an ERC-777 underlying — **still LOW, narrower**

Unchanged in substance. A market creator choosing a hook-bearing underlying gets a
callback during `underlyingToken.safeTransfer` in `removeLiquidity` (910) and
`_swapUsdcToToken` (1526), from which an observer can read pool views.

Narrower than last round on two counts. First, in `_swapUsdcToToken` and
`_swapTokenToUsdc` every reserve write now precedes the transfers (1519-1522 then
1525-1526; 1486-1489 then 1492-1493), so the observable state is the committed
post-trade state — the read-only window returns *correct* values, not stale ones. Second,
`_assertReserveInvariant()` at 1528 / 1495 now also covers `totalShortCollateral` and
`totalClaimable` (`EXNIHILOPool.sol:1914-1921`), so any path that did leak would revert.

Two new consumers of pool views exist this round and were checked:
`LockedLpVault.pending()` (`LockedLpVault.sol:317`) reads `pool.lpFeesAccumulated()` and
would under-report by exactly the claimed amount if read during `pool.claimFees`'
transfer — but it is display-only with no on-chain consumer. `EXNIHILORouter._positionFee`
reads `pool.quoteOpenFee` (`EXNIHILORouter.sol:59`), but the router is contract-wide
`nonReentrant` and the pool call that follows is guarded too.

Still an observation rather than a state change, still requires a deliberately
hook-bearing underlying. **Accept as before.**

### INFO-RE-1 — `setPositionCaps` not `nonReentrant` — **CLOSED**

`setPositionCaps` is deleted. Confirmed against
`git diff -U0 -- contracts/EXNIHILOPool.sol`, which shows the declaration removed and no
replacement setter. The cap is now `currentMaxPositionBps()`
(`EXNIHILOPool.sol:1290`), a pure function of `createdAt` (immutable) and
`block.timestamp` with no setter and no caller who can move it. The finding has no
subject any more.

---

## `test/ReentrantToken.sol` — what the +32 lines say

The addition is a `transfer` override plus `setReentrantTransferCall` /
`reentrantOnTransferEnabled` (`ReentrantToken.sol:20-21, 55-62, 69-81`), mirroring the
existing `transferFrom` override for the push direction. The comment names the motive:
*"contracts that only ever push tokens out (e.g. a refund path) can have their reentrancy
guard exercised as well."*

That maps to exactly one consumer, `LockedLpVault`: every path out of the vault is a
`usdc.safeTransfer`, never a `transferFrom`, so the pre-existing `transferFrom` hook could
not reach it at all. The three tests added with it (`test/LockedLpVault.ts:807-838`)
re-enter `harvest → harvest`, `claimLpFees → claimLpFees`, `claimIntegratorFees →
claimIntegratorFees`, and all three revert `ReentrancyGuardReentrantCall`.

**What the tests prove:** the guard is applied to all three and fires. Adequate.

**What they do not prove, and do not need to:** cross-function re-entry within the vault
(`harvest → claimLpFees`, etc.) is untested, but OZ's `ReentrancyGuard` is a single
contract-wide `_status` slot, so it is covered by construction given all three carry the
modifier. The genuine gap is elsewhere: `setLp` / `setIntegrator` are the vault's
unguarded mutators (INFO-RE2-4) and nothing exercises them under re-entry, and the
`onERC721Received` hook (INFO-RE2-3) has no test at all.

`ReentrantToken` is also used in `PreMarket.ts:1209-1315` (four tests) and
`Coverage.ts:1431-1666`. See RE2-1 for why the premarket set proves the wrong boundary.

---

## Checked and clean

Beyond the above, these were traced end to end and found sound.

**`PreMarket.buyout` (480) — CEI around the launch call.** The commit is complete before
the call out: `launched = true`, both reserves zeroed and `launchUsdc` set at 501-504,
all before `_pullExact` (507), `quote.safeTransfer` (508), `forceApprove` (512-513) and
`factory.createMarket` (515). `launchedPool` (526) and `lpVault` (539) are written after
the call, but they are pure bookkeeping: `launched` is already true, so both `swap` (422)
and `buyout` (484) revert `AlreadyLaunched` on re-entry independently of the guard, and
neither field gates anything. During the four separate windows where the arbitrary
`token` or `quote` gets control (508, 512, 513, 523, and inside `createMarket`'s own
token pull at `EXNIHILOFactory.sol:203`), the premarket has no outbound transfer path
left and has granted no approval that anyone but the factory can spend.

**`PreMarket.swap` (416) — CEI around the two arbitrary-token transfers.** Both reserve
writes (434-440) precede both interactions (446-447), and the inbound `_pullExact`
precedes the outbound `safeTransfer`, so the pool is always funded before it pays.
`_pullExact` (555) completes its balance-delta check before the push, which also makes
the `token == quote` degenerate case safe.

**`EXNIHILOFactory.createMarket` — the LP NFT id prediction survives reentrancy.**
`lpNftId` is predicted as `allPools.length` (224) and `allPools.push` happens at 255,
after eight external calls. A re-entrant `createMarket` would collide the prediction —
but it is `nonReentrant`, so it cannot. `isPool[pool] = true` at 254 is likewise late,
leaving a window in which `PositionNFT.mintLong`'s `isPool` check
(`PositionNFT.sol:281`) would reject the new pool; reachable only from inside
`addLiquidity` (241), where the pool's own guard is already held. Both are inconsistency
windows with no reachable consumer.

**The new settlement guard introduces no read-after-call.** `_armSettlementGuard` (1437)
is invoked *before* the reserve mutations in both swap helpers (1482 before 1486-1489;
1515 before 1519-1522), which is both correct for its stated denominator argument and
correct for CEI. `_assertSettlementUnguarded` (1452) reads `lastLargeSwapBlock` after
`positionNFT.getPosition` and `positionNFT.ownerOf` in `settleExpired` (1051-1058) and
`closePositionAfterDeadline` (1171-1176) — both are pure storage reads on a
non-upgradeable protocol contract with no outbound call, so the read cannot be raced.

**The cap and duration ramps introduce no reentrancy surface.**
`currentMaxPositionBps` (1290) and `currentPositionDuration` (1310) are pure functions of
the `createdAt` immutable and `block.timestamp`. `currentPositionDuration()` is evaluated
after `_transferIn` in `openLong` (677 vs 666) and `openShort` (808 vs 797), which is a
read after an external call — but neither input is reachable by a re-entrant caller, so
the ordering is inert. `_checkLeverageCap` (629, 754) runs before any interaction.

**`_settle` (1610) — all four branches.** Every counter is written at 1623-1660 before
`positionNFT.release` (1642 / 1664), which `_burn`s with no receiver hook
(`PositionNFT.sol:409`). On the expiry path the holder is paid by `_creditPayout` (1666),
a pure state write; on the self-close path `underlyingUsdc.safeTransfer` (1669) goes to
`holder == msg.sender`. `_assertReserveInvariant()` closes every branch.

**`_tryAutoRenew` (1116) — ordering deviation, no consequence.** `_accrueProtocolFee` /
`_accrueLpFee` (1145-1146) are written *after* `positionNFT.applyRenewal` (1133 / 1141).
`applyRenewal` (`PositionNFT.sol:340-354`) writes only its own storage and makes no
outbound call, so there is no attacker frame between the two, and the pool guard is held
regardless. Same for `renewPosition` (994), which is the one pool mutator with no
EFFECTS-before-INTERACTIONS block at all — `_transferIn` (1011) precedes both fee
accruals (1012-1013) and the renewal write (1014). Safe under the current USDC; worth
reordering for consistency with every other mutator.

**`PositionNFT` has no `ReentrancyGuard` and does not need one.** All six mutators are
either pool-gated (`mintLong` 280-281, `mintShort` 309-310, `applyRenewal` 349,
`release` 406), owner-gated (`setAutoRenew` 369), or one-shot deployer-only
(`initFactory` 125). No state is read after the `_safeMint` hook in either mint path.

**`EXNIHILORouter`.** All three entry points are `nonReentrant`, so a hostile input token
cannot hop from `router.swap` into `router.openLong` to sweep a residual.
`_refundResidual` (67) measures `balBefore` before the pull, so a pre-existing residual is
never attributable to the current caller and cannot be swept by a re-entrant call.
The pool output goes straight to `msg.sender` (84, 99, 118), never through the router.

**`Faucet`** unchanged from the prior round's analysis; `LpNFT.mint` uses `_mint`, no hook.

**Still no loops** in any contract in the protocol, so no partial-progress reentrancy
variant can exist.

---

## For the other passes

- `PreMarket`'s constructor validates market parameters at seed time specifically so a
  buyout cannot revert and strand the reserves (`PreMarket.sol:107-109`), but it does
  **not** check `c.token != c.usdc`. `EXNIHILOFactory.createMarket` reverts `TokenIsUsdc`
  (`EXNIHILOFactory.sol:196`). A premarket seeded with USDC as the project token can
  therefore never be bought out, and with no refund/expiry path both legs are locked
  forever. Same class: a token that is honest at seed time but becomes fee-on-transfer
  later fails `EXNIHILOPool._transferIn` inside `addLiquidity` at buyout, with the same
  permanent outcome. **Input-validation / DoS territory, not mine — flagging it because
  I hit it while tracing the launch path.**
- `_assertReserveInvariant` (1903) trusts `underlyingToken.balanceOf` for a token the
  market creator chose. A hostile token makes the invariant vacuous. Bounded to that
  market, but it belongs to the external-call-safety pass.
- `LockedLpVault._harvest` calls `pool.claimFees` (216), which is `onlyLpHolder`. If the
  vault does not hold the LP NFT while `lpFeesAccumulated != 0`, **both** claim functions
  revert — including for balance already accrued and sitting in the vault. Cannot happen
  on the `PreMarket.buyout` path (the NFT is transferred in the same transaction,
  `PreMarket.sol:543`) but is reachable for a hand-deployed vault. Availability, not
  reentrancy.
