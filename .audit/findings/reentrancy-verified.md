# Reentrancy Pattern Analysis Report — EXNIHILO

## Scope

- **Contracts:** EXNIHILOPool, PositionNFT, EXNIHILOFactory, EXNIHILORouter, LpNFT, AirToken
- **Excluded:** Faucet.sol (testnet-only), test/ directory

---

## Phase 1: Call Graph Construction

### EXNIHILOPool — External Calls by Function

| Function | nonReentrant | External Calls (ordered) | State Writes After Last Call |
|----------|-------------|-------------------------|----------------------------|
| `swap` | ✓ | `_transferIn` → `airToken.mint` → `airUsdToken.burn` → `underlyingUsdc.safeTransfer` → `_assertReserveInvariant` (view) | None — all effects before interactions |
| `openLong` | ✓ | `_transferIn(usdc)` → `underlyingUsdc.safeTransfer(treasury)` → `airToken.forceApprove(NFT)` → `positionNFT.mintLong` (includes `_safeMint` callback) → `airToken.forceApprove(0)` → `_assertReserveInvariant` | None — effects at L506–516, interactions start L521 |
| `closeLong` | ✓ | `positionNFT.release` → `airUsdToken.burn×2` → `underlyingUsdc.safeTransfer×2` → `_assertReserveInvariant` | None — effects at L595–603, interactions start L606 |
| `realizeLong` | ✓ | `_transferIn(usdc)` → `positionNFT.release` → `airToken.burn` → `underlyingToken.safeTransfer` → `_assertReserveInvariant` | `backedAirUsd += pos.airUsdMinted` at L654, AFTER `_transferIn` at L651 |
| `openShort` | ✓ | `_transferIn(usdc)` → `underlyingUsdc.safeTransfer(treasury)` → `airUsdToken.forceApprove` → `positionNFT.mintShort` → `airUsdToken.forceApprove(0)` → `_assertReserveInvariant` | None — effects at L739–747, interactions start L752 |
| `closeShort` | ✓ | `positionNFT.release` → `airToken.burn` → `airUsdToken.burn` → `underlyingUsdc.safeTransfer×2` → `_assertReserveInvariant` | None — effects at L827–829, interactions start L832 |
| `realizeShort` | ✓ | `_transferIn(token)` → `positionNFT.release` → `airUsdToken.burn` → `underlyingUsdc.safeTransfer` → `_assertReserveInvariant` | `backedAirToken += pos.airTokenMinted` at L877, AFTER `_transferIn` at L874 |
| `addLiquidity` | ✓ | `_transferIn×2` → `airToken.mint` → `airUsdToken.mint` → `_assertReserveInvariant` | None — effects at L920–921, interactions start L924 |
| `removeLiquidity` | ✓ | `airToken.burn` → `underlyingToken.safeTransfer` → `airUsdToken.burn` → `underlyingUsdc.safeTransfer` | None — effects at L950–951, interactions start L954 |
| `claimFees` | ✓ | `underlyingUsdc.safeTransfer` | None — effect at L972, interaction at L974 |
| `renewPosition` | ✓ | `_transferIn(usdc)` → `underlyingUsdc.safeTransfer(treasury)` → `positionNFT.extendDeadline` | None — effect at L1012, interactions start L1015 |
| `closePositionAfterDeadline` | ✓ | Delegates to `_closeExpiredLong`/`_closeExpiredShort` (same patterns as closeLong/closeShort) | None |
| `closePool` | ✓ | None — pure state write | N/A |
| `setPositionCaps` | **NO** | None — pure state write | N/A |

### EXNIHILOFactory — External Calls

| Function | nonReentrant | External Calls |
|----------|-------------|----------------|
| `createMarket` | ✓ | `safeTransferFrom×2` → `new AirToken×2` → `new EXNIHILOPool` → `airToken.initPool×2` → `lpNftContract.mint` → `forceApprove×2` → `addLiquidity` → `IERC721.transferFrom` |
| `setDeployer` | NO | None — pure state write |

### EXNIHILORouter — External Calls

