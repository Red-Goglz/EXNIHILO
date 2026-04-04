# Behavioral State Analysis (BSA) — EXNIHILO

## Phase 1: Behavioral Decomposition

```
Contract: EXNIHILOPool
Type: DeFi (DEX + leveraged trading)
States: [Empty, Active, Closing (closeDate set), Drained (post-removeLiquidity)]
Key Invariants (≤5):
  - backedAirToken ≤ airToken.totalSupply()
  - backedAirUsd ≤ airUsdToken.totalSupply()
  - poolUSDC = backedAirUsd + lpFeesAccumulated + Σ(short_locked_airUsd)
  - longOpenInterest = Σ(pos.airUsdMinted) for all open longs
  - openPositionCount = count of live position NFTs for this pool
Privileged Roles: [LP NFT holder (add/remove liquidity, claim fees, set caps), Factory deployer (closePool)]
Value Entry/Exit Points: [USDC in/out via swap/open/close/claim, underlying token in/out via swap/realize]
```

```
Contract: PositionNFT
Type: NFT (custody + accounting)
States: [Uninitialized (factory=0), Initialized (factory set)]
Key Invariants (≤3):
  - Only pool can mint/release positions
  - release() returns lockedToken to position.pool, burns NFT
  - Position data immutable after mint (except deadline via extendDeadline)
Privileged Roles: [Pool (mint/release/extendDeadline), Deployer (initFactory)]
Value Entry/Exit Points: [airToken/airUsd locked on mint, released on release — always back to pool]
```

```
Contract: EXNIHILOFactory
Type: Utility (deployer)
States: [Active]
Key Invariants (≤3):
  - allPools.length == LpNFT._nextTokenId (synced counters)
  - isPool[addr] true only for factory-deployed pools
  - No admin functions except setDeployer and closePool proxy
Privileged Roles: [Deployer (setDeployer, closePool on any pool)]
Value Entry/Exit Points: [Tokens transit through factory during createMarket only]
```

```
Contract: EXNIHILORouter
Type: Utility (thin proxy)
States: [Stateless]
Key Invariants (≤2):
  - Router balance should be 0 between transactions
  - Fee calculation must match pool's exactly
Privileged Roles: [None]
Value Entry/Exit Points: [USDC/tokens transit; sweep() drains residuals to caller]
```

```
Contract: AirToken, LpNFT
Type: Token (ERC20), NFT (ERC721)
— Standard wrappers, pool/factory-gated mint/burn. Skip deep analysis.
```

### Engine Selection

| Contract | ETE | ACTE | SITE |
|----------|-----|------|------|
| EXNIHILOPool | **Yes** | **Yes** | **Yes** |
| PositionNFT | Yes | Yes | Lite |
| EXNIHILOFactory | Lite | Yes | Lite |
| EXNIHILORouter | Yes | Lite | Lite |
| AirToken/LpNFT | Lite | Lite | Lite |

---

## Phase 2: Threat Modeling

### Economic Threat Engine (ETE)

#### ETE-1: Value Flow Tracing

**EXNIHILOPool value flows:**

```
USDC IN:  openLong(fee), openShort(fee), renewPosition(fee), swap(USDC→token), addLiquidity, realizeLong(debt)
USDC OUT: closeLong(surplus), closeShort(surplus), claimFees, swap(token→USDC), removeLiquidity, realizeShort(locked), closeExpired*(surplus)
          + protocolTreasury receives: protocolFee on open, closeFee on profitable close

Token IN:  swap(token→USDC), addLiquidity, realizeShort(airTokenMinted of underlying)
Token OUT: swap(USDC→token), removeLiquidity, realizeLong(lockedAmount of underlying)
```

**Sinks/circular flows:** None. Every USDC in is accounted for by `backedAirUsd + lpFeesAccumulated + outstanding_short_locked`. Every token in is accounted by `backedAirToken + locked_in_NFT_for_longs`. No orphaned value.

**PositionNFT value flows:**
- IN: airToken (via mintLong), airUsd (via mintShort) — pulled from pool
- OUT: release() — always returns to `position.pool`
- No arbitrary withdrawal. Locked tokens cannot exit except through pool-gated release. ✓

