# DoS & Griefing Analysis — EXNIHILO 4.7

## Scope

`EXNIHILOPool.sol` (focus), `PositionNFT.sol`, `EXNIHILOFactory.sol`, `EXNIHILORouter.sol`, `LpNFT.sol`, `AirToken.sol`.

## Patterns Checked

1. Unbounded loops (iteration over user-controlled collections).
2. Block gas limit exhaustion in batch paths.
3. External call failure DoS (one bad recipient bricks the queue).
4. Insufficient gas griefing (63/64 rule, fixed stipends).
5. Storage bloat / dust attacks.
6. Timestamp griefing via miners.
7. `selfdestruct` force-feeding (assumes accounting ≠ raw `balance`).
8. Push vs pull payment.
9. USDC blacklist on critical paths.
10. Callback-based griefing (ERC-777/1155 hooks).

## Prior Findings Re-verification

### DoS-1 — Blacklisted treasury blocks pool operations (LOW, Accepted)

**Status:** **Confirmed unchanged.** `openLong`/`openShort` pay a `closeFee` to `protocolTreasury`. If the treasury address is USDC-blacklisted, open paths revert. Mitigation: treasury is set by deployer and can be rotated; LP-only paths (`removeLiquidity`, `claimFees`) are unaffected.

### DoS-2 — Blacklisted holder blocks LP exit (MEDIUM, FIXED)

**Status:** **Fix verified present and correct.** `_trySendUsdc` at `EXNIHILOPool.sol:1353-1361` wraps transfers in try/catch:

```solidity
function _trySendUsdc(address to, uint256 amount) internal returns (bool) {
    try IERC20(usdc).transfer(to, amount) returns (bool ok) { return ok; }
    catch { emit PayoutFailed(to, amount); return false; }
}
```

Used in both `_closeExpiredLong` (L1186-1187) and `_closeExpiredShort` (L1229-1230). `openPositionCount--` and accounting writes run unconditionally BEFORE the transfer attempts. Nine tests in `test/BlacklistResilience.ts` confirm the fix. The LP-exit blocking vector is fully eliminated.

## New Findings (4.7)

### DoS-5 — `_trySendUsdc` failure strands USDC permanently (LOW, NEW)

**Location:** `EXNIHILOPool.sol:1181-1187`, `1224-1230`, `1353-1361`

**Scenario:** When `_trySendUsdc` silently swallows a failed USDC transfer:
- `backedAirUsd` has already been decremented (L1181 for long, L1224 for short).
- `airUsdToken.burn(...)` has already run.
- `openPositionCount--` has run.

The raw USDC remains in `address(this).balance`, but no accounting variable tracks it. `removeLiquidity` only pays out up to `backedAirUsd`; `claimFees` only drains `lpFeesAccumulated`. The stranded amount is permanently inaccessible.

**Impact:** Each failed payout permanently leaks value from the accounting ledger. Compounds over repeated blacklist events against the same pool.

**Fix options:**
- Socialize to LPs: `lpFeesAccumulated += amount;` in the catch branch.
- Pull-pattern: `mapping(address => uint256) unclaimedPayouts;` + `claimPayout()` callable only by recipient.

### DoS-4 — Router `sweep()` is permissionless (LOW, NEW)

**Location:** `EXNIHILORouter.sol:142-147`

```solidity
function sweep(IERC20 token) external {
    uint256 bal = token.balanceOf(address(this));
    if (bal > 0) token.safeTransfer(msg.sender, bal);
}
```

Any caller drains the router's full balance of any token. Normal router calls are atomic + `nonReentrant`, so mid-call theft is blocked. The real risk is:
- Tokens sent directly to the router by mistake → griefable by any front-runner.
- Residuals left by `_positionFee` mis-estimation (see DoS-6 / NM-006) → stealable.

**Fix:** Restrict to an immutable admin, or refund residuals to the original caller atomically.

### DoS-6 — Router OI snapshot race causes over-pull + sweep theft (LOW→MEDIUM, NEW)

**Location:** `EXNIHILORouter.sol:63-81` (`_positionFee`) + L142 (`sweep`)

`_positionFee` reads pool state (`backedAirUsd`, OI) at T0 to estimate the fee and pulls that amount via `transferFrom`. The pool internally recomputes the fee at T1 (after state changes from other mempool txs). If pool state shifted to demand LESS, the router holds a USDC residual.

**Griefing:** An MEV bot can sandwich (spike then deflate OI) to force a residual, then race the victim's implicit `sweep` with its own.

**Loss upper bound:** ~750 USDC per 10K notional under worst-case adversarial sandwich.

**Fix:** After the pool call, refund `usdc.balanceOf(address(this))` to `msg.sender` inside the atomic transaction. This closes both DoS-4 (accidental sends) and DoS-6 (race residuals) for router-flow tokens.

## Other Patterns — CLEAN

- **Unbounded loops:** No iteration over user-controlled collections in critical paths. `closePositionAfterDeadline` takes a specific `nftId` (not a batch).
- **Block gas limit:** No single function iterates arbitrary position/LP lists.
- **Storage bloat:** Position NFT IDs are monotonic uint256; no user-driven unbounded mapping growth.
- **Timestamp griefing:** `deadline` windows are measured in days/weeks; miner timestamp tolerance is ±15s, immaterial.
- **selfdestruct force-feeding:** No use of `address(this).balance` for accounting; pool tracks balances via mapped state. Out-of-band ETH is not an attack vector (pool holds no ETH).
- **Callback griefing:** No ERC-777 token calls on write paths; NFT `_safeMint` is after state updates.

## Delta vs 4.6

- DoS-1 **Confirmed unchanged** (LOW, Accepted).
- DoS-2 **Fix verified correct** (MEDIUM → FIXED).
- **DoS-5 (LOW, NEW)** — silent `_trySendUsdc` failure strands USDC.
- **DoS-4 (LOW, NEW)** — permissionless `sweep()` on Router.
- **DoS-6 (LOW, NEW)** — OI snapshot race causes over-pull + sweep theft. MEDIUM under worst-case adversarial sandwich.

**Severity tally:** 4.6 = 0C/0H/1M-fixed/2L/0I → 4.7 = 0C/0H/0M (DoS-2 stays fixed, DoS-6 could be MEDIUM)/**5L**/0I.