| Function | nonReentrant | External Calls |
|----------|-------------|----------------|
| `openLong` | ✓ | `safeTransferFrom` → `forceApprove` → `pool.openLong` → `forceApprove(0)` |
| `openShort` | ✓ | Same pattern |
| `swap` | ✓ | Same pattern |
| `renewPosition` | ✓ | Same pattern |
| `sweep` | NO | `token.safeTransfer(msg.sender, balance)` |

### PositionNFT — External Calls

| Function | External Calls | Guard |
|----------|----------------|-------|
| `mintLong` | `IERC20.safeTransferFrom(pool)` → `_safeMint(to)` | Pool-only access |
| `mintShort` | `IERC20.safeTransferFrom(pool)` → `_safeMint(to)` | Pool-only access |
| `release` | `IERC20.safeTransfer(pool)` + `_burn` | Pool-only access |

---

## Phase 2: CEI Violation Detection

### Strict CEI Violations Found

**realizeLong (L637–667):**
```
L646: openPositionCount--;           // EFFECT
L647: longOpenInterest -= ...;       // EFFECT
L651: _transferIn(usdc, msg.sender, pos.airUsdMinted);  // INTERACTION
L654: backedAirUsd += pos.airUsdMinted;                 // EFFECT ← AFTER interaction
L657: positionNFT.release(nftId);    // INTERACTION
L662: airToken.burn(...);            // INTERACTION
L663: underlyingToken.safeTransfer(...); // INTERACTION
```

**State write after external call:** `backedAirUsd` is updated at L654 AFTER `_transferIn` at L651.

**Is this exploitable?**
- `_transferIn` calls `safeTransferFrom` from `msg.sender` (the position holder).
- If `underlyingUsdc` is a callback-enabled token (ERC-777), the sender's `tokensToSend` hook fires during `_transferIn`.
- At that point, `backedAirUsd` has NOT been updated yet.
- BUT: `nonReentrant` is held on the pool. Any reentrant call to any pool function reverts.
- The callback could call OTHER contracts that read `pool.backedAirUsd()` — **read-only reentrancy**.

**Read-only reentrancy impact:** During the callback window, `backedAirUsd` is stale (lower than it should be). Any external contract reading `pool.backedAirUsd()` or view functions (`spotPrice()`, `shortPrice()`, `effectiveLeverageCap()`) would see a lower-than-actual value. However:
- USDC is NOT ERC-777 (no callback hooks)
- The pool's own state is protected by `nonReentrant`
- There are no known third-party contracts that depend on EXNIHILO's view functions for pricing

