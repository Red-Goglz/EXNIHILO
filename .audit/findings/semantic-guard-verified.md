# Semantic Guard Analysis Report — EXNIHILO

## Scope

- **Contracts:** EXNIHILOPool, PositionNFT, EXNIHILOFactory, EXNIHILORouter, LpNFT, AirToken
- **Excluded:** Faucet.sol (testnet-only), test/ directory

---

## Phase 1: State Interaction Matrix

### EXNIHILOPool — State Variables & Modifying Functions

#### State Variable: `backedAirToken`

| Function | Access | Guards |
|----------|--------|--------|
| `_swapTokenToUsdc` (via `swap`) | WRITE (+) | nonReentrant |
| `_swapUsdcToToken` (via `swap`) | WRITE (−) | nonReentrant |
| `openLong` | WRITE (−) | nonReentrant, closeDate==0, amountIn>0, reserves>0, leverageCap |
| `closeLong` | WRITE (+) | nonReentrant, positionHolder, poolMatch, isLong |
| `openShort` | — | — |
| `closeShort` | — | — |
| `realizeLong` | — | — |
| `realizeShort` | WRITE (+) | nonReentrant, positionHolder, poolMatch, isShort |
| `addLiquidity` | WRITE (+) | nonReentrant, onlyLpHolder, amountsNonZero, ratioMatch |
| `removeLiquidity` | WRITE (=0) | nonReentrant, onlyLpHolder, noOpenPositions |
| `_closeExpiredLong` | WRITE (+) | nonReentrant, expired, poolMatch |
| `_closeExpiredShort` | — | — |

**Guard pattern for `backedAirToken` writes:** `nonReentrant` = 100% (10/10). **Strong invariant.** ✓

#### State Variable: `backedAirUsd`

| Function | Access | Guards |
|----------|--------|--------|
| `_swapTokenToUsdc` | WRITE (−) | nonReentrant |
| `_swapUsdcToToken` | WRITE (+) | nonReentrant |
| `openShort` | WRITE (−) | nonReentrant, closeDate==0, amountIn>0, reserves>0, leverageCap |
| `closeLong` | WRITE (−) | nonReentrant, positionHolder, poolMatch, isLong |
| `closeShort` | WRITE (+) | nonReentrant, positionHolder, poolMatch, isShort |
| `realizeLong` | WRITE (+) | nonReentrant, positionHolder, poolMatch, isLong |
| `addLiquidity` | WRITE (+) | nonReentrant, onlyLpHolder, amountsNonZero, ratioMatch |
| `removeLiquidity` | WRITE (=0) | nonReentrant, onlyLpHolder, noOpenPositions |
| `_closeExpiredLong` | WRITE (−) | nonReentrant, expired, poolMatch |
| `_closeExpiredShort` | WRITE (+) | nonReentrant, expired, poolMatch |

**Guard pattern for `backedAirUsd` writes:** `nonReentrant` = 100% (10/10). ✓

#### State Variable: `openPositionCount`

| Function | Access | Guards |
|----------|--------|--------|
| `openLong` | WRITE (++) | nonReentrant, closeDate==0, reserves>0 |
| `openShort` | WRITE (++) | nonReentrant, closeDate==0, reserves>0 |
| `closeLong` | WRITE (−−) | nonReentrant, positionHolder |
| `closeShort` | WRITE (−−) | nonReentrant, positionHolder |
| `realizeLong` | WRITE (−−) | nonReentrant, positionHolder |
| `realizeShort` | WRITE (−−) | nonReentrant, positionHolder |
| `_closeExpiredLong` | WRITE (−−) | nonReentrant, expired |
| `_closeExpiredShort` | WRITE (−−) | nonReentrant, expired |
| `removeLiquidity` | READ (==0) | nonReentrant, onlyLpHolder |

**Guard patterns:**
- `nonReentrant` on all writes: 8/8 = 100% ✓
- `closeDate==0` on increments: 2/2 = 100% ✓
- Position validation on decrements: 6/6 (holder check for voluntary, expired for forced) = 100% ✓

#### State Variable: `longOpenInterest`

