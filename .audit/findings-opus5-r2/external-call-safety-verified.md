# External Call Safety — Verified (Opus 5 R2)

**Date:** 2026-08-20
**Baseline:** `5197494` (prior round) → working tree at `c02af1d`, branch `mainnet-launch`
**Scope:** `PreMarket`, `PreMarketFactory`, `LockedLpVault` (all three unaudited),
the `EXNIHILOPool` delta (587 lines), plus re-verification of `EXNIHILOFactory`,
`EXNIHILORouter`, `PositionNFT` and the carried finding ECS-1.

```
0 CRITICAL | 1 HIGH | 1 MEDIUM | 4 LOW | 2 INFO
```

---

## Summary

The mechanical layer is clean. Every ERC-20 movement in all three new contracts
goes through OpenZeppelin `SafeERC20`; there is not one raw `.transfer(` /
`.transferFrom(` / `.approve(`, not one low-level `call`, and no `delegatecall`
anywhere in the protocol outside `Faucet.sol`. `_pullExact`, `_pullExactTo` and
`_transferIn` are each airtight on every inbound path — I checked all of them,
not one.

The findings are all on the **outbound** side, and they share one root: `PreMarket`
takes custody of two arbitrary assets and has **no exit path other than `buyout`**.
That converts every ordinary weird-token behaviour from "a trade fails" into
"the reserves are gone or frozen forever". The HIGH is the case where a token
deployer can make that revert *selective* rather than universal, which turns a
permissionless descending auction into a private one.

---

## ECS-R2-1 (HIGH) — a hostile project token can exclude every other bidder from the buyout auction and take the whole quote reserve for ~$1

**Location:** `PreMarket.sol:512-519` (the `createMarket` handoff),
`PreMarket.sol:354-358` (`currentPrice`), `PreMarket.sol:379-382`
(`_buyoutCost`), `PreMarket.sol:156` (`MIN_BUYOUT_USDC`),
`EXNIHILOFactory.sol:203` (the pull that can be made selective).

### The two ingredients

**(a) The auction floors at ~$1 and never expires.** `currentPrice()` decays
linearly and bottoms out at `1` (one USDC atom per whole quote unit):

```solidity
uint256 drop = (startPrice * decayBpsPerMinute * elapsed) / (BPS_DENOM * 60);
return drop >= startPrice ? 1 : startPrice - drop;
```

