# Behavioral State Analysis (BSA) -- EXNIHILO v4.7

## Phase 1: Behavioral Decomposition

### EXNIHILOPool

Type: DeFi (DEX + leveraged trading)
States: Empty, Active, Closing (closeDate set), Drained (post-removeLiquidity)

Key Invariants:
  - backedAirToken <= airToken.totalSupply()
  - backedAirUsd <= airUsdToken.totalSupply()
  - poolUSDC = backedAirUsd + lpFeesAccumulated + sum(short_locked_airUsd)
  - longOpenInterest = sum(pos.airUsdMinted) for all open longs
  - openPositionCount = count of live position NFTs for this pool

Privileged Roles: LP NFT holder (add/remove liquidity, claim fees, set caps); Factory deployer (closePool)
Value Entry/Exit Points: USDC in/out via swap/open/close/claim; token in/out via swap/realize

### PositionNFT

Type: NFT (custody + accounting)
States: Uninitialized (factory=0), Initialized (factory set)

Key Invariants:
  - Only pool can mint/release positions
  - release() returns lockedToken to position.pool, burns NFT
  - Position data immutable after mint (except deadline via extendDeadline)

Privileged Roles: Pool (mint/release/extendDeadline); Deployer (initFactory)
Value Entry/Exit Points: airToken/airUsd locked on mint, released on release -- always back to pool

### EXNIHILOFactory

Type: Utility (deployer)
States: Active

Key Invariants:
  - allPools.length == LpNFT._nextTokenId (synced counters)
  - isPool[addr] true only for factory-deployed pools

Privileged Roles: Deployer (setDeployer, closePool on any pool)
Value Entry/Exit Points: Tokens transit through factory during createMarket only

### EXNIHILORouter

Type: Utility (thin proxy)
States: Stateless

Key Invariants:
  - Router balance should be 0 between transactions
  - Fee calculation must match pool exactly

Privileged Roles: None
Value Entry/Exit Points: USDC/tokens transit; sweep() drains residuals to caller

### AirToken, LpNFT

Type: Token (ERC20), NFT (ERC721). Standard wrappers, pool/factory-gated mint/burn. Skip deep analysis.

---

## Phase 2: Engine Selection

| Contract         | ETE  | ACTE | SITE |
|------------------|------|------|------|
| EXNIHILOPool     | Full | Full | Full |
| PositionNFT      | Yes  | Yes  | Lite |
| EXNIHILOFactory  | Lite | Yes  | Lite |
| EXNIHILORouter   | Yes  | Lite | Lite |
| AirToken / LpNFT | Lite | Lite | Lite |

---

## Phase 3: Engine Outputs

### Economic Threat Engine (ETE)

#### ETE-1: Value Flow Tracing

USDC IN:  openLong(fee), openShort(fee), renewPosition(fee), swap(USDC->token), addLiquidity, realizeLong(airUsdMinted)
USDC OUT: closeLong(surplus->holder, closeFee->treasury), closeShort(same),
          claimFees(lpFees->LP), swap(token->USDC), removeLiquidity, realizeShort(locked->holder)
          + protocolTreasury: protocolFee on every open; closeFee on profitable close
          + _trySendUsdc: strands USDC on failed transfer -- no recovery path (BSA-6)

Token IN:  swap(token->USDC), addLiquidity, realizeShort(airTokenMinted)
Token OUT: swap(USDC->token), removeLiquidity, realizeLong(lockedAmount)

PositionNFT: IN airToken/airUsd from pool on mint; OUT via release() always back to pool. Confirmed.
Router: transit only. sweep() by design. Confirmed.

#### ETE-2: Economic Invariant Verification

Core equation: poolUSDC = backedAirUsd + lpFeesAccumulated + sum(short_locked_airUsd)

  openLong: +lpFee; backedAirUsd unchanged; lpFees += lpFee. OK
  closeLong: backedAirUsd -= surplus. OK
  openShort: backedAirUsd -= airUsdOut; outstanding += airUsdOut. OK
  closeShort: backedAirUsd += costForDebt; outstanding -= lockedAmount. OK
  claimFees: lpFees = 0. OK
  removeLiquidity: backedAirUsd = 0. Requires openPositionCount == 0. OK
  realizeLong: backedAirUsd += airUsdMinted. OK
  realizeShort: outstanding -= lockedAmount. OK
  swap: net USDC change = backedAirUsd change. OK
  renewPosition: lpFees += lpFee. OK
  closeExpired (failed _trySendUsdc): backedAirUsd decremented, USDC not sent. INVARIANT BROKEN -> BSA-6

One economic invariant violation found: BSA-6.

#### ETE-3: Incentive / MEV Analysis