**Verdict: CEI deviation is INTENTIONAL (pessimistic accounting — don't credit until funds confirmed) and SAFE due to nonReentrant + USDC being non-callback.**

---

**realizeShort (L860–889):**
```
L869: openPositionCount--;           // EFFECT
L870: shortOpenInterest -= ...;      // EFFECT
L874: _transferIn(underlyingToken, msg.sender, pos.airTokenMinted);  // INTERACTION
L877: backedAirToken += pos.airTokenMinted;                          // EFFECT ← AFTER interaction
L880: positionNFT.release(nftId);    // INTERACTION
L885: airUsdToken.burn(...);         // INTERACTION
L886: underlyingUsdc.safeTransfer(...); // INTERACTION
```

Same pattern: `backedAirToken` updated after `_transferIn`. The `underlyingToken` IS user-supplied and COULD be an ERC-777 token. However:
- `nonReentrant` is held — pool is reentry-safe
- `_transferIn` includes a balance check that would detect ERC-777 rebase behavior
- Fee-on-transfer check would catch many non-standard behaviors
- The ERC-777 `tokensToSend` callback fires on the SENDER (msg.sender), not the receiver

If msg.sender has a `tokensToSend` hook (ERC-777 sender hook):
- During the hook, `backedAirToken` is stale
- Pool's `nonReentrant` blocks any reentrant call to the pool
- External contracts reading `pool.backedAirToken()` see a stale value

**Read-only reentrancy via ERC-777 underlying:**

### Finding: RE-1 — Read-only reentrancy window in realizeShort with ERC-777 underlying

**Function:** `realizeShort()` at `EXNIHILOPool.sol:L874–877`
**Variant:** Read-Only Reentrancy
**Severity:** LOW
**Guard Status:** Guarded (nonReentrant on pool)

**CEI Violation:**
- External call at L874: `_transferIn(underlyingToken, msg.sender, pos.airTokenMinted)`
- State write AFTER call at L877: `backedAirToken += pos.airTokenMinted`

**Re-Entry Path:**
1. Position holder calls `realizeShort(nftId)`
2. `_transferIn` calls `underlyingToken.safeTransferFrom(msg.sender, pool, amount)`
3. If underlying is ERC-777, sender's `tokensToSend()` hook fires
4. During hook: `backedAirToken` not yet updated (stale, lower than actual)
5. Any external contract calling `pool.backedAirToken()`, `pool.spotPrice()`, or `pool.shortPrice()` during this window sees incorrect values

**Impact:**
Theoretical read-only reentrancy. For exploitation, a third-party contract would need to:
- Read EXNIHILO pool's view functions during the ERC-777 callback
- Make a financial decision based on the stale value
- Currently, no known third-party integration exists

**Mitigating Factors:**
1. `nonReentrant` prevents all pool state modification during the window
2. The pattern is intentional — "pessimistic accounting" documented in code comments
3. Standard tokens (USDC, most ERC-20s) have no callback hooks
4. Market creator chooses the underlying token — using ERC-777 is their choice
5. The `_transferIn` balance check would catch most non-standard token behaviors

**Recommendation:** No code change required. The risk is theoretical and limited to ERC-777 underlyings with third-party integrations reading pool state during the callback. For maximum defense-in-depth, the state write could be moved before `_transferIn`:

```solidity
// Current (pessimistic):
_transferIn(underlyingToken, msg.sender, pos.airTokenMinted);
backedAirToken += pos.airTokenMinted;

// Alternative (strict CEI, optimistic):
backedAirToken += pos.airTokenMinted;
_transferIn(underlyingToken, msg.sender, pos.airTokenMinted);
// If _transferIn reverts, backedAirToken rolls back anyway (tx reverts)
```

However, the current pattern is a valid design choice — don't credit reserves until tokens are confirmed received.

---

### Cross-Function Reentrancy Analysis

**Question:** During ANY external call in a `nonReentrant` function, can a different function on the SAME contract be called?

**Answer: No.** All state-changing functions on EXNIHILOPool share the same `ReentrancyGuard` lock. During any external call within a `nonReentrant` function, all other `nonReentrant` functions on the pool are blocked.

**Exception: `setPositionCaps`** — this function does NOT have `nonReentrant`. It only writes `maxPositionUsd` and `maxPositionBps`. During a callback from any other pool function, could a reentrant call to `setPositionCaps` cause harm?

- `setPositionCaps` is `onlyLpHolder` — requires `lpNftContract.ownerOf(lpNftId) == msg.sender`
- During an ERC-721 `_safeMint` callback in `openLong`, `msg.sender` is the `recipient` (position opener), NOT the LP holder
- For the LP holder to call `setPositionCaps` during a callback, the LP holder would need to be the one triggering the callback — which only happens if the LP holder opens a position to their own address AND that address is a contract with an `onERC721Received` handler

**Scenario:** LP holder (contract) opens a long position. `positionNFT.mintLong` calls `_safeMint(lpHolderContract)`. The `onERC721Received` callback fires on the LP holder contract. During this callback, the LP holder contract calls `setPositionCaps` — which is NOT blocked by `nonReentrant`.

**Impact:** The LP holder changes their own position caps during their own position open. Since caps are checked at the START of `openLong` (L472 `_checkLeverageCap`), and the callback fires AFTER the check, the cap change doesn't affect the current operation. It would affect the NEXT operation. This is the LP changing their own settings — not an attack.

**Verdict: No exploitable cross-function reentrancy.**

---

### Callback Vector Analysis

| Callback Source | Function | Token Type | Fires When | Protected? |
|----------------|----------|-----------|------------|-----------|
| `_safeMint(to)` in `positionNFT.mintLong` | `openLong` | ERC-721 | Position recipient is contract | ✓ nonReentrant on pool; all state updated before callback |
| `_safeMint(to)` in `positionNFT.mintShort` | `openShort` | ERC-721 | Position recipient is contract | ✓ Same |
| `safeTransferFrom` in `_transferIn` | All functions with token input | ERC-20 (potentially 777) | Sender has `tokensToSend` hook | ✓ nonReentrant; see RE-1 for read-only window |
| `safeTransfer` in output transfers | closeLong, closeShort, etc. | ERC-20 (potentially 777) | Recipient has `tokensReceived` hook | ✓ nonReentrant; all state updated before transfer |
| `IERC721.transferFrom` in Factory | createMarket | ERC-721 | LP NFT transfer to creator | ✓ nonReentrant on factory |

**ERC-721 `_safeMint` in PositionNFT:**

`positionNFT.mintLong` calls `_safeMint(to, tokenId)` which triggers `onERC721Received(to)` if `to` is a contract. At this point:
- Pool state: ALL effects complete (L506–516 in `openLong`)
- `backedAirToken` decreased ✓
- `openPositionCount` incremented ✓
- `longOpenInterest` updated ✓
- `lpFeesAccumulated` updated ✓
- `airUsdToken` minted ✓
- Fee collected ✓

The only thing NOT done: `_assertReserveInvariant()` (L540) and `emit` (L542). These don't change state.

**Verdict: ERC-721 callback at `_safeMint` is SAFE — all state is consistent at callback time.**

---

### Read-Only Reentrancy — View Function Analysis

During any external call in a `nonReentrant` function, view functions remain callable. Could a third-party contract read stale state?

| View Function | Reads | Stale During Which Operations? | Impact |
|--------------|-------|-------------------------------|--------|
| `spotPrice()` | `backedAirUsd / backedAirToken` | realizeLong (backedAirUsd stale), realizeShort (backedAirToken stale) | Incorrect spot price |
| `longPrice()` | `airUsdToken.totalSupply() / backedAirToken` | realizeShort (backedAirToken stale) | Incorrect long entry price |
| `shortPrice()` | `backedAirUsd / airToken.totalSupply()` | realizeLong (backedAirUsd stale) | Incorrect short entry price |
| `effectiveLeverageCap()` | `backedAirUsd * maxPositionBps / BPS_DENOM` | realizeLong (backedAirUsd stale) | Incorrect cap |
| `backedAirToken()` (public) | Direct storage read | realizeShort window | Lower than actual |
| `backedAirUsd()` (public) | Direct storage read | realizeLong window | Lower than actual |

**Exploitation requirements:**
1. Underlying token must be ERC-777 (for callback during `_transferIn`)
2. A third-party contract must read pool's view functions during the callback
3. The third-party must make a financial decision based on the stale value
4. Currently: no known third-party integration exists

**For ALL other functions** (swap, openLong, openShort, closeLong, closeShort, addLiquidity, removeLiquidity, claimFees, renewPosition, closePositionAfterDeadline):
- **All state effects complete before any external call** (strict CEI)
- No read-only reentrancy window exists

---

### Cross-Contract Reentrancy Analysis

**EXNIHILOPool ↔ PositionNFT:**

During `positionNFT.release(nftId)`:
- PositionNFT deletes position data, burns NFT, transfers locked tokens to pool
- The pool calls this AFTER updating its own state
- The `safeTransfer` in `release()` sends tokens TO the pool (not to an untrusted address) — no user-controlled callback
- ✓ SAFE

During `positionNFT.mintLong/mintShort`:
- PositionNFT pulls tokens from pool, mints NFT with `_safeMint` callback to recipient
- Pool state is fully updated before this call
- ✓ SAFE

**EXNIHILOPool ↔ AirToken:**

All `airToken.mint/burn` and `airUsdToken.mint/burn` calls are to trusted, protocol-controlled AirToken contracts. AirToken is a standard ERC-20 (`_mint`/`_burn` are OpenZeppelin internal functions with no callbacks). ✓ SAFE

**EXNIHILORouter ↔ EXNIHILOPool:**

The router calls pool functions. Both have `nonReentrant`. The router's lock and the pool's lock are SEPARATE. This means:
- During `router.openLong` → `pool.openLong`, the pool's `nonReentrant` is acquired
- If a callback during `pool.openLong` calls back to the router, the router's `nonReentrant` lock is NOT held (it was released when `pool.openLong` was called? No — the router is still in its `nonReentrant` scope)

Actually: `router.openLong` is `nonReentrant`. Inside it calls `pool.openLong`. During the `_safeMint` callback in the pool, the callback could theoretically call back to the ROUTER. The router's `nonReentrant` IS still held (the router function hasn't returned). So reentrant calls to the router also fail. ✓ SAFE