**Router value flows:**
- Transit only. `sweep()` allows anyone to drain residuals. By design: router should hold 0 between txs.

#### ETE-2: Economic Invariant Verification

**Core equation:** `poolUSDC = backedAirUsd + lpFeesAccumulated + Σ(short_locked_airUsd)`

Verified across all operations:
- openLong: +lpFee USDC, −protocolFee USDC. backedAirUsd unchanged. lpFees += lpFee. ✓
- closeLong: −surplus USDC. backedAirUsd -= surplus. ✓
- openShort: +lpFee USDC, −protocolFee. backedAirUsd -= airUsdOut. outstanding += airUsdOut. ✓
- closeShort: −surplus USDC. backedAirUsd += costForDebt. outstanding -= lockedAmount. ✓
- claimFees: −lpFees USDC. lpFees = 0. ✓
- removeLiquidity: −backedAirUsd USDC. backedAirUsd = 0. (requires openPositionCount == 0) ✓
- realizeLong: +airUsdMinted USDC. backedAirUsd += airUsdMinted. ✓
- realizeShort: −lockedAmount USDC. outstanding -= lockedAmount. ✓
- swap: net USDC change = backedAirUsd change. ✓
- renewPosition: +lpFee USDC, −protocolFee USDC. lpFees += lpFee. ✓

**No economic invariant violations found.**

#### ETE-3: Incentive / MEV Analysis

**Sandwich on closeLong/closeShort:**
- Attacker front-runs with swap to move price against victim → victim's close returns less → attacker back-runs to restore.
- **Mitigation present:** `minUsdcOut` slippage parameter on closeLong/closeShort. If victim sets reasonable slippage, sandwich reverts their tx.
- `closePositionAfterDeadline(nftId, 0)` with `minPayout=0` is vulnerable — but this is caller's choice, and payout goes to holder not caller anyway.

**Cross-AMM-curve manipulation:**
- SWAP-1 uses (backedAirToken, backedAirUsd). SWAP-2/3 use virtual reserves including totalSupply.
- Manipulating SWAP-1 affects SWAP-2/3 pricing, but swap fees (2× for round-trip) make extraction unprofitable.
- **Verified unprofitable** in Nemesis Phase 5 Sequence 5.

**LP as counterparty gaming:**
- LP can `addLiquidity` to change reserves and affect position profitability. But ratio check preserves price. Effect is deeper liquidity (less slippage), which marginally benefits position holders. LP can't profit from this — they dilute themselves.
- LP can `closePool()` to force expiry. This is a legitimate admin function, not an attack.

**Renewal griefing:**
- Anyone can pay 5% to renew someone's position, delaying LP exit.
- Cost: expensive (5% per period). Counter: `closePool()`. N/A as profitable attack.

### Access Control Threat Engine (ACTE)

#### ACTE-1: Unprotected Privileged Functions

| Function | Expected Access | Actual Access | Status |
|----------|----------------|---------------|--------|
| `openLong/openShort` | Anyone | Anyone (nonReentrant) | ✓ |
| `closeLong/closeShort` | Position holder | `positionNFT.ownerOf(nftId) == msg.sender` | ✓ |
| `realizeLong/realizeShort` | Position holder | Same check | ✓ |
| `addLiquidity/removeLiquidity` | LP holder | `onlyLpHolder` (lpNftContract.ownerOf) | ✓ |
| `claimFees` | LP holder | `onlyLpHolder` | ✓ |
| `setPositionCaps` | LP holder | `onlyLpHolder` | ✓ |
| `closePool` | LP or deployer | Explicit dual check | ✓ |
| `closePositionAfterDeadline` | Anyone (after deadline) | `block.timestamp >= pos.deadline` | ✓ |
| `renewPosition` | Anyone (pays fee) | No auth (by design) | ✓ |
| `swap` | Anyone | Anyone | ✓ |
| `PositionNFT.mintLong/mintShort` | Pool only | `msg.sender == pool` + factory check | ⚠️ See BSA-1 |
| `PositionNFT.release` | Pool only | `msg.sender == position.pool` | ✓ |
| `PositionNFT.initFactory` | Deployer only | `msg.sender == _deployer` + once-only | ✓ |
| `Factory.setDeployer` | Deployer only | `msg.sender == deployer` | ✓ |
| `LpNFT.mint` | Factory only | `msg.sender == factory` (immutable) | ✓ |
| `AirToken.mint/burn` | Pool only | `onlyPool` modifier | ✓ |
| `Router.sweep` | Anyone | Anyone (by design — router should be empty) | ✓ |

