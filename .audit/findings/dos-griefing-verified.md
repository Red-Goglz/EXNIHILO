# DoS & Griefing Analysis Report — EXNIHILO

## Scope

- **Contracts:** EXNIHILOPool, PositionNFT, EXNIHILOFactory, EXNIHILORouter, LpNFT, AirToken
- **Excluded:** Faucet.sol (testnet-only), test/ directory helpers

---

## Quick Detection Checklist

- [x] Do any loops iterate over arrays that grow with contract usage? **No loops in core contracts.** `allPools` array in Factory grows but is never iterated on-chain.
- [x] Do batch operations handle individual failures gracefully? **No batch operations exist.** All operations are single-item.
- [x] Do relayer/meta-tx functions verify gas sufficiency and call success? **No relayer/meta-tx pattern.** No `gasleft()`, no delegatecall.
- [x] Do growing storage structures have maximum size limits? See Class 4 analysis below.
- [x] Can timing mechanisms (locks, cooldowns) be reset at minimal cost? See Class 5 analysis below.
- [x] Does any logic use `address(this).balance` in a strict equality check? **Only in Faucet (testnet, out of scope).** Pool uses internal accounting (`backedAirUsd`, `backedAirToken`) — never `address(this).balance`.
- [x] Are time-sensitive operations given reasonable execution windows? See Class 7 analysis below.
- [x] Do payment distributions use pull pattern instead of push? Fees use pull pattern (`claimFees`). Position payouts are push but single-recipient (no batch). See Class 2 analysis.

---

## Class 1: Unbounded Loop DoS

### Analysis

**No `for` loops exist in any core contract** (EXNIHILOPool, PositionNFT, EXNIHILOFactory, EXNIHILORouter, LpNFT, AirToken). Confirmed via grep for `for\s*\(` — zero matches in non-test contracts.

The `allPools` array in EXNIHILOFactory grows without bound but:
- Is never iterated on-chain
- Only accessed by index (`allPools[i]`) or length (`allPoolsLength()`)
- No function loops over it

The `_nextTokenId` counters in PositionNFT and LpNFT are sequential IDs, not iterated.

ERC721Enumerable (inherited by PositionNFT) stores `_allTokens` array and `_ownedTokens` mapping internally, but these are only accessed by index in `tokenByIndex()` and `tokenOfOwnerByIndex()` view functions — not iterated in any state-changing function.

**Result: NO UNBOUNDED LOOP DOS VECTORS FOUND.**

---

## Class 2: External Call Failure DoS

### Analysis

All state-changing functions in EXNIHILOPool make external calls to:
1. `IERC20.safeTransferFrom` / `IERC20.safeTransfer` (token transfers)
2. `IAirToken.mint` / `IAirToken.burn` (wrapper token management)
3. `IPositionNFT.mintLong` / `mintShort` / `release` / `extendDeadline`
4. `ILpNFT.ownerOf` (ownership check)

**Key question:** Can any single external call failure permanently DoS a critical function?

| Function | External Calls | Can Fail? | Impact if Fails |
|----------|---------------|-----------|-----------------|
| `openLong` | `_transferIn(usdc)`, `safeTransfer(treasury)`, `positionNFT.mintLong` | Yes (if user lacks USDC approval) | Only this tx reverts — no global DoS |
| `closeLong` | `positionNFT.release`, `airUsd.burn×2`, `safeTransfer(holder)`, `safeTransfer(treasury)` | Holder USDC blacklisted → transfer fails | **Only this position** blocked — no global DoS |
| `closeShort` | Same pattern as closeLong | Same | Same |
| `closePositionAfterDeadline` | Same as close* | Same | Same |
| `swap` | `_transferIn`, `airToken/airUsd mint/burn`, `safeTransfer` | Recipient blacklisted | Only this swap reverts |
| `claimFees` | `safeTransfer(msg.sender)` | LP holder USDC blacklisted | LP can't claim fees but pool operates normally |
| `removeLiquidity` | `airToken/airUsd.burn`, `safeTransfer×2` | LP holder USDC/token blacklisted | LP can't withdraw but pool operates normally |
| `addLiquidity` | `_transferIn×2`, `airToken/airUsd.mint` | Insufficient approval | Only this tx reverts |
| `renewPosition` | `_transferIn`, `safeTransfer(treasury)`, `extendDeadline` | Caller lacks USDC | Only this tx reverts |