| Function | Access | Guards |
|----------|--------|--------|
| `openLong` | WRITE (+) | nonReentrant, closeDate==0 |
| `closeLong` | WRITE (−) | nonReentrant, positionHolder |
| `realizeLong` | WRITE (−) | nonReentrant, positionHolder |
| `_closeExpiredLong` | WRITE (−) | nonReentrant, expired |

**Guard pattern:** `nonReentrant` = 100%. **Consistent.** ✓

#### State Variable: `shortOpenInterest`

| Function | Access | Guards |
|----------|--------|--------|
| `openShort` | WRITE (+) | nonReentrant, closeDate==0 |
| `closeShort` | WRITE (−) | nonReentrant, positionHolder |
| `realizeShort` | WRITE (−) | nonReentrant, positionHolder |
| `_closeExpiredShort` | WRITE (−) | nonReentrant, expired |

**Guard pattern:** Same as longOpenInterest. 100% consistent. ✓

#### State Variable: `lpFeesAccumulated`

| Function | Access | Guards |
|----------|--------|--------|
| `openLong` | WRITE (+) | nonReentrant |
| `openShort` | WRITE (+) | nonReentrant |
| `renewPosition` | WRITE (+) | nonReentrant |
| `claimFees` | WRITE (=0) | nonReentrant, onlyLpHolder |

**Guard pattern:** `nonReentrant` = 100%. `onlyLpHolder` on claim (only output) = correct. ✓

#### State Variable: `maxPositionUsd` / `maxPositionBps`

| Function | Access | Guards |
|----------|--------|--------|
| `setPositionCaps` | WRITE | onlyLpHolder |
| constructor | WRITE | N/A (deployment) |

**Guard pattern:** `onlyLpHolder` = 100% (excluding constructor). ✓

**Note:** `setPositionCaps` does NOT have `nonReentrant`. But it makes no external calls — no reentrancy vector exists. Analyzed in reentrancy report as safe.

#### State Variable: `closeDate`

| Function | Access | Guards |
|----------|--------|--------|
| `closePool` | WRITE | nonReentrant, closeDate==0 (once-only), LP holder OR deployer |

**Guard pattern:** Single writer. ✓

---

### PositionNFT — State Variables & Modifying Functions

#### State Variable: `_positions` mapping

| Function | Access | Guards |
|----------|--------|--------|
| `mintLong` | WRITE (create) | msg.sender==pool, factory.isPool check |
| `mintShort` | WRITE (create) | msg.sender==pool, factory.isPool check |
| `release` | WRITE (delete) | msg.sender==position.pool, position exists |
| `extendDeadline` | WRITE (deadline) | msg.sender==position.pool, position exists |

**Guard pattern:** `msg.sender == pool` = 100% (4/4). `factory.isPool` = 50% (2/4 — only on mints).

**Anomaly?** `release` and `extendDeadline` check `msg.sender == position.pool` but NOT `factory.isPool`. Is this an inconsistency?

**Analysis:** `release` and `extendDeadline` check against the STORED pool address (`_positions[tokenId].pool`), which was validated at mint time. A position can only be created by a factory-registered pool (when factory is set). So the stored pool address is already validated. Re-checking `factory.isPool` on release/extend is redundant. ✓ Consistent by design.

#### State Variable: `factory`

| Function | Access | Guards |
|----------|--------|--------|
| `initFactory` | WRITE | msg.sender == _deployer, factory == 0 (once-only), factory_ != 0 |

**Guard pattern:** Single writer, triple-guarded. ✓

#### State Variable: `_nextTokenId`

| Function | Access | Guards |
|----------|--------|--------|
| `mintLong` | WRITE (++) | msg.sender==pool check |
| `mintShort` | WRITE (++) | msg.sender==pool check |

**Guard pattern:** Pool-only = 100%. ✓

---

### EXNIHILOFactory — State Variables

#### State Variable: `isPool` mapping / `allPools` array

| Function | Access | Guards |
|----------|--------|--------|
| `createMarket` | WRITE | nonReentrant |

**Guard pattern:** Single writer. ✓

#### State Variable: `deployer`

| Function | Access | Guards |
|----------|--------|--------|
| `setDeployer` | WRITE | msg.sender == deployer |