Sandwich on closes: minUsdcOut slippage present on voluntary closes. Mitigated.
closePositionAfterDeadline with minPayout=0: caller receives nothing; payout goes to holder. No MEV.
Cross-curve manipulation (SWAP-1/2/3): Round-trip requires 2x swap fee. Unprofitable.
LP addLiquidity: ratio check at EXNIHILOPool.sol:913-917 prevents price manipulation.
Renewal griefing BSA-4 re-verified: renewPosition no ownership check (EXNIHILOPool.sol:990). Cost: 5% per renewal. Counter: closePool().

### Access Control Threat Engine (ACTE)

#### ACTE-1: Unprotected Privileged Functions

| Function | Expected Access | Actual Access | Status |
|---|---|---|---|
| openLong/openShort | Anyone | Anyone (nonReentrant) | OK |
| closeLong/closeShort | Position holder | positionNFT.ownerOf(nftId) == msg.sender | OK |
| realizeLong/realizeShort | Position holder | Same check | OK |
| addLiquidity/removeLiquidity | LP holder | onlyLpHolder | OK |
| claimFees | LP holder | onlyLpHolder | OK |
| setPositionCaps | LP holder | onlyLpHolder | OK |
| closePool | LP or deployer | Explicit dual check | OK |
| closePositionAfterDeadline | Anyone (after deadline) | block.timestamp >= pos.deadline | OK |
| renewPosition | Anyone (pays fee) | No auth (by design) | OK |
| swap | Anyone | Anyone | OK |
| PositionNFT.mintLong/mintShort | Pool only | msg.sender == pool + factory check | WARNING BSA-1 |
| PositionNFT.release | Pool only | msg.sender == position.pool | OK |
| PositionNFT.initFactory | Deployer only | msg.sender == _deployer + once-only | OK |
| Factory.createMarket | Anyone | Anyone -- empty validation block | WARNING BSA-5 |
| Factory.setDeployer | Deployer only | msg.sender == deployer | OK |
| LpNFT.mint | Factory only | msg.sender == factory (immutable) | OK |
| AirToken.mint/burn | Pool only | onlyPool modifier | OK |
| Router.sweep | Anyone | Anyone (by design) | OK |

#### ACTE-2: Role Escalation Paths

User -> LP holder: Only by purchasing/receiving LP NFT. No on-chain escalation.
User -> Deployer: Only via Factory.setDeployer (deployer-gated). No escalation.
Pool -> PositionNFT: Pool authorized at mint time. No runtime escalation.
No role escalation paths found.

#### ACTE-3: msg.sender / tx.origin / Signatures

No tx.origin usage. No signature verification. No replay vectors.

### State Integrity Threat Engine (SITE)

#### SITE-1: Non-atomic State Updates

openLong (EXNIHILOPool.sol:507-543): state at L507-517 before any external call. OK
closeLong (EXNIHILOPool.sol:596-617): state at L596-604 before release/burn/transfer. OK
realizeLong (EXNIHILOPool.sol:647-667): pessimistic ordering; nonReentrant held. OK
_closeExpiredLong (EXNIHILOPool.sol:1161-1201): backedAirUsd -= surplus before _trySendUsdc.
  On failed send, backed reserves permanently inconsistent. -> BSA-6
addLiquidity (EXNIHILOPool.sol:920-932): state before interactions. OK
One SITE violation found: BSA-6.

#### SITE-2: Sequence Vulnerabilities

AirToken initPool(): PoolAlreadySet guard, factory-only. OK
PositionNFT initFactory(): FactoryAlreadySet guard, deployer-only. OK
LpNFT: factory immutable. OK
removeLiquidity: blocked while openPositionCount != 0. OK
closePool: PoolAlreadyClosed guard. OK
Position double-close: release() deletes data and burns NFT; second call reverts PositionNotFound. OK

Factory createMarket input validation gap (BSA-5):
  Validation comment block at EXNIHILOFactory.sol:192-194 is empty.
  Zero-checks for tokenAddress, usdcAmount, tokenAmount absent.
  With zero amounts, safeTransferFrom succeeds silently on many ERC-20s,
  proceeding through AirToken and Pool deployments before reverting at addLiquidity.
  No funds lost (call reverts). Two AirToken contracts and one EXNIHILOPool orphaned
  on-chain. Factory registry not updated (written after addLiquidity). No registry pollution.
No sequence vulnerabilities that cause fund loss. BSA-5 is a hardening finding.

#### SITE-3: Cross-contract Stale Data / Reentrancy

positionNFT.mintLong/mintShort -> _safeMint -> onERC721Received: state updated before call; nonReentrant held. OK
positionNFT.release -> _burn (no callback) + safeTransfer to pool (self). OK
_transferIn -> safeTransferFrom: fee-on-transfer check catches anomalies. OK
Router reads pool state then calls pool in same tx: EVM single-threaded; no TOCTOU. OK
PositionNFT _readLive reads pool state for tokenURI: view only. OK
No reentrancy or stale-data vulnerabilities found.