---

## Phase 3: Guard Coverage Verification

### nonReentrant Coverage

| Function | Has nonReentrant? | Makes External Calls? | Shares State? | Status |
|----------|-------------------|----------------------|---------------|--------|
| `swap` | ✓ | ✓ | ✓ | ✓ Protected |
| `openLong` | ✓ | ✓ | ✓ | ✓ Protected |
| `closeLong` | ✓ | ✓ | ✓ | ✓ Protected |
| `realizeLong` | ✓ | ✓ | ✓ | ✓ Protected (CEI deviation intentional) |
| `openShort` | ✓ | ✓ | ✓ | ✓ Protected |
| `closeShort` | ✓ | ✓ | ✓ | ✓ Protected |
| `realizeShort` | ✓ | ✓ | ✓ | ✓ Protected (CEI deviation intentional) |
| `addLiquidity` | ✓ | ✓ | ✓ | ✓ Protected |
| `removeLiquidity` | ✓ | ✓ | ✓ | ✓ Protected |
| `claimFees` | ✓ | ✓ | ✓ | ✓ Protected |
| `renewPosition` | ✓ | ✓ | ✓ | ✓ Protected |
| `closePositionAfterDeadline` | ✓ | ✓ | ✓ | ✓ Protected |
| `closePool` | ✓ | ✗ | ✓ | ✓ Protected (no calls, extra safety) |
| **`setPositionCaps`** | **✗** | **✗** | ✓ (maxPositionUsd/Bps) | ✓ Safe — no external calls, LP-only |