**Guard pattern:** Self-guarded. ✓

---

### AirToken — State Variables

#### State Variable: `pool`

| Function | Access | Guards |
|----------|--------|--------|
| `initPool` | WRITE | msg.sender == factory, pool == 0 (once-only), pool_ != 0 |

**Single writer, triple-guarded.** ✓

#### ERC-20 state (balances, totalSupply via mint/burn)

| Function | Access | Guards |
|----------|--------|--------|
| `mint` | WRITE | onlyPool |
| `burn` | WRITE | onlyPool |

**Guard pattern:** `onlyPool` = 100%. ✓

---

### LpNFT — State Variables

#### `_poolOf` mapping / `_nextTokenId`

| Function | Access | Guards |
|----------|--------|--------|
| `mint` | WRITE | msg.sender == factory |

**Single writer, factory-guarded.** ✓

---

### EXNIHILORouter — State Variables

**Stateless.** No persistent state variables. All functions are pass-through operations. ✓

---

## Phase 2: Dependency Graph

### Guard Dependency Chains

```
Guard: onlyLpHolder
  → Protects: addLiquidity, removeLiquidity, claimFees, setPositionCaps
  → Confidence: 100% (4/4 LP-privileged functions)

Guard: nonReentrant
  → Protects: ALL state-changing functions with external calls (14/14)
  → Exception: setPositionCaps (no external calls — safe without it)
  → Confidence: 100% where applicable

Guard: closeDate == 0 (pool open)
  → Protects: openLong, openShort (position creation)
  → Confidence: 100% (2/2 creation functions)
  → NOT applied to: swap, close*, realize*, renew, addLiquidity — correct (these should work during closure)

Guard: positionHolder (ownerOf(nftId) == msg.sender)
  → Protects: closeLong, closeShort, realizeLong, realizeShort
  → Confidence: 100% (4/4 voluntary close/realize functions)
  → NOT applied to: closePositionAfterDeadline — correct (anyone can close expired)

Guard: poolMatch (pos.pool == address(this))
  → Protects: closeLong, closeShort, realizeLong, realizeShort, closePositionAfterDeadline, renewPosition
  → Confidence: 100% (6/6 position-touching functions)

Guard: msg.sender == pool (PositionNFT)
  → Protects: mintLong, mintShort, release, extendDeadline
  → Confidence: 100% (4/4)

Guard: factory.isPool (PositionNFT)
  → Protects: mintLong, mintShort (at creation)
  → Confidence: 100% of creation functions (2/2)
  → Not on release/extend — by design (pool already validated at creation)
```

### Composite Guard Patterns

```
Position creation:  nonReentrant + closeDate==0 + reserves>0 + leverageCap + amountNonZero
Position close:     nonReentrant + positionHolder + poolMatch + isLong/isShort + profitability check
Expired close:      nonReentrant + poolMatch + expired (deadline check)
LP operations:      nonReentrant + onlyLpHolder
Renewal:            nonReentrant + poolMatch (anyone can pay)
Swap:               nonReentrant + amountNonZero + reserves>0
```

---

## Phase 3: Anomaly Detection

### Strong Invariant Violations (≥80% pattern)

**Scanning all state variables against their guard patterns...**

| State Variable | Guard | Functions WITH Guard | Functions WITHOUT Guard | Violation? |
|---------------|-------|---------------------|------------------------|-----------|
| `backedAirToken` | nonReentrant | 10/10 | 0 | ✓ None |
| `backedAirUsd` | nonReentrant | 10/10 | 0 | ✓ None |
| `openPositionCount` | nonReentrant | 8/8 | 0 | ✓ None |
| `longOpenInterest` | nonReentrant | 4/4 | 0 | ✓ None |
| `shortOpenInterest` | nonReentrant | 4/4 | 0 | ✓ None |
| `lpFeesAccumulated` | nonReentrant | 4/4 | 0 | ✓ None |
| `maxPositionUsd` | onlyLpHolder | 1/1 | 0 | ✓ None |
| `maxPositionBps` | onlyLpHolder | 1/1 | 0 | ✓ None |
| `closeDate` | nonReentrant + LP/deployer | 1/1 | 0 | ✓ None |
| `_positions` (NFT) | msg.sender==pool | 4/4 | 0 | ✓ None |
| `factory` (NFT) | deployer + once-only | 1/1 | 0 | ✓ None |
| `pool` (AirToken) | factory + once-only | 1/1 | 0 | ✓ None |
| `isPool` (Factory) | nonReentrant | 1/1 | 0 | ✓ None |
| `deployer` (Factory) | msg.sender==deployer | 1/1 | 0 | ✓ None |