---

## Phase 4: Findings

---

### [BSA-1] PositionNFT mint bypass before initFactory

Severity: Low  |  Confidence: 72%
Location: PositionNFT.sol:226-227 (mintLong), PositionNFT.sol:258-259 (mintShort)

Root Cause: factory == address(0) short-circuits the isPool check. Before initFactory
is called, any address can pass as pool because the factory guard condition is false.

Exploit:
  1. Deploy PositionNFT.
  2. Before deployer calls initFactory, call mintLong(attacker, attacker, ...) with
     msg.sender == pool == attacker. First check passes. Factory check at L227 skipped.

Impact: State pollution (spurious NFTs minted). No fund loss.

Fix: Add at top of mintLong/mintShort:
  if (factory == address(0)) revert FactoryNotSet();

Confidence: Evidence 1.0 x Feasibility 0.4 x Impact 1 / FP 0.05 = 72%

---

### [BSA-2] Factory residual approvals

Severity: Low (code hygiene)  |  Confidence: 28%
Location: EXNIHILOFactory.sol:243-246 (createMarket)

Root Cause: forceApprove(pool, tokenAmount/usdcAmount) set before addLiquidity,
not explicitly revoked after. Pool consumes full allowance for standard ERC-20s.

Impact: Zero for standard ERC-20s. Code hygiene only.

Fix: After addLiquidity: IERC20(tokenAddress).forceApprove(pool, 0); IERC20(usdc).forceApprove(pool, 0);

Confidence: Evidence 1.0 x Feasibility 0.1 x Impact 1 / FP 0.15 = 28%

---

### [BSA-3] No caller incentive for expired position cleanup

Severity: Low  |  Confidence: 85%
Location: EXNIHILOPool.sol:1038-1050, closePositionAfterDeadline()

Root Cause: Caller spends gas; receives nothing. Only position holder (payout) and LP benefit.

Impact: Expired positions linger; LP must self-serve cleanup. Unbounded gas cost on LP exit.

Fix: Consider small keeper reward (e.g. 0.1% of payout deducted from holder surplus). Optional.

Confidence: Evidence 1.0 x Feasibility 1.0 x Impact 2 / FP 0.15 = 85%

---

### [BSA-4] Anyone-can-renew as LP exit griefing vector

Severity: Low  |  Confidence: 45%
Location: EXNIHILOPool.sol:990, renewPosition()

Root Cause: No ownership check. Anyone can pay the renewal fee to extend any position.

Exploit: Keep renewing positions to prevent expiry; LP cannot removeLiquidity.
Cost to attacker: 5% of notional per period.
Counter-measure: closePool() sets closeDate; renewals past closeDate revert
RenewalExceedsCloseDate at EXNIHILOPool.sol:1010.

Fix: No code fix required -- closePool() is sufficient mitigation.

Confidence: Evidence 1.0 x Feasibility 0.4 x Impact 3 / FP 0.15 = 45%

---

### [BSA-5] createMarket empty input validation block

Severity: Low  |  Confidence: 80%
Location: EXNIHILOFactory.sol:192-194, createMarket()

Root Cause: The validation comment at EXNIHILOFactory.sol:192 is followed by a blank
line and immediately the token pull at L198. No guards exist for:
  - tokenAddress == address(0)
  - usdcAmount == 0
  - tokenAmount == 0
positionDuration == 0 validated inside pool constructor (EXNIHILOPool.sol:394-399)
but only after both safeTransferFrom calls at L198-199 have executed.

Exploit: With usdcAmount == 0 or tokenAmount == 0:
  safeTransferFrom(from, to, 0) succeeds silently on many ERC-20s.
  createMarket deploys AirToken x2, EXNIHILOPool before reverting at ZeroAmount in
  addLiquidity (EXNIHILOPool.sol:910). Two AirToken contracts and one EXNIHILOPool are
  orphaned on-chain. Factory registry NOT updated -- no registry corruption.

Impact: Wasted gas on orphaned deployments. No fund loss; no registry corruption.

Fix:
  if (tokenAddress == address(0)) revert ZeroAddress();
  if (usdcAmount == 0 || tokenAmount == 0) revert ZeroAmount();

Confidence: Evidence 1.0 x Feasibility 0.6 x Impact 2 / FP 0.15 = 80%

---

### [BSA-6] _trySendUsdc strands USDC with no accounting entry

Severity: Medium  |  Confidence: 88%
Location: EXNIHILOPool.sol:1353-1361, _trySendUsdc()
Called from: EXNIHILOPool.sol:1186-1187 (_closeExpiredLong), 1229-1230 (_closeExpiredShort)