**Critical check — can a blacklisted `protocolTreasury` DoS the entire protocol?**

`protocolTreasury` is an immutable address set at pool construction. If this address is USDC-blacklisted:
- `openLong`: `underlyingUsdc.safeTransfer(protocolTreasury, protocolFee)` reverts → **ALL long opens blocked**
- `openShort`: Same → **ALL short opens blocked**
- `closeLong` (profitable): `underlyingUsdc.safeTransfer(protocolTreasury, closeFee)` reverts → **ALL profitable long closes blocked**
- `closeShort` (profitable): Same → **ALL profitable short closes blocked**
- `renewPosition`: `underlyingUsdc.safeTransfer(protocolTreasury, protocolFee)` reverts → **ALL renewals blocked**

However: `protocolTreasury` is set by the trusted factory deployer and is immutable per pool. If it were blacklisted, the deployer would deploy new pools with a clean treasury. Existing pool positions could still be closed underwater (no treasury transfer in underwater path) and realized (no treasury transfer). This is a trusted-setup concern, not an attacker-controlled DoS vector.

### Finding: DoS-1 — Blacklisted protocolTreasury blocks pool operations

**Function:** Multiple — `openLong()`, `openShort()`, `closeLong()`, `closeShort()`, `renewPosition()`
**Category:** External Call DoS
**Severity:** LOW (trusted setup — treasury is set by deployer, immutable)