### CEI Compliance

| Function | Strict CEI? | Deviation | Risk |
|----------|------------|-----------|------|
| `swap` | ✓ | None | None |
| `openLong` | ✓ | None | None |
| `closeLong` | ✓ | None | None |
| `openShort` | ✓ | None | None |
| `closeShort` | ✓ | None | None |
| `addLiquidity` | ✓ | None | None |
| `removeLiquidity` | ✓ | None | None |
| `claimFees` | ✓ | None | None |
| `renewPosition` | ✓ | None | None |
| `closePositionAfterDeadline` | ✓ | None | None |
| **`realizeLong`** | **Partial** | `backedAirUsd` written after `_transferIn` | LOW — nonReentrant; intentional pessimistic accounting |
| **`realizeShort`** | **Partial** | `backedAirToken` written after `_transferIn` | LOW — nonReentrant; ERC-777 read-only window |

---

## Summary

| ID | Finding | Variant | Severity |
|----|---------|---------|----------|
| RE-1 | Read-only reentrancy window in realizeShort (ERC-777 underlying) | Read-Only | LOW |

```
Final:  0 CRITICAL | 0 HIGH | 0 MEDIUM | 1 LOW
```

### Reentrancy Defense Assessment

The EXNIHILO codebase has **comprehensive reentrancy protection:**

1. **`nonReentrant` on ALL 14 state-changing functions** that make external calls (the one exception, `setPositionCaps`, makes no external calls)
2. **Strict CEI in 12 of 14 functions** — state fully updated before any external interaction
3. **Intentional CEI deviation in 2 functions** (`realizeLong`, `realizeShort`) — documented "pessimistic accounting" pattern where backed reserve is credited only after confirming token receipt
4. **AirToken is protocol-controlled** — no callback risk from wrapper tokens
5. **ERC-721 `_safeMint` callback** fires only after all pool state is consistent
6. **Separate nonReentrant locks** on Pool, Router, and Factory prevent cross-contract reentry through all paths
7. **`_transferIn` balance check** catches non-standard token behaviors that could desynchronize accounting

The single LOW finding (RE-1) requires an ERC-777 underlying token AND a third-party contract reading stale pool view functions during a callback — a theoretical risk with no current exploitation path.