#### ACTE-2: Role Escalation Paths

```
User → LP holder? Only by purchasing/receiving the LP NFT (ERC-721 transfer). No on-chain escalation path. ✓
User → Deployer? Only via Factory.setDeployer (deployer-gated). No escalation. ✓
Pool → PositionNFT admin? Pool is authorized at mint time. No runtime escalation. ✓
```

**No escalation paths found.**

#### ACTE-3: msg.sender/tx.origin and Signatures

- No `tx.origin` usage anywhere. ✓
- No signature verification (no permit, no meta-tx). ✓
- No replay vectors. ✓

### State Integrity Threat Engine (SITE)

#### SITE-1: Non-atomic State Updates

All state-changing functions follow strict CEI:
- **CHECKS** (reverts): L466–503 (openLong), L571–592 (closeLong), etc.
- **EFFECTS** (state writes): L506–516 (openLong), L595–603 (closeLong), etc.
- **INTERACTIONS** (external calls): L521–538 (openLong), L606–614 (closeLong), etc.

**Special case — realizeLong/realizeShort:**
```
openPositionCount--;           // EFFECT (safe — doesn't depend on transfer)
longOpenInterest -= ...;       // EFFECT
_transferIn(usdc, sender, amount);  // INTERACTION — pulls USDC
backedAirUsd += amount;        // EFFECT — written AFTER confirmed receipt
```

This is intentional "pessimistic accounting" — the backed reserve isn't updated until USDC is confirmed received. Safe because nonReentrant prevents reentrance between the two effects. ✓

**No non-atomic state update vulnerabilities found.**

#### SITE-2: Sequence Vulnerabilities

**Initialization bypass:**
- AirToken: `initPool()` can only be called once (PoolAlreadySet check), only by factory. ✓
- PositionNFT: `initFactory()` can only be called once, only by deployer. ✓
- LpNFT: factory is immutable in constructor. ✓

**Unexpected call ordering:**
- Can `removeLiquidity` be called before `addLiquidity`? No — `backedAirToken == 0 && backedAirUsd == 0` → reverts with `ZeroLiquidity`. ✓
- Can `closePool` be called multiple times? No — `PoolAlreadyClosed` check. ✓
- Can position be closed twice? No — `release()` deletes position data and burns NFT. Second call reverts `PositionNotFound`. ✓

**No sequence vulnerabilities found.**

#### SITE-3: Cross-contract Stale Data / Reentrancy

**Reentrancy vectors:**
- `positionNFT.mintLong` → `_safeMint(recipient)` → `onERC721Received` callback.
  - All pool state is updated before this call. `nonReentrant` held. No reentrance possible. ✓
- `positionNFT.release` → `_burn` (no callback) + `safeTransfer` to pool (self). No external callback. ✓
- `_transferIn` → `safeTransferFrom`. No callback unless token is ERC-777 or similar. Fee-on-transfer check catches balance anomalies. ✓

**Cross-contract stale data:**
- Router reads `backedAirUsd()` and `longOpenInterest()` then calls `openLong()` in same tx. No state changes between read and call — consistent. ✓
- PositionNFT `_readLive` reads pool state for tokenURI — view only, no state dependency. ✓

**No reentrancy or stale data vulnerabilities found.**

---

## Phase 3: Exploit Verification

All Phase 2 hypotheses were investigated. No new exploitable findings beyond Nemesis results:

