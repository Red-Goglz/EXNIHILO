# External Call Safety Report — EXNIHILO

## Scope

- **Contracts:** EXNIHILOPool, PositionNFT, EXNIHILOFactory, EXNIHILORouter, LpNFT, AirToken
- **Excluded:** Faucet.sol (testnet-only), test/ directory

---

## Quick Detection Checklist

- [x] Are ALL low-level `call` return values checked? **No low-level calls in core contracts.** Only Faucet (out of scope) uses `.call{value:}`, and both are checked with `require(ok)`. ✓
- [x] Does the protocol use `SafeERC20` for all token interactions? **Yes.** All four core contracts declare `using SafeERC20 for IERC20` (Pool, Factory, Router, PositionNFT). Pool also has `using SafeERC20 for IAirToken`. ✓
- [x] Does the deposit function use balance-before-after for fee-on-transfer? **Yes.** `_transferIn()` at `EXNIHILOPool.sol:L1332–1338` checks `balanceOf(this)` before and after, reverts with `FeeOnTransferNotSupported` on mismatch. ✓
- [x] Does the protocol handle or reject rebasing tokens? **Implicitly rejected** — rebasing changes would break `backedAirToken`/`backedAirUsd` accounting without triggering _transferIn. See analysis below.
- [x] Does `approve()` reset to 0 before setting new allowance? **Yes.** All approvals use `forceApprove()` from SafeERC20 (handles USDT's non-zero-to-non-zero revert). No raw `.approve()` calls exist. ✓
- [x] Are batch payment operations using pull pattern? **No batch operations.** LP fees use pull (`claimFees`). Position payouts are single-recipient push. See DoS-2 in DoS report for blacklist impact. ✓
- [x] Is `delegatecall` only used with trusted targets? **No `delegatecall` or `staticcall` in any core contract.** ✓
- [x] Are return data sizes from untrusted contracts limited? **No raw calls to untrusted contracts.** All external calls are via SafeERC20 wrappers or to known protocol contracts (PositionNFT, AirToken, LpNFT). ✓
- [x] Does the protocol handle token blacklisting gracefully? **Partially.** See DoS report DoS-1 and DoS-2 for blacklist impact analysis.

---

## Part 1: External Call Safety

### Class 1: Unchecked Return Values

**All external calls in core contracts use SafeERC20 wrappers:**

| Pattern | Count | Method | Safe? |
|---------|-------|--------|-------|
| `token.safeTransfer(to, amount)` | 16 | SafeERC20 wrapper — reverts on failure | ✓ |
| `token.safeTransferFrom(from, to, amount)` | 6 | SafeERC20 wrapper — reverts on failure | ✓ |
| `token.forceApprove(spender, amount)` | 10 | SafeERC20 wrapper — handles USDT | ✓ |
| `airToken.mint(to, amount)` | 4 | Direct call to trusted AirToken (always succeeds or reverts) | ✓ |
| `airToken.burn(from, amount)` | 8 | Direct call to trusted AirToken | ✓ |
| `positionNFT.mintLong/mintShort` | 2 | Direct call to trusted PositionNFT | ✓ |
| `positionNFT.release(id)` | 6 | Direct call to trusted PositionNFT | ✓ |
| `positionNFT.extendDeadline(id, d)` | 1 | Direct call to trusted PositionNFT | ✓ |
| `lpNftContract.ownerOf(id)` | 1 (modifier) | Direct call to trusted LpNFT | ✓ |

**No raw `.call`, `.delegatecall`, or `.staticcall` in core contracts.**

**Result: NO UNCHECKED RETURN VALUE ISSUES.**

### Class 2: Gas Stipend Limitations

**No `.transfer()` or `.send()` in core contracts.** All ETH-like transfers use SafeERC20's `safeTransfer` (for ERC-20 USDC/tokens). No ETH is handled by the pool.

**Result: NO GAS STIPEND ISSUES.**

### Class 3: Return Data Bomb

**No raw `.call()` to untrusted contracts.** All external calls are to:
- Known protocol contracts (AirToken, PositionNFT, LpNFT) — trusted, immutable
- ERC-20 tokens via SafeERC20 — return data is small (bool or empty)
- `protocolTreasury` — via SafeERC20's `safeTransfer`, not raw call

**Result: NO RETURN DATA BOMB RISK.**

### Class 4: Delegatecall to Untrusted Contract

**No `delegatecall` anywhere in the codebase.**

**Result: NO DELEGATECALL RISK.**

---

## Part 2: Token Integration Safety

### Token Interaction Inventory

The protocol interacts with exactly two user-supplied external ERC-20 tokens per pool:

| Token | Set By | Type | How Used |
|-------|--------|------|----------|
| `underlyingUsdc` | Factory (immutable) | USDC (6 dec) | Fee collection, collateral, payouts |
| `underlyingToken` | Factory (immutable) | Arbitrary ERC-20 | Swap counterpart, LP collateral |

Plus two protocol-controlled tokens per pool:

| Token | Type | How Used |
|-------|------|----------|
| `airToken` | AirToken (trusted, pool-only mint/burn) | Wrapper for underlying token |
| `airUsdToken` | AirToken (trusted, pool-only mint/burn) | Wrapper for USDC |

### Issue 1: Fee-on-Transfer Tokens

**Protection present:** `_transferIn()` at `EXNIHILOPool.sol:L1332–1338`:

```solidity
function _transferIn(IERC20 token, address from, uint256 amount) internal {
    uint256 balanceBefore = token.balanceOf(address(this));
    token.safeTransferFrom(from, address(this), amount);
    if (token.balanceOf(address(this)) - balanceBefore != amount) {
        revert FeeOnTransferNotSupported();
    }
}
```

This is the **correct** balance-before-after pattern. Any fee-on-transfer token will cause the balance delta to be less than `amount`, triggering the revert.

**Coverage check — are ALL incoming token transfers routed through `_transferIn`?**

| Function | Incoming Transfer | Via `_transferIn`? |
|----------|------------------|-------------------|
| `openLong` | `underlyingUsdc` (fee) | ✓ L521 |
| `openShort` | `underlyingUsdc` (fee) | ✓ L752 |
| `realizeLong` | `underlyingUsdc` (debt) | ✓ L651 |
| `realizeShort` | `underlyingToken` (debt) | ✓ L874 |
| `swap (tokenToUsdc)` | `underlyingToken` | ✓ L1124 |
| `swap (usdcToToken)` | `underlyingUsdc` | ✓ L1147 |
| `addLiquidity` | `underlyingToken` + `underlyingUsdc` | ✓ L924–925 |
| `renewPosition` | `underlyingUsdc` (fee) | ✓ L1015 |

**All incoming transfers use `_transferIn`.** ✓

**Factory `createMarket`** uses `safeTransferFrom` directly (L179–180), NOT `_transferIn`. But the factory immediately forwards these tokens to the pool via `addLiquidity`, where the pool's own `_transferIn` handles the check. If the underlying token is fee-on-transfer, the `addLiquidity` call would pull less than approved, and the pool's `_transferIn` would revert. The factory itself doesn't check, but the pool does. ✓

**PositionNFT** uses `safeTransferFrom` (L229, L261) to pull airToken/airUsd from the pool. These are protocol-controlled AirToken contracts with no fees. ✓

**Result: FEE-ON-TRANSFER TOKENS PROPERLY REJECTED.**

### Issue 2: Rebasing Tokens

**Not explicitly handled.** The pool stores `backedAirToken` and `backedAirUsd` as absolute amounts. If the `underlyingToken` or `underlyingUsdc` is a rebasing token:

- A **positive rebase** (balance increases without transfers) would mean the pool holds more tokens than `backedAirToken` reflects. The excess is silently trapped — never accounted for, never withdrawable.
- A **negative rebase** (balance decreases without transfers) would mean the pool holds fewer tokens than `backedAirToken` claims. Subsequent withdrawals (swap out, realizeLong, removeLiquidity) would fail when `safeTransfer` tries to send more than the actual balance.

**However:** The protocol's USDC token is explicitly USDC (6 decimals) — not a rebasing token. The `underlyingToken` is user-supplied at market creation. If someone creates a market with stETH as the underlying, it would break.

### Finding: ECS-1 — Rebasing underlying tokens silently break pool accounting

**Function:** All pool operations at `EXNIHILOPool.sol`
**Category:** Rebasing Token
**Severity:** LOW (user-supplied token — market creator's responsibility)

**Issue:**
If `underlyingToken` is a rebasing token (e.g., stETH, AMPL), `backedAirToken` becomes desynchronized from the actual token balance after a rebase. Positive rebases trap value; negative rebases cause withdrawal failures.

**Affected Tokens:** stETH, AMPL, OHM, YAM, BASED, aTokens (Aave)

**Impact:** Pool with rebasing underlying cannot function correctly. However, the market creator chooses the underlying token — they would need to deliberately create a market with a rebasing token.

**Recommendation:**
Document clearly that rebasing tokens are not supported as the underlying. Optionally add an on-chain check in `createMarket` (e.g., require the token to have no built-in rebase function), though this is hard to enforce generically.

---

### Issue 3: Missing Return Values (USDT Compatibility)

**Fully handled.** All contracts use OpenZeppelin's `SafeERC20`:
- `safeTransfer` / `safeTransferFrom` — handle tokens that don't return a bool
- `forceApprove` — handles USDT's revert-on-nonzero-to-nonzero approve

No raw `.transfer()`, `.transferFrom()`, or `.approve()` calls exist in any core contract.

**Result: MISSING RETURN VALUE TOKENS FULLY SUPPORTED.** ✓

### Issue 4: Tokens with Callbacks (ERC-777)

**ERC-777 reentrancy analysis:**

If `underlyingToken` is an ERC-777 token, `safeTransferFrom` in `_transferIn` would trigger `tokensToSend` on the sender and `tokensReceived` on the pool. However:

1. **All state-changing pool functions are `nonReentrant`.** Even if the callback reenters the pool, the reentrancy guard reverts.
2. **`_transferIn` is called in the INTERACTIONS phase** (after EFFECTS), following CEI. State is consistent before the callback fires.
3. **The pool does not implement `tokensReceived()` or register with ERC-1820.** ERC-777 callbacks to the pool would fail silently (non-implementing receiver), or the ERC-777 token would require the receiver to be registered (which the pool isn't), and the transfer would revert.

For `underlyingUsdc` (USDC): USDC is not ERC-777. No callback risk.

For AirToken: AirToken is a standard ERC-20. No callbacks. ✓

**Result: ERC-777 REENTRANCY MITIGATED BY nonReentrant + CEI.** ✓

### Issue 5: Unsafe Approve Pattern

**All approvals use `forceApprove()` from SafeERC20:**

| Location | Code | Token | Safe? |
|----------|------|-------|-------|
| Pool L524 | `airToken.forceApprove(positionNFT, airTokenOut)` | AirToken (standard) | ✓ |
| Pool L538 | `airToken.forceApprove(positionNFT, 0)` | AirToken | ✓ (reset) |
| Pool L755 | `airUsdToken.forceApprove(positionNFT, airUsdOut)` | AirToken | ✓ |
| Pool L768 | `airUsdToken.forceApprove(positionNFT, 0)` | AirToken | ✓ (reset) |
| Router L91 | `usdc.forceApprove(pool, fee)` | USDC | ✓ |
| Router L93 | `usdc.forceApprove(pool, 0)` | USDC | ✓ (reset) |
| Factory L226 | `IERC20(tokenAddress).forceApprove(pool, tokenAmount)` | Arbitrary | ✓ |
| Factory L227 | `IERC20(usdc).forceApprove(pool, usdcAmount)` | USDC | ✓ |

**`forceApprove`** handles USDT's non-zero-to-non-zero revert by first setting to 0, then to the desired amount. All approvals that are set are also cleared after use (Pool and Router). Factory approvals are not cleared but the factory holds 0 tokens after `createMarket` (see Nemesis NM-002).

**No approve race condition risk:** Approvals are set and consumed in the same transaction. No window for front-running.

**Result: APPROVE PATTERN FULLY SAFE.** ✓

### Issue 6: Tokens with Blacklists (USDC)

**USDC is the quote token** — it has a blacklist. Impact analysis:

| Blacklisted Entity | Affected Operations | Severity |
|-------------------|-------------------|----------|
| `protocolTreasury` | openLong, openShort, closeLong (profitable), closeShort (profitable), renewPosition — all revert | LOW (trusted setup) |
| Position holder | closeLong/closeShort (profitable) revert for that holder | MEDIUM (see DoS-2) |
| LP NFT holder | claimFees, removeLiquidity revert for LP | LOW (LP's own problem) |
| Pool contract itself | All USDC transfers to/from pool fail — pool completely bricked | CRITICAL in theory, but blacklisting a pool contract requires USDC issuer action |

**Key finding (cross-ref DoS-2):** A blacklisted position holder with an expired profitable position permanently blocks `openPositionCount` from reaching 0, trapping LP liquidity. This was identified in the DoS report and remains the most significant blacklist-related finding.

**For `underlyingToken`:** If the underlying token also has a blacklist (less common), similar issues apply to swap and realize operations. But the market creator chose this token — caveat emptor.

**Result: BLACKLIST IMPACT ANALYZED. See DoS report for actionable findings.**

### Issue 7: Tokens with Transfer Limits

Some tokens have per-transaction or per-address holding limits. If `underlyingToken` has such limits:
- `addLiquidity` might fail if the deposit exceeds the token's max transfer amount
- `swap` output might exceed the recipient's holding limit
- Pool itself could hit a holding limit during high-volume deposits

**Impact:** The market creator chose this token. If it has transfer limits, the pool would revert on operations exceeding those limits. This is the creator's problem, not a protocol vulnerability.

**Result: INFORMATIONAL — market creator responsibility.**

---

## Part 3: Payment Pattern Analysis

### Push vs Pull Analysis

| Operation | Pattern | Recipients | Risk |
|-----------|---------|-----------|------|
| `claimFees` | **PULL** — LP calls to claim accumulated fees | Single (LP holder) | Low — LP's own action |
| `closeLong/closeShort` | **PUSH** — pool sends USDC to holder + treasury | Two known recipients | Medium — blacklisted holder blocks (see DoS-2) |
| `closePositionAfterDeadline` | **PUSH** — pool sends to original holder + treasury | Two known recipients | Medium — same blacklist issue |
| `realizeLong` | **PUSH** — pool sends underlying to holder | Single | Low — holder initiated |
| `realizeShort` | **PUSH** — pool sends USDC to holder | Single | Low — holder initiated |
| `swap` | **PUSH** — pool sends output to recipient | Single (user-supplied) | Low — caller's chosen recipient |
| `removeLiquidity` | **PUSH** — pool sends both tokens to LP | Single (LP) | Low — LP initiated |
| Protocol fees | **PUSH** — sent to treasury inline | Single (immutable address) | Low — trusted setup |

**The protocol fee PUSH pattern is the main concern:** If `protocolTreasury` becomes unreachable (blacklisted, self-destructed contract), multiple critical functions revert. A pull pattern for protocol fees would be more resilient.

**Position holder PUSH pattern:** The position holder receives payouts via push in close operations. A pull pattern would make `closePositionAfterDeadline` more resilient to holder blacklisting. This is the DoS-2 finding.

---

## Summary of Findings

| ID | Finding | Category | Severity |
|----|---------|----------|----------|
| ECS-1 | Rebasing underlying tokens silently break pool accounting | Rebasing Token | LOW |

**No new HIGH or CRITICAL findings.** The codebase demonstrates strong external call safety:

- **SafeERC20 everywhere** — no raw transfer/approve calls
- **`forceApprove`** — USDT-compatible approval pattern
- **`_transferIn` balance check** — fee-on-transfer rejected
- **`nonReentrant` + CEI** — ERC-777 callback reentrancy mitigated
- **No raw `.call`/`.delegatecall`/`.staticcall`** in core contracts
- **No `address(this).balance` accounting** — force-feed immune

**Cross-references to other audit reports:**
- **DoS-1 (LOW):** Blacklisted `protocolTreasury` blocks pool operations → recommend pull pattern for protocol fees
- **DoS-2 (MEDIUM):** Blacklisted position holder blocks LP exit → recommend escrow fallback in expired close path
- **Nemesis NM-002 (LOW):** Factory residual approvals not cleared after `addLiquidity`

```
Final:  0 CRITICAL | 0 HIGH | 0 MEDIUM | 1 LOW | 0 INFO
        (Plus cross-references to DoS report findings)
```