`drop >= startPrice` once `elapsed >= 600000 / decayBpsPerMinute` seconds — at the
documented default of 200 bps/min that is **50 minutes**. From then on
`_buyoutCost` returns `MIN_BUYOUT_USDC` for any reserve under ~1 M whole quote
units, i.e. **$1.00 buys the entire quote reserve, forever**. The contract knows
this and accepts it (`PreMarket.sol:343-347`: "Nothing on-chain stops a bidder
waiting for it: the protection is economic"). The whole safety argument rests on
competition — someone rational takes it long before the floor.

**(b) The buyout's success is gated on a transfer of the *project token*, which
the project controls.** `buyout` cannot complete without
`EXNIHILOFactory.createMarket` succeeding, and that does:

```solidity
IERC20(tokenAddress).safeTransferFrom(msg.sender /* = PreMarket */, address(this), tokenAmount);
```

`tokenAmount` is the **entire** `tokenReserve`, moved in one transfer
(`PreMarket.sol:518`). So a token whose `transferFrom` reverts for everyone
except an origin the deployer chooses makes `buyout` succeed for that origin and
revert for everyone else. A `tx.origin`-keyed whitelist inside `transferFrom` is
five lines and is invisible from the outside on the buy path, because buyers hit
`token.safeTransfer` (`PreMarket.sol:447`), not `transferFrom`.

### Exploit path

1. Project deploys `EVIL` with a whitelist on `transferFrom` keyed on
   `tx.origin`; `transfer` is unrestricted so the premarket AMM looks healthy.
2. Project (or its launchpad) seeds a premarket: `EVIL` + a real quote asset
   (WAVAX, the launchpad's token, whatever it bonded in), `startPrice` set
   honestly, `decayBpsPerMinute = 200`.
3. The public trades. Buyers push quote *in* and take `EVIL` out
   (`swap(..., tokenToQuote=false, ...)` → `_pullExact(quote, …)` then
   `token.safeTransfer(to, …)`). `quoteReserve` grows with real money.
   Sellers cannot sell back — `_pullExact` calls `token.safeTransferFrom` — but
   that reads as an ordinary honeypot and does not stop new buyers.
4. Anyone who tries to bid honestly at a fair price reverts inside
   `EXNIHILOFactory.createMarket`. The revert surfaces from a contract the bidder
   never named, so it reads as a protocol bug, not as exclusion.
5. After 50 minutes `currentPrice() == 1` and `_buyoutCost` clamps to
   `MIN_BUYOUT_USDC`. The project calls `buyout(1e6, 0)` from a whitelisted
   origin: it pays **$1**, receives `quote.safeTransfer(msg.sender, quoteOut)` —
   the entire quote reserve — and the real market opens with $1 of USDC backing
   for the buyers left holding `EVIL`.

### Why I believe it

`buyout` is fully rolled back on revert (`PreMarket.sol:501-504` are inside the
same transaction as `createMarket`), so failed bids leave no trace and the
auction stays open indefinitely — the attacker can wait as long as they like.
`buyout` is otherwise permissionless, so nothing else limits who wins; the only
gate is the token's own transfer policy, and the project writes that.

### On the weaker, accidental variant

The same shape arises from a **max-transaction-amount** token with an owner
exemption — one of the most common memecoin patterns there is. Verify the
distinction before rating a fix:

- Exemption keyed on `from`/`to`: `from` is always the premarket and `to` always
  the factory, so *nobody* can buy out. That is ECS-R2-2 (permanent strand), not
  theft.
- Exemption keyed on `tx.origin`: selective, and this finding applies.
- Plain `maxTxAmount` with no exemption: **breakable**. A bidder can swap quote
  in to buy `tokenReserve` down below the cap and then buy out — and because the
  quote they spend lands in the reserve they are about to buy for $1, doing so is
  *profitable*. So competition partially survives here. Set the cap low enough
  and the required purchase becomes prohibitive, but this variant is not airtight.

The origin-keyed variant is the load-bearing one, and it is airtight.

### Fix (do not apply — coordinator's call)

Two independent mitigations, both cheap:

1. **Give the auction a reserve price.** The `$1` floor is what makes exclusion
   worth 50 minutes of patience. A floor proportional to the seeded value —
   e.g. a fraction of `startPrice * initialQuoteReserve` — bounds the prize.
   Routing this to the economics pass as well; it is their call whether the
   "always executable" property is worth the $1 floor.
2. **Prove the token can make the handoff at seed time.** `PreMarket`'s own
   header already commits to this principle (`PreMarket.sol:107-109`: "Market
   parameters are validated at seed time, not at buyout … a pool constructor
   revert during buyout would strand the premarket's liquidity permanently").
   A `transferFrom` of the full seeded `tokenAmount` through the factory's own
   path is not testable at seed time in general, but pulling the seed via
   `transferFrom` *from the premarket* on the same route the buyout will use
   would catch the from/to-keyed and cap variants. It will not catch the
   origin-keyed one — only (1) does.

---

## ECS-R2-2 (MEDIUM) — `PreMarket` has no exit path, so any outbound revert strands both legs permanently

**Location:** `PreMarket.sol:508` (`quote.safeTransfer`), `PreMarket.sol:512-519`
(approve + `createMarket`), against the contract's claims at `PreMarket.sol:73-79`
and `466-471`.

`PreMarket` has exactly six functions: two views, one pure, `swap`, `buyout`,
`_pullExact`. There is no withdraw, no refund, no expiry, no owner, no rescue.
The header states this as a feature. The consequence is that the *only* asset
exit is `buyout`, and `buyout` makes three outbound moves against arbitrary
tokens, any one of which reverting locks both legs forever:

| Call | Fails when |
|---|---|
| `quote.safeTransfer(msg.sender, quoteOut)` `:508` | quote blacklists the premarket; quote is paused; quote rebased down below `quoteReserve`; quote has a transfer cap below the full reserve |
| `token.forceApprove(factory, tokenOut)` `:512` | token restricts `approve` to whitelisted spenders |
| `createMarket` → `token.safeTransferFrom(premarket, factory, tokenOut)` | token blacklists the premarket or the factory; token is paused; transfer cap; token rebased down |

The contract's own comment at `:466-471` asserts the opposite — *"A buyout is
therefore always executable: there is no decay far enough, and no reserve small
enough, to price one out of reach."* That is true of the **pricing**, which is
what `MIN_BUYOUT_USDC` was designed to guarantee. It is not true of the
**transfers**, and the transfers are the part that touches arbitrary tokens.

**Concrete path, no malice required:** a launchpad seeds a premarket with USDT as
the quote asset. Tether blacklists the premarket address (or the project token's
deployer pauses transfers during an incident and never unpauses). Every bid
reverts. Both legs — including everything the public swapped in — are locked
permanently, with no code path that can ever move them.

**Why this is worse here than in the pool.** The pool has the same outbound
exposure but always has `removeLiquidity()` (`EXNIHILOPool.sol:896-917`) and
`claimFees()` (`:926`), neither of which calls `_assertReserveInvariant()`, so
the LP retains an exit for whatever the token still permits. `PreMarket` has
nothing.

**Fix:** an expiry path. Not a refund to the creator (that would break the
one-way commitment the design is selling), but something — a `buyout` variant
that skips the quote leg and credits it as a pull payment, or a
`createMarket`-free fallback after some long deadline. The commitment being
one-way does not require it to be unconditional on an arbitrary token behaving.

---

## ECS-R2-3 (LOW) — every `LockedLpVault` claim path forces a harvest, so one reverting `pool.claimFees` freezes both parties' already-accrued balances

**Location:** `LockedLpVault.sol:212-233` (`_harvest`), `:248` and `:269` (the
forced calls), against the doc claim at `LockedLpVault.sol:72-78`.

```solidity
function claimLpFees(address to) external nonReentrant returns (uint256 amount) {
    if (msg.sender != lp) revert NotLp();
    if (to == address(0)) revert ZeroAddress();

    _harvest();                    // <- can revert; no path skips it

    amount = lpAccrued;
    ...
    usdc.safeTransfer(to, amount);
}
```

`_harvest()` calls `pool.claimFees(address(this))` whenever the pool has anything
accrued (`:215-217`). If that call reverts, `claimLpFees` and
`claimIntegratorFees` both revert with it — **including for USDC that is already
sitting in the vault and already earmarked**. There is no claim-without-harvest
entry point.

The realistic trigger is USDC blacklisting the vault: `pool.claimFees` ends in
`underlyingUsdc.safeTransfer(to, amount)` with `to == the vault`
(`EXNIHILOPool.sol:934`), which reverts for a blacklisted recipient. The vault
address is fixed and, by design, can never move the LP NFT elsewhere, so there is
no recovery.

This directly contradicts the contract's stated protection:

> *"Both claim functions take a destination, so a blocked party can still redirect
> their own balance."* — `LockedLpVault.sol:76-78`

The destination parameter protects against `lp` or `integrator` being blocked. It
does not protect against **the vault** being blocked, which is the case where the
funds are actually unreachable.

**Severity LOW** because Circle blacklisting a passive fee splitter is unlikely
and the amount at risk is unclaimed fees, not principal. It is on this pass's
list because it is a pure external-call-failure-mode defect and the fix is two
lines: wrap the harvest in `try pool.claimFees(address(this)) {} catch {}`, or
split the harvest out of the claim path.

Verified clean while I was here: the vault's split accounting **cannot** be
corrupted. `amount = usdc.balanceOf(this) - lpAccrued - integratorAccrued`
(`:221`) is safe because accrued balances are only ever created from measured
held USDC and every claim decrements balance and accrual by the same amount
(`:253-256`, `:274-277`). No path moves USDC out without decrementing. The
underflow the comment at `:219-220` worries about is genuinely unreachable for
real USDC.

---

## ECS-R2-4 (LOW) — the vault's `PoolMismatch` check is self-referential; a forged vault is indistinguishable from a real one

**Location:** `LockedLpVault.sol:171-188`, specifically `:179`.

```solidity
if (ILockedLpNFT(lpNft_).poolOf(lpNftId_) != pool_) revert PoolMismatch();
```

`lpNft_` is a constructor argument. An attacker deploying the vault supplies
**both sides of this comparison**, so a three-line fake `LpNFT` whose `poolOf`
returns whatever `pool_` was passed satisfies it unconditionally. Nothing in the
vault links it to `EXNIHILOFactory`.

Two consequences:

1. **The trust claim is forgeable.** The contract's headline guarantee
   (`LockedLpVault.sol:44-56`) is that *"Anyone can verify from the deployed
   bytecode that the liquidity backing the market cannot be pulled out."* True of
   the bytecode; false of any particular deployment. A launchpad partner shown a
   `LockedLpVault` address on a block explorer — identical bytecode, identical
   verified source, `isFunded()` returning true against a fake NFT — has verified
   nothing. Only the chain
   `PreMarketFactory.isPreMarket[pm]` → `pm.lpVault()` establishes authenticity,
   and nothing in the vault says so.
2. **A vault pointed at a hostile pool inherits a hostile `usdc`** — `:188` reads
   `ILockedPool(pool_).underlyingUsdc()`. With a token that can zero a holder's
   balance, `_harvest`'s subtraction at `:221` underflows and the vault bricks
   permanently, taking `pending()` (`:320-321`) with it. Only that vault's own
   funds are at risk, never the protocol's.

In-repo, `LockedLpVault` is constructed from exactly one place —
`PreMarket.sol:531`, with `pool` from `createMarket` and `lpNftAddr` from
`factory.lpNftContract()`, both trusted. So the deployed path is sound and this
is a third-party/social-engineering exposure, not a protocol one. Rated LOW for
that reason.

**Fix:** take the `EXNIHILOFactory` as a constructor argument and assert
`factory.isPool(pool_)` and `lpNft_ == address(factory.lpNftContract())`. That
makes the vault self-verifying and costs one immutable.

---

## ECS-R2-5 (LOW) — `PreMarketFactory` accepts `token == usdc`, which `createMarket` rejects only at buyout time

**Location:** `PreMarketFactory.sol:120-121`, `PreMarket.sol:301-314`,
`EXNIHILOFactory.sol:196`.

`EXNIHILOFactory.createMarket` reverts `TokenIsUsdc()` when
`tokenAddress == usdc` (`:196`). Neither `PreMarketFactory.createPreMarket`
(which validates only zero-address and zero-amount at `:120-121`) nor
`PreMarket`'s constructor (`:302-314`) checks for it. A premarket seeded with
USDC as the project token therefore accepts liquidity, trades normally, and then
**reverts on every buyout attempt for the rest of time** — both legs stranded, per
ECS-R2-2's mechanism.

This is a direct violation of the invariant `PreMarket` states about itself:

> *"Market parameters are validated at seed time, not at buyout. With no expiry
> path, a pool constructor revert during buyout would strand the premarket's
> liquidity permanently rather than merely delaying it."* — `PreMarket.sol:107-109`

I checked the other three `createMarket` preconditions and they *are* covered:
`tokenAddress == address(0)` is caught by `PreMarket`'s constructor at `:302`;
`usdcAmount == 0` is impossible because `_buyoutCost` clamps to
`MIN_BUYOUT_USDC`; `tokenAmount == 0` is impossible because the constant-product
curve can never fully drain a side (`getAmountOut` at `:402` divides by
`reserveIn * BPS_DENOM + amountInWithFee`, so the output is strictly less than
`reserveOut` for any `reserveIn >= 1`). `TokenIsUsdc` is the single gap.

Self-inflicted rather than attacker-driven, hence LOW — but it strands whatever
the public subsequently swapped in, and a USDC/WAVAX premarket looks like a
perfectly ordinary AMM to an arbitrageur. One line in `createPreMarket`:
`if (p.token == usdc) revert TokenIsUsdc();`.

---

## ECS-1 (carried, LOW) — rebasing and fee-on-transfer: inbound closed, outbound still open, and now wider

**Prior status:** LOW, "inbound half closed by `_transferIn`".
**This round:** still LOW. The inbound half is confirmed closed in the pool and
now closed in the two new contracts too. The outbound half is unchanged, and
`PreMarket` widens the blast radius from "value leak" to "permanent lock".

### Inbound — verified closed, all paths

`EXNIHILOPool.sol:1844-1850` is the **only** `safeTransferFrom` in the pool
(confirmed by grep across all contracts). All seven call sites go through it:
`openLong` fee `:666`, `openShort` fee `:797`, `addLiquidity` token `:881` and
USDC `:882`, `renewPosition` fee `:1011`, `_swapTokenToUsdc` `:1492`,
`_swapUsdcToToken` `:1525`.

The 587-line pool delta **adds no transfer at all**. Filtering the diff for
transfer sites returns only two *removals* — the `KEEPER_BOUNTY` payouts. The new
code paths are all pure state or view: the cap ramp (`currentMaxPositionBps`
`:1290`), duration ramp (`:1310`), settlement guard (`_armSettlementGuard`
`:1437`, `_assertSettlementUnguarded` `:1452`), `_quoteShortfall` (`:1404`, a
`view` reachable only from `quoteClose`), and the auto-renew path
(`_tryAutoRenew` `:1116-1151`, which charges the fee against position equity
through storage writes and `positionNFT.applyRenewal` — **no token moves**).

`PreMarket._pullExact` (`:555-561`) and `PreMarketFactory._pullExactTo`
(`:176-182`) are structurally identical to `_transferIn` and cover **all three**
inbound paths, not one:

| Inbound | Guard |
|---|---|
| seed token leg | `PreMarketFactory._pullExactTo` `:154` |
| seed quote leg | `PreMarketFactory._pullExactTo` `:155` |
| `swap` input (either direction) | `PreMarket._pullExact` `:446` |
| `buyout` USDC | `PreMarket._pullExact` `:507` |

`_pullExactTo` correctly measures the delta on the *recipient* (the new
premarket), so pre-funding the deterministic premarket address does not defeat
it. Both are exercised by tests — `test/PreMarket.ts:378-405` (seeding, both
legs) and `:861-883` (swap).

### Outbound — still open

No outbound transfer verifies delivery, in any contract:
`EXNIHILOPool.sol:910, 914, 934, 953, 971, 1493, 1526, 1669`;
`PreMarket.sol:447, 508`; `LockedLpVault.sol:256, 277`;
`EXNIHILORouter.sol:70`.

For the pool this remains LOW and the loss direction is correct — a
fee-on-transfer token switched on after market creation (USDT-style toggle)
delivers less than accounted to the *recipient*, leaving the pool over-solvent
rather than under. The `_transferIn` guard then blocks all further inbound token
flow, so the market degrades safely.

The rebasing case in the pool is worth restating precisely, because it is
asymmetric:

- **Positive rebase:** `underlyingToken.balanceOf(pool) > backedAirToken`. The
  surplus is un-attributed and unreachable — swaps price off `backedAirToken`,
  not balance, and `removeLiquidity` pays exactly `backedAirToken` (`:900-914`).
  Stranded, not stealable.
- **Negative rebase:** `_assertReserveInvariant` (`:1906`) trips. Every path that
  calls it freezes — all swaps, all opens, and **all closes** (`_settle` asserts
  at `:1674`), so positions become permanently unclosable. `removeLiquidity`
  (`:896-917`), `claimFees` (`:926`), `claimProtocolFees` and `claimPayout`
  deliberately do not assert, so those exits survive as far as the token permits.

### The new contracts widen it

`PreMarket` records `tokenReserve` / `quoteReserve` as absolute amounts at
construction (`:329-330`) and never reconciles against balances again. Since the
entire point of `PreMarket` is arbitrary quote assets, a rebasing quote (stETH,
AMPL, any launchpad's elastic-supply token) is now a first-class input rather
than an exotic choice. A downward rebase makes `quote.safeTransfer(msg.sender,
quoteOut)` at `:508` revert on insufficient balance, which is ECS-R2-2:
**permanent**, because unlike the pool there is no `removeLiquidity` to fall back
to. That is the one place where the new contracts make ECS-1 materially worse, and
it is the reason ECS-R2-2 is rated MEDIUM rather than LOW.

---

## INFO-ECS-R2-1 — correcting the prior round: `PositionNFT` uses `_safeMint`, not `_mint`

The prior report stated:

> *"Minting uses `_mint`, **not** `_safeMint`, in the pool-driven paths, so no
> `onERC721Received` callback fires into an attacker-controlled recipient during
> `openLong` / `openShort` / `createMarket`. That removes the callback reentrancy
> vector at position creation."*

**This was false when it was written.** `PositionNFT.sol:296` (`mintLong`) and
`:325` (`mintShort`) both call `_safeMint`, and they did so at the audited
baseline — `git show 5197494:packages/blockchain/contracts/PositionNFT.sol`
shows `_safeMint` at lines 250 and 279. Nothing regressed; the closure was based
on a wrong premise. Flagging in the spirit of the round's PROCESS-001.

**The vector is nonetheless closed, for a different reason.** I re-derived it:

- The hook fires into `recipient`, an arbitrary caller-supplied address, from
  inside `positionNFT.mintLong` at `EXNIHILOPool.sol:670` / `mintShort` at `:801`.
- At that point **every** EFFECT is already written and `_transferIn` has already
  run (`openLong` `:649-668`, `openShort` `:779-799`). The only pool code after
  the hook is `_assertReserveInvariant()` and an `emit`. So a re-entrant reader
  sees final, consistent state — there is no read-only reentrancy window.
- Every state-changing pool entry point is `nonReentrant` and OZ's guard is
  per-contract, so re-entry into the same pool is blocked outright. Re-entry into
  a *different* pool touches no shared mutable state (`PositionNFT._nextTokenId`
  only increments; `_update` at `:389-399` clears auto-renew on transfer, which
  is the correct direction).
- `PositionNFT.release()` (`:403-410`) burns via `_burn` — no hook.
- `EXNIHILOFactory` and `PreMarket` both hand the LP NFT over with plain
  `transferFrom` (`EXNIHILOFactory.sol:250`, `PreMarket.sol:543`) — no hook there
  either, so `LockedLpVault.onERC721Received` is not load-bearing.

**Residual consequence worth recording:** `openLong` / `openShort` cannot mint to
a contract that does not implement `onERC721Received`, and a recipient contract
that reverts in the hook makes the open impossible. Today every caller passes
either an EOA or `msg.sender` (`EXNIHILORouter.sol:84, 99`), so nothing breaks —
but any future path that mints to an address the caller does not control becomes
griefable by that address.

## INFO-ECS-R2-2 — `LockedLpVault.onERC721Received` is clean, but permanently traps anything sent to it

**Location:** `LockedLpVault.sol:342-349`.

Checked against the standard acceptance-hook pitfalls and it passes all of them:
it is `pure`, mutates nothing, returns the constant selector, and cannot be used
by a hostile NFT contract to influence vault state. The vault does not trust the
hook for anything — `isFunded()` (`:330-332`) reads `lpNft.ownerOf` live rather
than recording arrival in the hook, which is the correct pattern.

The one note: it accepts **any** token id from **any** ERC-721 contract, and the
vault has no rescue path by design. Anything `safeTransferFrom`'d in is destroyed.
That is consistent with the contract's purpose and needs no fix; it is worth a
line in the integrator docs. Checking `msg.sender == address(lpNft) && tokenId ==
lpNftId` would be free and would turn accidents into reverts.

---

## Checked and found clean

So the next round knows what this pass actually covered.

**Return values.** No unchecked external call anywhere in the three new
contracts. All 4 outbound ERC-20 moves use `SafeERC20`; the one ERC-721 move
(`PreMarket.sol:543`) is OZ `IERC721.transferFrom`, which reverts on failure and
returns nothing. Every `factory.*` return value is captured
(`PreMarket.sol:515`, `:530`, `:311`; `PreMarketFactory.sol:102`). Zero
low-level `call` / `delegatecall` / `staticcall` outside `Faucet.sol:49, 73`,
both of which check `ok`.

**Approve safety.** All four approve sites in `PreMarket.buyout` use
`forceApprove` (`:512, 513, 523, 524`), which handles the USDT non-zero→non-zero
revert, and residuals are explicitly revoked after `createMarket`. Same pattern
verified unchanged in `EXNIHILOFactory.sol:238-246` and
`EXNIHILORouter.sol:83-85, 98-100, 117-119`. No standing allowance is left
anywhere. No approve-race window: every approval is set and cleared inside one
transaction.

**Zero-value transfers.** Traced every outbound site for a token that reverts on
zero. `PreMarket.swap` rejects `amountIn == 0` (`:423`) and `amountOut == 0`
(`:430`); `buyout` is floored by `MIN_BUYOUT_USDC` and `quoteOut >= 1` by the
curve argument. `LockedLpVault` guards both claims with `NothingToClaim`
(`:251`, `:272`) and gates `pool.claimFees` on `lpFeesAccumulated() != 0`
(`:215`). Pool: `removeLiquidity` guards `> 0` on both legs (`:909, 913`); all
three claim functions guard `amount == 0`. `EXNIHILORouter._refundResidual`
guards `balAfter > balBefore` (`:69`). The **only** unguarded zero-value transfer
is `_settle`'s `underlyingUsdc.safeTransfer(holder, netSurplus)`
(`EXNIHILOPool.sol:1669`) when `surplus == 0` and `deficit == 0` exactly — safe
because `underlyingUsdc` is a factory immutable and real USDC does not revert on
zero. No arbitrary token ever reaches a zero-value transfer.

**Return-data bombs.** The only calls into caller-supplied contracts are the two
`decimals()` try/catch sites (`EXNIHILOFactory.sol:210`,
`PreMarketFactory.sol:127`). Solidity 0.8 copies full returndata for decoding, so
a bomb is a ~2× gas amplification — but in both cases the caller is the party who
*chose* the token, so it is self-griefing only. No third party can be forced
through either call. No `abi.decode` of unbounded external data anywhere.

**Push vs pull.** Consistently pull everywhere it matters. The pool credits
expired-position payouts via `_creditPayout` (`:1878-1883`, a pure state write
that cannot fail) rather than pushing. `LockedLpVault` mirrors this — harvest
only accrues, and both parties withdraw with a destination parameter. No batch
loops over user-supplied addresses anywhere in the protocol, so no
blacklist-one-blocks-all DoS. The single exception is ECS-R2-3, where the *vault
itself* being blocked defeats the pattern.

**Trusted-callee inventory (new contracts).**

| Caller | Callee | How it is fixed |
|---|---|---|
| `PreMarket` | `factory` | immutable; cross-checked against `factory.usdc()` at construction (`:311`) |
| `PreMarket` | `token`, `quote`, `usdc` | immutable; `usdc` proven to equal the factory's |
| `PreMarket` | `lpNftAddr` | read from the trusted factory at `:530` |
| `PreMarketFactory` | `marketFactory`, `usdc` | immutable; `usdc` read from `marketFactory` (`:102`) so they cannot disagree |
| `LockedLpVault` | `pool`, `lpNft`, `usdc` | immutable — but only *self*-consistent; see ECS-R2-4 |

No path in any of the three lets a *caller* supply an address that the contract
then calls. `PreMarketFactory.createPreMarket`'s `p.token` / `p.quote` are called,
but they become that premarket's own immutables and affect nobody else.

**Reentrancy through arbitrary tokens.** Not re-derived in depth (that is the
reentrancy pass) but spot-checked for this pass's purposes: `swap`, `buyout`,
`createPreMarket`, `harvest`, and both claims are `nonReentrant`; `buyout` writes
`launched = true` before any interaction (`:501`); `swap` writes both reserves
before either transfer (`:434-440`). The team already added an outbound-transfer
reentrancy mock this round (`test/ReentrantToken.sol`, `setReentrantTransferCall`)
and exercises it at `test/PreMarket.ts:1270-1293` and
`test/LockedLpVault.ts:806-838`. Good coverage.

**Test gaps this pass noticed** (for whoever owns the fix list): no test seeds a
premarket with a blacklistable quote or token and confirms the strand
(ECS-R2-2); no test asserts `token == usdc` is rejected at seed time
(ECS-R2-5); no test makes `pool.claimFees` revert and checks whether accrued
balances remain claimable (ECS-R2-3). `BlacklistableERC20.sol` already exists in
`contracts/test/`, so all three are cheap.

---

## Routed to other passes

Found here, out of this pass's remit:

- **`startPrice` has no upper bound** (`PreMarket.sol:313` checks only `!= 0`).
  `currentPrice()` computes `startPrice * decayBpsPerMinute * elapsed`
  (`:356`), which overflows and reverts for `startPrice` above roughly `2^223`.
  A seeder passing `2^250` bricks `currentPrice()`, `buyoutCost()` and `buyout()`
  within one second of seeding — another permanent strand. → **input-arithmetic**.
- **The auction has no reserve price** and reaches the `MIN_BUYOUT_USDC` floor in
  `600000 / decayBpsPerMinute` seconds — 50 minutes at the documented default,
  60 seconds at the maximum permitted `decayBpsPerMinute = 10000`. This is the
  amplifier under ECS-R2-1 and is an economic-design question in its own right.
  → **economics / business-logic**.
- **`setLp` / `setIntegrator` transfer accrued balances with the role**
  (`LockedLpVault.sol:291-309`), so a party selling or delegating its role can
  front-run the handover with a claim. Documented at `:284-288`, so probably
  intended — worth a second opinion. → **business-logic**.
- **`PreMarketFactory` does not reject `p.token == p.quote`.** I traced it: the
  reserves stay separately tracked against one shared balance, the curve still
  makes round trips lossy, and `buyout` nets out correctly, so I found no
  extraction. Recording it in case another pass sees an angle I did not.