**Router fee TOCTOU:** The router's `_positionFee()` reads pool state then calls `pool.openLong()` in the same transaction. EVM single-threaded execution prevents state changes between read and call. Router's own `nonReentrant` prevents batching. **FALSE POSITIVE.**

**sweep() front-running for residual extraction:** If a user sends excess USDC to the router (e.g., over-specified renewal fee), the residual can be extracted by anyone calling `sweep()` in the next block. The amounts pulled by the router match exactly what the pool consumes (fee calculation mirrors pool's). Residuals only occur on non-standard tokens or user error. **Informational — no practical impact.**

---

## Phase 4: Score & Prioritize

### [BSA-1] PositionNFT mint bypass before initFactory (= Nemesis NM-001)

```
Severity: Low  |  Confidence: 72%
Location: PositionNFT.sol#L226-L227, mintLong()/mintShort()
Root Cause: factory == address(0) skips isPool check
Exploit: 1. Deploy PositionNFT 2. Before initFactory, call mintLong(attacker, attacker, ..., 0)
Impact: State pollution (fake NFTs), no fund loss
Fix: Add `if (factory == address(0)) revert FactoryNotSet();`
```

Evidence: 1.0 (concrete code path) × Feasibility: 0.4 (requires deployment window) × Impact: 1 / FP: 0.05 = **8.0 → 72%**

### [BSA-2] Factory residual approvals (= Nemesis NM-002)

```
Severity: Low  |  Confidence: 28%
Location: EXNIHILOFactory.sol#L226-L229, createMarket()
Root Cause: Missing forceApprove(pool, 0) after addLiquidity
Exploit: N/A — factory holds no tokens post-call
Impact: Zero. Code hygiene only.
Fix: Add IERC20(tokenAddress).forceApprove(pool, 0); IERC20(usdc).forceApprove(pool, 0);
```

Evidence: 1.0 × Feasibility: 0.1 (no tokens to exploit) × Impact: 1 / FP: 0.15 = **0.67 → 28%**

### [BSA-3] No caller incentive for expired position cleanup (= Nemesis NM-003)

```
Severity: Low  |  Confidence: 85%
Location: EXNIHILOPool.sol#L1037-L1049, closePositionAfterDeadline()
Root Cause: Caller spends gas, receives nothing. Only holder/LP benefit.
Exploit: N/A — design issue, not exploit
Impact: Expired positions linger; LP must self-serve cleanup
Fix: Consider small keeper reward (e.g., 0.1% of payout) — optional design change
```

Evidence: 1.0 × Feasibility: 1.0 × Impact: 2 / FP: 0.15 = **13.3 → 85%**

### [BSA-4] Anyone-can-renew as griefing vector (= Nemesis NM-004)

```
Severity: Low  |  Confidence: 45%
Location: EXNIHILOPool.sol#L989, renewPosition()
Root Cause: No ownership check on renewal caller
Exploit: 1. Target pool with open positions 2. Keep renewing to prevent LP exit
Impact: LP exit delayed. Cost: 5% of notional per period. Counter: closePool()
Fix: No code fix needed — closePool() is sufficient mitigation
```

Evidence: 1.0 × Feasibility: 0.4 (expensive griefing) × Impact: 3 / FP: 0.15 = **8.0 → 45%**

---

## BSA Summary

```
Engines run:     ETE (full), ACTE (full), SITE (full) on EXNIHILOPool
                 ETE + ACTE on PositionNFT, Factory, Router
                 Lite on AirToken, LpNFT

New findings beyond Nemesis:  0
Confirmed Nemesis findings:   4 (NM-001 through NM-004)

Final:  0 CRITICAL | 0 HIGH | 0 MEDIUM | 4 LOW | 1 INFO
```

**BSA Assessment:** The protocol's behavioral intent (synthetic leveraged trading with single-LP custody) is correctly implemented across all security dimensions. Economic invariants hold, access control is tight, state transitions are atomic with CEI, and cross-contract interactions are properly guarded. The three-mode AMM (SWAP-1/2/3) with virtual reserves is novel but internally consistent — no cross-curve extraction was feasible. The codebase passes BSA with no actionable findings above LOW.