**Issue:**
If `protocolTreasury` is USDC-blacklisted (e.g., OFAC sanctions on Circle's blacklist), all position opens, profitable closes, and renewals revert because `underlyingUsdc.safeTransfer(protocolTreasury, ...)` fails. The pool becomes partially inoperable.

**Surviving operations:** Underwater position liquidation via `closePositionAfterDeadline`, `realizeLong`, `realizeShort`, `swap`, `removeLiquidity`, `claimFees`.

**Cost to Attacker:** N/A — requires USDC issuer action on the treasury address, not attacker-controlled.

**Impact:** Pool cannot open new positions or close profitable ones. Existing positions can still be realized or liquidated after expiry.

**Recommendation:**
Consider using a pull pattern for protocol fees: accumulate fees in pool storage (like `lpFeesAccumulated`) and let the treasury claim them. This removes the treasury `safeTransfer` from the critical path.

```solidity
// Current (push):
underlyingUsdc.safeTransfer(protocolTreasury, protocolFee);

// Recommended (pull):
protocolFeesAccumulated += protocolFee;
// Separate function:
function claimProtocolFees() external {
    uint256 amount = protocolFeesAccumulated;
    protocolFeesAccumulated = 0;
    underlyingUsdc.safeTransfer(protocolTreasury, amount);
}
```

---

**Check — can a blacklisted position holder block the LP?**

If a position holder's address is USDC-blacklisted:
- `closeLong`/`closeShort`: called by holder themselves (`msg.sender == ownerOf(nftId)`). If they can't receive USDC, they can't close profitably.
- `closePositionAfterDeadline`: called by anyone, but `safeTransfer(holder, netSurplus)` sends to the original holder. If holder is blacklisted → profitable close reverts.

But: **underwater** close path doesn't transfer USDC to holder — it just returns collateral to LP. So after expiry, if the position is underwater, anyone can close it and clean it up. If it's profitable, the blacklisted holder blocks their own payout but...

Can the LP ever remove liquidity if a profitable expired position can't be closed due to holder blacklist? The LP needs `openPositionCount == 0`. If one position can't be closed, `openPositionCount` stays > 0 forever.

### Finding: DoS-2 — Blacklisted position holder blocks LP exit

**Function:** `closePositionAfterDeadline()` at `EXNIHILOPool.sol:L1037`
**Category:** External Call DoS
**Severity:** MEDIUM

**Issue:**
If a position holder's address is USDC-blacklisted and their expired position is profitable, `closePositionAfterDeadline` reverts on `underlyingUsdc.safeTransfer(holder, netSurplus)`. The position cannot be closed, `openPositionCount` never reaches 0, and the LP can never call `removeLiquidity`.

**Attack Scenario:**
1. Attacker opens a long/short position from an address they control.
2. Attacker gets their address USDC-blacklisted (or uses a known-blacklisted address with some USDC).
3. Position becomes profitable and expires.
4. No one can close it — profitable path transfers USDC to blacklisted holder and reverts.
5. `openPositionCount` is stuck > 0 permanently.
6. LP can never call `removeLiquidity`.

**Practical limitation:** Getting a specific address USDC-blacklisted requires OFAC/Circle action — not trivially attacker-controlled. But if it happens naturally (e.g., address sanctioned after opening a position), the impact is real.

**Growth Analysis:** N/A — this is not a growth-based DoS.

**Cost to Attacker:** Not attacker-controllable in the general case. If attacker already has a blacklisted address: cost = position fee (5% of notional).

**Impact on Victims:** LP's liquidity is permanently locked. LP cannot withdraw even after pool closure. The pool's underlying tokens and USDC are trapped forever.

**Recommendation:**
Add an escape hatch in the profitable expired-position close path. If the USDC transfer to the holder fails, escrow the funds:

```solidity
// In _closeExpiredLong (profitable path), replace:
underlyingUsdc.safeTransfer(holder, netSurplus);

// With:
try IERC20(underlyingUsdc).transfer(holder, netSurplus) returns (bool success) {
    if (!success) {
        unclaimedPayouts[holder] += netSurplus;
    }
} catch {
    unclaimedPayouts[holder] += netSurplus;
}
```

Or simpler: add a force-close function that routes the holder's payout to escrow, callable only by the LP after pool closure + grace period.

---

## Class 3: Insufficient Gas Griefing (63/64 Rule)

### Analysis

No relayer/meta-tx pattern exists. No `gasleft()` usage. No raw `.call()` in core contracts (only in Faucet, out of scope). All external calls use SafeERC20 (`safeTransfer`, `safeTransferFrom`) which revert on failure — no unchecked low-level calls that could silently fail.

The `positionNFT.mintLong/mintShort` → `_safeMint` → `onERC721Received` callback is protected by `nonReentrant` on the pool. Even if the callback runs out of gas, the entire transaction reverts (no partial state change).

**Result: NO INSUFFICIENT GAS GRIEFING VECTORS FOUND.**

---

## Class 4: Storage Bloat Attack

### Analysis

**Growing storage structures:**

| Structure | Contract | Growth Mechanism | Iterated? | Limit? |
|-----------|----------|-----------------|-----------|--------|
| `allPools[]` | Factory | `createMarket` (push) | Never | No limit, but each creation costs significant gas (deploys 3 contracts) |
| `_positions` mapping | PositionNFT | `mintLong/mintShort` | Never (indexed by ID) | No explicit limit, but each position costs 5% fee |
| `_nextTokenId` | PositionNFT | Increments on mint | N/A (counter) | uint256 — effectively unlimited |
| `_nextTokenId` | LpNFT | Increments on mint | N/A (counter) | uint256 |
| `isPool` mapping | Factory | Set on `createMarket` | Never | No limit |
| ERC721Enumerable internals | PositionNFT | `_safeMint` / `_burn` | Via `tokenByIndex` (view) | No |

**Key question:** Can storage growth make any state-changing function more expensive?

- `allPools.push` is O(1) — constant gas regardless of array size. ✓
- Position mint/release operates on a single mapping slot — O(1). ✓
- No function iterates over positions or pools. ✓
- ERC721Enumerable's `_allTokens` array grows, but `_safeMint` and `_burn` are O(1) amortized. ✓

**Can an attacker bloat storage to grief others?**

Opening many positions requires paying 5% fees per position — economically self-limiting. Each position creates a fixed number of storage slots (one Position struct). No function's gas cost scales with the total number of positions.

**Result: NO STORAGE BLOAT DOS VECTORS FOUND.**

---

## Class 5: Timestamp Griefing

### Analysis

**Timestamp-dependent mechanisms:**

| Mechanism | Location | Reset Cost | Can Others Reset? |
|-----------|----------|-----------|-------------------|
| Position deadline | `openLong/openShort` sets `block.timestamp + positionDuration` | 5% fee via `renewPosition` | Yes — anyone can renew |
| Pool closeDate | `closePool` sets `block.timestamp + positionDuration` | One-time, irreversible | No — once set, can't be changed |

**Position deadline reset via renewPosition:**

Already identified in Nemesis NM-004. Anyone can call `renewPosition(nftId)` and pay the 5% base fee to extend a position's deadline. This delays the position's expiry, which delays the LP's ability to clean up positions for `removeLiquidity`.

**Mitigation already present:** `closePool()` sets a hard `closeDate`. After closeDate, renewals that extend past it are blocked. All positions are guaranteed to expire by closeDate.

**Is the 5% cost sufficiently deterrent?**

For a 100,000 USDC notional position: renewal fee = 5,000 USDC per period (e.g., per week). To grief for 1 month = 4 × 5,000 = 20,000 USDC. This is expensive griefing. And the LP can call `closePool()` at any time to start the countdown.

### Finding: DoS-3 — Position renewal griefing (= Nemesis NM-004)

**Function:** `renewPosition()` at `EXNIHILOPool.sol:L989`
**Category:** Timestamp Griefing
**Severity:** LOW

**Issue:**
Anyone can extend any position's deadline by paying 5% of notional, delaying the LP's ability to reach `openPositionCount == 0` for `removeLiquidity`.

**Cost to Attacker:** 5% of position notional per `positionDuration` period (e.g., 5,000 USDC/week for 100K notional).
**Impact on Victims:** LP exit delayed until attacker stops paying or `closePool` + `closeDate` expires.
**Mitigation:** `closePool()` fully counters this attack.

**Recommendation:** No code change needed. The `closePool` mechanism is sufficient. Document this as a known design tradeoff.

---

## Class 6: Self-Destruct / Force-Feeding

### Analysis

**`address(this).balance` usage in core contracts:** None. All financial accounting uses internal state variables (`backedAirUsd`, `backedAirToken`, `lpFeesAccumulated`). The pool never reads its own ETH balance.

USDC and underlying token balances are tracked via `_transferIn`'s balance-before/after check for incoming transfers and state variable accounting for outgoing. Force-feeding ETH to the pool has zero impact because:
1. No function reads `address(this).balance`
2. No function uses strict equality on any balance
3. No `receive()` or `fallback()` in EXNIHILOPool — ETH sent directly would revert

**Faucet.sol** (out of scope) uses `address(this).balance` but with `>` not `==`, and has a cap (`min(avaxAmount, balance)`). Not vulnerable to force-feed DoS.

**Result: NO FORCE-FEEDING VECTORS FOUND.**

---

## Class 7: Block Stuffing

### Analysis

**Time-sensitive operations:**

| Operation | Time Window | Upper Bound? | Stuffing Risk |
|-----------|------------|-------------|---------------|
| `closePositionAfterDeadline` | `block.timestamp >= pos.deadline` | **No upper bound** — can be called anytime after deadline | SAFE |
| `closePool` | No time constraint | Irreversible, callable anytime | SAFE |
| `renewPosition` | No time constraint (can renew before or after expiry) | Renewal from current deadline or now, whichever is later | SAFE |
| `closeLong/closeShort` | No time constraint (callable anytime while position exists) | N/A | SAFE |

No operation has a narrow time window that expires. `closePositionAfterDeadline` has a lower bound (must be after deadline) but **no upper bound** — positions can be closed at any time after expiry. Block stuffing cannot prevent this permanently.

**Result: NO BLOCK STUFFING VECTORS FOUND.**

---

## Summary

| Class | Findings | Severity |
|-------|----------|----------|
| 1. Unbounded Loop DoS | None | — |
| 2. External Call Failure DoS | **DoS-1**: Blacklisted treasury blocks opens/closes (LOW) | LOW |
| | **DoS-2**: Blacklisted holder blocks LP exit (MEDIUM) | **MEDIUM** |
| 3. Insufficient Gas Griefing | None | — |
| 4. Storage Bloat Attack | None | — |
| 5. Timestamp Griefing | **DoS-3**: Position renewal griefing (LOW, = NM-004) | LOW |
| 6. Self-Destruct Force-Feeding | None | — |
| 7. Block Stuffing | None | — |

```
Final: 0 CRITICAL | 0 HIGH | 1 MEDIUM | 2 LOW
```

### New Finding Not in Previous Audits

**DoS-2 (MEDIUM)** is a new finding not identified by the Nemesis or BSA audits. A USDC-blacklisted position holder with an expired profitable position permanently blocks `removeLiquidity` for the LP, because `closePositionAfterDeadline` reverts on the USDC transfer to the holder. The underwater path succeeds (no holder transfer), but if the position is profitable, the LP is stuck.

**Recommended fix priority:**
1. **DoS-2 (MEDIUM):** Add escrow/fallback for holder payouts in the expired position close path.
2. **DoS-1 (LOW):** Consider pull pattern for protocol fees (optional hardening).
3. **DoS-3 (LOW):** Already mitigated by `closePool()`. No code change needed.