Root Cause: When USDC transfer fails (recipient is USDC-blacklisted), PayoutFailed is
emitted and the function returns. By this point the state machine has already:
  - Decremented backedAirUsd (EXNIHILOPool.sol:1181 or 1224)
  - Burned airUsdToken for the full surplus
  - Decremented openPositionCount

Stranded USDC cannot be recovered via:
  - claimFees(): distributes lpFeesAccumulated only
  - removeLiquidity(): distributes backedAirUsd only (EXNIHILOPool.sol:958-963)
  - Any other on-chain function

Affected paths:
  _closeExpiredLong (profitable): _trySendUsdc(holder, netSurplus) L1186,
                                  _trySendUsdc(protocolTreasury, closeFee) L1187
  _closeExpiredShort (profitable): _trySendUsdc(holder, netSurplus) L1229,
                                   _trySendUsdc(protocolTreasury, closeFee) L1230

Exploit: A USDC-blacklisted holder opens a long position and waits for it to expire
in-profit. Any keeper calling closePositionAfterDeadline succeeds but the profit is
permanently locked. A blacklisted protocolTreasury strands all close-fee USDC on every
expired profitable position cleanup system-wide.

Impact: USDC permanently unrecoverable. LP effective backedAirUsd underreports actual
USDC held, causing removeLiquidity to leave USDC in pool even when openPositionCount == 0.

Fix (preferred): Credit stranded amounts back to lpFeesAccumulated:
  try IERC20(underlyingUsdc).transfer(to, amount) returns (bool success) {
      if (!success) { lpFeesAccumulated += amount; emit PayoutFailed(to, amount); }
  } catch { lpFeesAccumulated += amount; emit PayoutFailed(to, amount); }

Fix (alternative): Add rescueUsdc(address to) callable only by deployer that transfers
  balance(USDC) - backedAirUsd - lpFeesAccumulated - sum(short_locked) to specified address.

Note: Voluntary close paths (closeLong, closeShort) use safeTransfer -- no risk there.
This issue is isolated to the expired-position cleanup path only.

Confidence: Evidence 1.0 x Feasibility 0.7 (USDC blacklist is real) x Impact 4 / FP 0.05 = 88%

---

## Phase 5: Score Summary

Engines run: ETE (full), ACTE (full), SITE (full) on EXNIHILOPool
             ETE + ACTE on PositionNFT, Factory, Router
             Lite on AirToken, LpNFT

Total findings: 6
  BSA-1   Low       PositionNFT mint bypass before initFactory          72%
  BSA-2   Low       Factory residual approvals (hygiene)                28%
  BSA-3   Low       No keeper incentive for expired cleanup             85%
  BSA-4   Low       Anyone-can-renew griefing                           45%
  BSA-5   Low       createMarket empty validation block                 80%
  BSA-6   Medium    _trySendUsdc strands USDC permanently               88%

Final: 0 CRITICAL | 0 HIGH | 1 MEDIUM | 5 LOW | 0 INFO

BSA Assessment: The protocol economic invariants hold across all normal operation paths.
Access control is tight with no escalation vectors. CEI is consistently applied. The
three-mode AMM (SWAP-1/2/3) with virtual reserves is internally consistent and no
cross-curve extraction was found feasible. BSA-6 is the only material new finding:
a permanent USDC accounting gap activated by USDC blacklisting in the expired-position
cleanup path. All other findings are low-severity hardening items unchanged from baseline.

---

## Delta vs 4.6

| ID    | Status                | Description |
|-------|-----------------------|-------------|
| BSA-1 | Confirmed (unchanged) | PositionNFT factory=0 mint bypass -- code path verified at PositionNFT.sol:226-227 |
| BSA-2 | Confirmed (unchanged) | Factory residual approvals -- forceApprove(pool, 0) absent after addLiquidity at EXNIHILOFactory.sol:246 |
| BSA-3 | Confirmed (unchanged) | No keeper incentive -- closePositionAfterDeadline pays nothing to caller at EXNIHILOPool.sol:1038 |
| BSA-4 | Confirmed (unchanged) | Anyone-can-renew -- no auth on renewPosition at EXNIHILOPool.sol:990; closePool() counter-mitigates |
| BSA-5 | NEW (v4.7)            | createMarket validation block at EXNIHILOFactory.sol:192 is empty; zero-amounts cause orphaned contract deployments with no fund loss |
| BSA-6 | NEW (v4.7) MEDIUM     | _trySendUsdc at EXNIHILOPool.sol:1353 strands USDC permanently on USDC-blacklisted recipients; no recovery path in claimFees or removeLiquidity |