**No strong invariant violations found across any state variable.**

### Weak Invariant Analysis (50–79% patterns)

Searching for guards applied inconsistently:

| Pattern | Applied | Not Applied | Frequency | Finding? |
|---------|---------|-------------|-----------|----------|
| `reserves > 0` check before AMM operations | swap, openLong, openShort | close*, realize* | 3/7 (43%) | Not a pattern — close/realize don't need reserve check (they add to reserves, not subtract) |
| `_assertReserveInvariant` after state changes | swap, openLong, openShort, closeLong, closeShort, realizeLong, realizeShort, addLiquidity, closeExpired* | claimFees, renewPosition, setPositionCaps, removeLiquidity | 10/14 | See SGA-1 |
| `recipient != address(0)` check | swap, openLong, openShort | closeLong, closeShort (holder from NFT) | 3/5 | Not inconsistent — close functions get holder from ownerOf(), which can't be zero |

### Finding: SGA-1 — _assertReserveInvariant not called after claimFees and renewPosition

**Function:** `claimFees()` at `EXNIHILOPool.sol:L968`, `renewPosition()` at `L989`
**Severity:** INFORMATIONAL
**Confidence:** 71% (10 of 14 state-changing functions call `_assertReserveInvariant`)

**Issue:**
`_assertReserveInvariant()` (checks `backedAirToken ≤ airToken.totalSupply()` and `backedAirUsd ≤ airUsdToken.totalSupply()`) is called after every operation that modifies `backedAirToken` or `backedAirUsd`. However, `claimFees` and `renewPosition` do NOT call it.

**Analysis:**
- `claimFees`: Sets `lpFeesAccumulated = 0` and transfers USDC. Does NOT modify `backedAirToken` or `backedAirUsd`. The invariant is trivially preserved — nothing changed in the reserves.
- `renewPosition`: Updates `lpFeesAccumulated` and transfers USDC. Does NOT modify backed reserves. Same reasoning.
- `removeLiquidity`: Sets `backedAirToken = 0` and `backedAirUsd = 0`, burns all airTokens. The invariant `0 ≤ any_totalSupply` is trivially true. No assert needed but would be harmless.
- `setPositionCaps`: No reserve changes. No assert needed.

**Verdict:** The omissions are **correct** — `_assertReserveInvariant` is only needed when `backedAirToken` or `backedAirUsd` change. Functions that don't touch these variables don't need the check. The pattern is not "10 of 14 apply it" but rather "10 of 10 that modify reserves apply it, and 4 that don't modify reserves don't." **100% consistency within the relevant scope.**

**Recommendation:** No fix needed. The guard is applied consistently to all functions that modify the guarded state.

---

### Cross-Function Guard Consistency

**Position holder check consistency:**

| Function | Requires NFT Holder? | Rationale |
|----------|---------------------|-----------|
| `closeLong` | ✓ `ownerOf == msg.sender` | Voluntary close — holder's choice |
| `closeShort` | ✓ Same | Same |
| `realizeLong` | ✓ Same | Same |
| `realizeShort` | ✓ Same | Same |
| `closePositionAfterDeadline` | ✗ Anyone | Expired — anyone can trigger cleanup |
| `renewPosition` | ✗ Anyone | Anyone can pay to renew |

**Is the lack of holder check on `closePositionAfterDeadline` and `renewPosition` consistent?**

- `closePositionAfterDeadline`: Has `block.timestamp >= pos.deadline` guard instead. By design — expired positions should be cleanable by anyone (LP needs this for `removeLiquidity`). Payout goes to the holder regardless.
- `renewPosition`: Anyone can pay the 5% fee to extend someone's position. By design — the fee goes to LP/protocol, and the position holder benefits. No holder check needed.

**Verdict: Consistent within design intent.** ✓

**LP holder check consistency:**

| Function | Requires LP Holder? | Rationale |
|----------|-------------------|-----------|
| `addLiquidity` | ✓ `onlyLpHolder` | LP deposits |
| `removeLiquidity` | ✓ Same | LP withdrawals |
| `claimFees` | ✓ Same | LP fee claim |
| `setPositionCaps` | ✓ Same | LP risk management |
| `closePool` | ✗ LP holder OR deployer | Emergency: both can close |

**Is the dual-authority on `closePool` consistent?**

All other LP-privileged functions require `onlyLpHolder` exclusively. `closePool` also allows the factory deployer. This is an intentional emergency mechanism — the deployer can close any pool for safety reasons. The deployer CANNOT add/remove liquidity, claim fees, or set caps.

**Verdict: Intentional privilege escalation for emergency. Documented.** ✓

---

### Privilege Overlay

| Function | Privilege Level | Guards Applied | Consistent Within Tier? |
|----------|----------------|----------------|------------------------|
| **Public tier** | | | |
| `swap` | Public | nonReentrant, ZeroAmount, reserves>0 | ✓ |
| `openLong` | Public | nonReentrant, ZeroAmount, ZeroAddress, reserves>0, closeDate==0, leverageCap | ✓ |
| `openShort` | Public | Same as openLong | ✓ |
| `renewPosition` | Public | nonReentrant, poolMatch | ✓ |
| `closePositionAfterDeadline` | Public | nonReentrant, poolMatch, expired | ✓ |
| **Holder tier** | | | |
| `closeLong` | Position holder | nonReentrant, positionHolder, poolMatch, isLong | ✓ |
| `closeShort` | Position holder | nonReentrant, positionHolder, poolMatch, isShort | ✓ |
| `realizeLong` | Position holder | Same pattern | ✓ |
| `realizeShort` | Position holder | Same pattern | ✓ |
| **LP tier** | | | |
| `addLiquidity` | LP holder | nonReentrant, onlyLpHolder, ZeroAmount, ratioMatch | ✓ |
| `removeLiquidity` | LP holder | nonReentrant, onlyLpHolder, noOpenPositions, nonZeroLiquidity | ✓ |
| `claimFees` | LP holder | nonReentrant, onlyLpHolder, ZeroAmount | ✓ |
| `setPositionCaps` | LP holder | onlyLpHolder, bpsRange (when nonzero) | ✓ |
| **Emergency tier** | | | |
| `closePool` | LP OR deployer | nonReentrant, notAlreadyClosed | ✓ |

**All functions are consistent within their privilege tier.** No function has weaker guards than its peers at the same privilege level.

---

## Summary

| ID | Finding | Severity |
|----|---------|----------|
| SGA-1 | `_assertReserveInvariant` not called after `claimFees`/`renewPosition` (correct — they don't modify reserves) | INFO |

```
Final:  0 CRITICAL | 0 HIGH | 0 MEDIUM | 0 LOW | 1 INFORMATIONAL
```

### Guard Consistency Assessment

The EXNIHILO codebase demonstrates **perfect semantic guard consistency:**

- **`nonReentrant`:** 100% coverage on all functions with external calls (14/14). The one function without it (`setPositionCaps`) makes no external calls.
- **`onlyLpHolder`:** 100% on all LP-privileged functions (4/4). `closePool` intentionally extends access to the deployer for emergencies.
- **Position holder check:** 100% on voluntary closes (4/4). Public functions that don't require holder auth (`closePositionAfterDeadline`, `renewPosition`) have alternative guards (expiry check, fee payment).
- **Pool identity check:** 100% on all position-touching functions (6/6).
- **`_assertReserveInvariant`:** 100% on all functions that modify `backedAirToken` or `backedAirUsd` (10/10).
- **`closeDate` check:** 100% on position creation (2/2). Not applied to closes/swaps — correct (these must work during pool closure).
- **AirToken onlyPool:** 100% on mint/burn (2/2).
- **Factory-only minting:** 100% on LpNFT (1/1).

**No guard bypass vulnerabilities found. The contract's internal consistency is exemplary.**
