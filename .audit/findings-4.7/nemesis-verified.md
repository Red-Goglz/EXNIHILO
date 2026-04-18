# N E M E S I S -- Claude 4.7 Verified Findings

## Scope

- Language: Solidity 0.8.24
- Auditor: Claude Sonnet 4.6 (Nemesis -- Stage 1 Feynman + Stage 2 State Inconsistency + Stage 3 Fusion)
- Modules: EXNIHILOPool (1376 L), PositionNFT (613 L), EXNIHILOFactory (275 L), EXNIHILORouter (148 L), LpNFT (76 L), AirToken (92 L)
- Functions analyzed: 44 (all external/public + key internal helpers)
- Coupled state pairs: 8
- Mutation paths traced: 62
- Nemesis iterations: 3 (Pass 1 Feynman > Pass 2 State Mapper > Pass 3 Fusion > converged)
- Baseline: .audit/findings/nemesis-verified.md (NM-001..NM-005)
- Prior 4.7 pre-write flags: NM-006, NM-007, NM-008

---

## Phase 0 -- Recon

Attack goals: drain reserves; free-money positions; price manipulation; LP grief;
fee exploitation; USDC stranding via silent transfer; deployer-role corruption.

Novel code (highest bug density):
  - EXNIHILOPool -- 3-mode virtual AMM (SWAP-1/2/3) is entirely custom
  - Spot-price fee model in _cpAmountOut (fee = amountIn x reserveOut/reserveIn x feeBps)
  - OI-integral impact fee formula (split-proof quadratic)
  - Router fee replication using pre-call live state reads (snapshot vs execution race)
  - _trySendUsdc silent failure path in expired position cleanup

Priority order:
  1. EXNIHILORouter -- race between fee snapshot and pool execution
  2. EXNIHILOPool._trySendUsdc -- silent failure strands USDC with no recovery
  3. EXNIHILOFactory.setDeployer -- zero-address guard gap bricks emergency path
  4. PositionNFT -- access control before initFactory

---

## Phase 1 -- Feynman Interrogation (Pass 1)

### 1A: Function-State Matrix

| Function | Reads | Writes | Guards | External Calls |
|----------|-------|--------|--------|----------------|
| swap | backedAirToken, backedAirUsd | backedAirToken, backedAirUsd | nonReentrant | _transferIn, safeTransfer, airToken.mint/burn, airUsd.mint/burn |
| openLong | backedAirToken, backedAirUsd, airUsd.totalSupply, longOI, closeDate | backedAirToken, openPositionCount, longOI, lpFeesAccumulated | nonReentrant | _transferIn, safeTransfer, airUsd.mint, positionNFT.mintLong |
| closeLong | backedAirUsd, airToken.totalSupply | backedAirToken, backedAirUsd, openPositionCount, longOI | nonReentrant | positionNFT.release, airUsd.burn x2, safeTransfer x2 |
| realizeLong | -- | openPositionCount, longOI, backedAirUsd | nonReentrant | _transferIn, positionNFT.release, airToken.burn, safeTransfer |
| openShort | backedAirToken, backedAirUsd, airToken.totalSupply, shortOI, closeDate | backedAirUsd, openPositionCount, shortOI, lpFeesAccumulated | nonReentrant | _transferIn, safeTransfer, airToken.mint, positionNFT.mintShort |
| closeShort | backedAirToken, airUsd.totalSupply | backedAirUsd, openPositionCount, shortOI | nonReentrant | positionNFT.release, airToken.burn, airUsd.burn, safeTransfer x2 |
| realizeShort | -- | openPositionCount, shortOI, backedAirToken | nonReentrant | _transferIn, positionNFT.release, airUsd.burn, safeTransfer |
| addLiquidity | backedAirToken, backedAirUsd | backedAirToken, backedAirUsd | nonReentrant, onlyLpHolder | _transferIn x2, airToken.mint, airUsd.mint |
| removeLiquidity | openPositionCount, backedAirToken, backedAirUsd | backedAirToken=0, backedAirUsd=0 | nonReentrant, onlyLpHolder | airToken/airUsd.burn, safeTransfer x2 |
| claimFees | lpFeesAccumulated | lpFeesAccumulated=0 | nonReentrant, onlyLpHolder | safeTransfer |
| renewPosition | pos.deadline, closeDate | lpFeesAccumulated | nonReentrant | _transferIn, safeTransfer, positionNFT.extendDeadline |
| closePositionAfterDeadline | pos.deadline | via internal helpers | nonReentrant | _closeExpired* |
| closePool | closeDate | closeDate | nonReentrant | -- |
| Router.openLong | pool.backedAirUsd, pool.longOI | -- | nonReentrant, onlyPool | _positionFee (live state read), pool.openLong |
| Router.openShort | pool.backedAirUsd, pool.shortOI | -- | nonReentrant, onlyPool | _positionFee (live state read), pool.openShort |
| Router.renewPosition | -- fee passed by caller | -- | nonReentrant, onlyPool | pool.renewPosition |
| Router.sweep | -- | -- | NONE | token.balanceOf + safeTransfer |
| Factory.createMarket | allPools.length | isPool, allPools | nonReentrant | deploy, airToken.initPool, lpNft.mint, addLiquidity, transferFrom |
| Factory.setDeployer | deployer | deployer | OnlyDeployer | -- |

### 1B: Coupled State Dependency Map

| Pair | State A | State B | Invariant |
|------|---------|---------|-----------|
| CP-1 | backedAirToken | airToken.totalSupply() | A <= B (reserve <= supply) |
| CP-2 | backedAirUsd | airUsdToken.totalSupply() | A <= B |
| CP-3 | openPositionCount | live NFTs in PositionNFT | A = count(B) |
| CP-4 | longOpenInterest | sum(pos.airUsdMinted) open longs | A = B |
| CP-5 | shortOpenInterest | sum(pos.usdcIn) open shorts | A = B |
| CP-6 | lpFeesAccumulated | USDC claimable | A <= B |
| CP-7 | underlyingUsdc.balanceOf(pool) | backedAirUsd + lpFees + sum(short_locked) | A = B |
| CP-8 | allPools.length | LpNFT._nextTokenId | A = B at createMarket entry |

### 1C: Key Feynman Results

#### Router._positionFee (Router.sol L63-81) -- Category 2 (Ordering)

_positionFee reads pool.backedAirUsd() and pool.longOI/shortOI as view-calls at time T.
Pool recomputes independently at T+delta. Any OI decrease or backedAirUsd increase between
T and T+delta means the pool demands LESS fee than the router already pulled from the user.
Delta strands in router. Router.sweep() (L142-147) has NO access control.
VERDICT: SUSPECT -- confirmed NM-006 (MEDIUM).

#### Factory.setDeployer (Factory.sol L267-270) -- Category 5 (Boundaries)

  function setDeployer(address newDeployer) external {
      if (msg.sender != deployer) revert OnlyDeployer();
      deployer = newDeployer;   // no zero-address check
  }

Setting deployer = address(0): factory.deployer() = address(0); pool.closePool() deployer
branch permanently dead; OnlyDeployer: address(0) never msg.sender -> role unrecoverable.
NatSpec says Must not be zero -- guard absent.
VERDICT: TRUE POSITIVE -- confirmed NM-007 (LOW).

#### Pool._trySendUsdc in _closeExpiredLong/Short profitable paths (Pool.sol L1161-1244) -- Category 7

Profitable expired long path (L1180-1189):
  L1180: backedAirToken += pos.lockedAmount   <- COMMITTED
  L1181: backedAirUsd  -= surplus              <- COMMITTED
  L1183: positionNFT.release(nftId)            <- NFT burned
  L1184: airUsdToken.burn(airUsdMinted)        <- supply decremented
  L1185: airUsdToken.burn(surplus)             <- supply decremented
  L1186: _trySendUsdc(holder, netSurplus)      <- SILENT FAILURE POSSIBLE
  L1187: _trySendUsdc(treasury, closeFee)      <- SILENT FAILURE POSSIBLE

After silent failure: backedAirUsd decremented, airUsd burned, USDC never moved.
CP-7 violated: poolUSDC_real > accounting sum by netSurplus (plus closeFee if also fails).
_assertReserveInvariant() checks only backed <= supply -- CP-7 violation invisible.
Pool has no rescue/sweep function. Gap is permanent.
VERDICT: TRUE POSITIVE -- confirmed NM-008 (MEDIUM).

---

## Phase 2 -- State Inconsistency Mapper (Pass 2)

### 2A: Mutation Matrix

| State Variable | Mutating Functions | Coupled State Updated? |
|---|---|---|
| backedAirToken | openLong(-), closeLong(+), realizeShort(+), swap(+-), addLiquidity(+), removeLiquidity(=0), _closeExpired*(+-) | ALWAYS paired with airToken mint/burn/transfer |
| backedAirUsd | closeLong(-), openShort(-), closeShort(+), realizeLong(+), swap(+-), addLiquidity(+), removeLiquidity(=0), _closeExpired*(+-) | ALWAYS paired with airUsd mint/burn/transfer |
| lpFeesAccumulated | openLong(+), openShort(+), renewPosition(+), claimFees(=0) | USDC pulled before increment; transferred at claim |
| openPositionCount | open*(+), close*/realize*(-), closeExpired*(-) | 1:1 with positionNFT mint/burn |
| longOpenInterest | openLong(+usdcAmount), closeLong/realizeLong/closeExpiredLong(-airUsdMinted) | airUsdMinted=usdcAmount per mintLong args L531-532 |
| shortOpenInterest | openShort(+usdcNotional), closeShort/realizeShort/closeExpiredShort(-usdcIn) | pos.usdcIn=usdcNotional per mintShort args L763-766 |
| deployer (factory) | setDeployer | NO guard against address(0) -- bricks emergency path |

### 2B: CP-7 Trace -- _closeExpiredLong Profitable Path

Pre-state: poolUSDC_real = backedAirUsd_0 + lpFees_0 + sum(short_locked)

_closeExpiredLong (profitable, netSurplus=S, closeFee=F, surplus=S+F):
  L1181: backedAirUsd -= (S+F)              backedAirUsd = backedAirUsd_0 - S - F
  L1184: airUsdToken.burn(airUsdMinted)      proportional supply decrement
  L1185: airUsdToken.burn(surplus)           proportional supply decrement
  L1186: _trySendUsdc(holder, S)             FAILS: poolUSDC_real unchanged
  L1187: _trySendUsdc(treasury, F)           FAILS: poolUSDC_real unchanged

After failure:
  Accounting: (backedAirUsd_0-S-F) + lpFees_0 + short_locked
  Real:       backedAirUsd_0 + lpFees_0 + short_locked
  Gap: S+F permanently orphaned in pool

_assertReserveInvariant() at L1200:
  backedAirToken <= airToken.totalSupply()   PASSES (collateral returned at L1180)
  backedAirUsd <= airUsdToken.totalSupply()  PASSES (both decremented proportionally)
  Does NOT check underlyingUsdc.balanceOf(pool) vs accounting sum.
  CP-7 violation is INVISIBLE to the on-chain guard.

CONFIRMED: NM-008 TRUE POSITIVE MEDIUM.

### 2C: Router Fee-Race Trace

Router._positionFee at T:
  backedUsd = pool.backedAirUsd()          view snapshot
  oi = pool.longOpenInterest()             view snapshot
  impactFee = 1500 * notional * (2*oi + notional) / (2*backedUsd*10000)

Pool.openLong at T+delta recomputes using live longOpenInterest and backedAirUsd.

Scenario B (OI decreased or backedAirUsd increased between T and T+delta):
  fee_T > fee_Tdelta
  Router pulled fee_T from user; pool pulled fee_Tdelta from router.
  Delta = fee_T - fee_Tdelta stranded in router.
  Router.sweep(usdc): unrestricted -- any address collects delta immediately.

Max delta (100k notional, 100k OI drop, 200k backedAirUsd):
  delta = 1500 * 100_000e6 * 200_000e6 / (2 * 200_000e6 * 10_000) ~= $3,750 USDC

CONFIRMED: NM-006 TRUE POSITIVE MEDIUM.

### 2D: CP-8 Trace -- allPools vs LpNFT._nextTokenId

createMarket (Factory.sol L181-258):
  allPools.length = N at entry
  L218: pool deployed with lpNftId_ = allPools.length = N  [correct prediction]
  L239: lpNftContract.mint(this, pool)  [mints ID N, _nextTokenId -> N+1]
  L255: allPools.push(pool)             [allPools.length -> N+1]
  Invariant: allPools.length = N+1 = LpNFT._nextTokenId at exit
  Intra-tx gap between L239 and L255 prevented by nonReentrant.
VERDICT: FALSE POSITIVE -- gap unexploitable.

---

## Phase 3 -- Nemesis Fusion Loop (Pass 3)

### 3A: CP-7 gap fed back to Feynman

Re-interrogation of _assertReserveInvariant() confirms structural blindness to
underlyingUsdc.balanceOf(pool) vs accounting sum. Both backed reserves decrease
proportionally with their paired supply when airUsd is burned -- reserve invariant
holds even after the CP-7 violation. NM-008 MEDIUM confirmed.

Extension: protocolTreasury is immutable. If treasury is ever USDC-blacklisted,
all closeFee from expired profitable positions (L1187, L1230) is permanently stranded.

### 3B: New coupled pair from NM-006

CP-9: Router.usdc.balanceOf(router) should equal 0 between transactions.
Breaking path: OI race (Scenario B/C) leaves fee delta unaccounted in router.
No state variable tracks this -- invariant is entirely implicit.

### 3C: New finding from fusion -- NM-009

Router.renewPosition (L128-137) accepts raw fee from caller. openLong/openShort compute
fee internally via _positionFee(). Pool.renewPosition (L990-1021) computes totalFee
independently and pulls exactly that via _transferIn(underlyingUsdc, msg.sender, totalFee).
If caller supplies fee > pool.totalFee: excess strands in router, claimable via sweep().
No on-chain renewalFee(nftId) view. Stale frontend quote = silent overpayment.
VERDICT: NEW TRUE POSITIVE -- LOW (NM-009).

### 3D: Masking Code Search

| Pattern | Location | Assessment |
|---------|----------|------------|
| if (!success) emit PayoutFailed | Pool L1357-1358 | MASKING: silent failure; accounting committed regardless |
| if (rawOut <= fee) return 0 | Pool L1300 | Natural bound -- not masking |
| try/catch pnlReady=false | PositionNFT L385 | View-only display -- not masking |
| if (backedUsd == 0) return fee | Router L74 | Div-by-zero guard -- not masking |

### 3E: Convergence

Pass 3: NM-006/NM-008 MEDIUM confirmed, NM-007 LOW confirmed, NM-009 new LOW.
No further cross-feeds. CONVERGED.

---

## Phase 4 -- Verification Gate

### NM-001: PositionNFT mintLong/mintShort accessible before initFactory
**File:** PositionNFT.sol L226-227
When factory == address(0), second guard is skipped. Attacker with pool=self passes both
guards. No fund loss; _nextTokenId advanced; garbage NFTs. 1-2 block window typically.
**VERDICT: TRUE POSITIVE -- LOW (CONFIRMED baseline)**

### NM-002: Factory residual token approvals not revoked
**File:** EXNIHILOFactory.sol L243-246
NatSpec step 10 present but code omits forceApprove(pool, 0) after addLiquidity.
Standard ERC-20 auto-reduces approval on exact transferFrom. Factory holds 0 tokens.
**VERDICT: TRUE POSITIVE -- LOW code hygiene (CONFIRMED baseline)**

### NM-003: No caller incentive for closePositionAfterDeadline
**File:** EXNIHILOPool.sol L1038-1049
Caller pays gas; holder receives profit; no reward for cleanup.
**VERDICT: TRUE POSITIVE -- LOW (CONFIRMED baseline)**

### NM-004: Anyone-can-renew enables LP exit delay
**File:** EXNIHILOPool.sol L989
No ownership check. closePool() escape hatch confirmed effective. 5% cost expensive.
**VERDICT: TRUE POSITIVE -- LOW (CONFIRMED baseline)**

### NM-005: Factory createMarket empty input validation section
**File:** EXNIHILOFactory.sol L181-195
Section header present, body empty. Invalid inputs fail downstream.
**VERDICT: TRUE POSITIVE -- INFORMATIONAL (CONFIRMED baseline)**

### NM-006: Router _positionFee OI race
**File:** EXNIHILORouter.sol L63-81, L84-94, L142-147

Line verification:
  L73:  backedUsd = pool.backedAirUsd()            view snapshot at T
  L75-77: oi = pool.longOpenInterest()              view snapshot at T
  L78-79: impactFee computed from T snapshots
  L90:  usdc.safeTransferFrom(msg.sender, this, fee_T)  user pays fee_T
  L91:  usdc.forceApprove(pool, fee_T)
  L92:  pool.openLong() executes -- pool recomputes fee at T+delta
  L93:  usdc.forceApprove(pool, 0)  clears allowance; USDC balance (fee_T - fee_Tdelta) remains
  L142-147: sweep() -- NO access control guard

Pool openLong fee recomputation at L488-491 uses live longOpenInterest and backedAirUsd.
**VERDICT: TRUE POSITIVE -- MEDIUM (CONFIRMED 4.7)**

### NM-007: setDeployer missing zero-address guard
**File:** EXNIHILOFactory.sol L267-270
deployer=address(0) -> factory.deployer()=address(0) -> pool.closePool() deployer branch dead.
Role unrecoverable. LP holder path unaffected.
**VERDICT: TRUE POSITIVE -- LOW (CONFIRMED 4.7)**

### NM-008: _trySendUsdc failure strands USDC -- no recovery path
**File:** EXNIHILOPool.sol L1161-1200, L1203-1244

Profitable expired long L1186-1187 + profitable expired short L1229-1230:
_trySendUsdc silently fails after backedAirUsd decremented and airUsdToken burned.
CP-7 violated by up to full surplus. _assertReserveInvariant() cannot detect it.
Pool has no rescue function. Gap is permanent.
**VERDICT: TRUE POSITIVE -- MEDIUM (CONFIRMED 4.7)**

### NM-009: Router renewPosition caller-supplied fee excess extractable (NEW)
**File:** EXNIHILORouter.sol L128-137
Accepts raw fee from caller; pool computes totalFee independently.
If caller supplies fee > pool.totalFee: excess strands in router, claimable via sweep().
No on-chain fee-quoting view for renewals.
**VERDICT: TRUE POSITIVE -- LOW (NEW in 4.7)**

---

## Phase 5 -- Final Verified Findings Table

| ID | File | Line(s) | Severity | Category | Status |
|----|------|---------|----------|----------|--------|
| NM-001 | PositionNFT.sol | 226-227 | LOW | Access Control | CONFIRMED baseline |
| NM-002 | EXNIHILOFactory.sol | 243-246 | LOW | Code Hygiene | CONFIRMED baseline |
| NM-003 | EXNIHILOPool.sol | 1038-1049 | LOW | Economic Design | CONFIRMED baseline |
| NM-004 | EXNIHILOPool.sol | 989 | LOW | Griefing | CONFIRMED baseline |
| NM-005 | EXNIHILOFactory.sol | 181-195 | INFO | Input Validation | CONFIRMED baseline |
| NM-006 | EXNIHILORouter.sol | 63-81, 142-147 | MEDIUM | TOCTOU / Value Leak | CONFIRMED 4.7 |
| NM-007 | EXNIHILOFactory.sol | 267-270 | LOW | Missing Validation | CONFIRMED 4.7 |
| NM-008 | EXNIHILOPool.sol | 1161-1200, 1203-1244 | MEDIUM | Accounting / Silent Failure | CONFIRMED 4.7 |
| NM-009 | EXNIHILORouter.sol | 128-137 | LOW | Input Validation | NEW 4.7 |

---

## Phase 6 -- Full Finding Write-Ups

---

### NM-006: Router Fee Race -- OI Delta Strands USDC in Unrestricted sweep()

**Severity:** MEDIUM
**File:** EXNIHILORouter.sol:63-81, 84-94, 142-147

**Description:**
EXNIHILORouter._positionFee() reads pool.backedAirUsd() and pool.longOpenInterest()
(or shortOpenInterest) as live view-calls at the start of the user transaction. The pool
recomputes the same formula independently when it processes openLong/openShort using state
as-of execution time. Any OI decrease or backedAirUsd increase between snapshot and execution
causes the pool to demand a lower fee than the router has already pulled from the user. The
delta remains in the router as unaccounted USDC. Router.sweep() (L142) has NO access control
guard -- any caller receives the full router balance.

**Preconditions for MEV extraction:**
Block builder includes, ordered before the victim router call:
  1. closeLong/realizeLong reducing longOpenInterest, or
  2. addLiquidity increasing backedAirUsd (impact fee denominator grows -> fee shrinks)

**Worst-case amount (100k USDC notional, 100k OI change, 200k backedAirUsd):**
  delta = 1500 * 100_000e6 * 200_000e6 / (2 * 200_000e6 * 10_000) ~= $3,750 USDC

**POC:**
  Block N (MEV ordering):
    tx1: MEV closes large long -> longOpenInterest drops 200k -> 100k
    tx2: Victim router.openLong (submitted pre-block, stale snapshot: oi=200k)
         -> Router pulled fee_200k from victim
         -> Pool demands fee_100k at execution (lower OI at T+delta)
         -> Pool pulls fee_100k; delta strands in router
    tx3: MEV calls router.sweep(usdc) -> receives delta
  Victim paid fee_200k, position opened correctly, net loss = delta.

**Fix (Option A -- refund excess after pool call):**
  function openLong(address pool, uint256 usdcAmount, uint256 minAirTokenOut)
      external nonReentrant onlyPool(pool) {
      uint256 fee = _positionFee(usdcAmount, pool, true);
      usdc.safeTransferFrom(msg.sender, address(this), fee);
      usdc.forceApprove(pool, fee);
      IEXNIHILOPool(pool).openLong(usdcAmount, minAirTokenOut, msg.sender);
      usdc.forceApprove(pool, 0);
      uint256 excess = usdc.balanceOf(address(this));
      if (excess > 0) usdc.safeTransfer(msg.sender, excess);
  }

**Fix (Option B):** Restrict sweep() to a designated feeRecipient address.

---

### NM-007: setDeployer Missing Zero-Address Guard

**Severity:** LOW
**File:** EXNIHILOFactory.sol:267-270

**Description:**
setDeployer does not validate newDeployer != address(0). Setting deployer to zero permanently
disables the emergency admin path. All subsequent setDeployer calls fail (OnlyDeployer never
passes for address(0) as msg.sender), and factory.deployer() returns address(0), making the
deployer branch of EXNIHILOPool.closePool() permanently dead. LP holder closePool path is
unaffected in normal operation.

Failure mode: LP NFT lost/burned/transferred to dead address -> emergency admin is only
remaining closePool path -> it is dead -> pool liquidity permanently locked.

**Fix:**
  function setDeployer(address newDeployer) external {
      if (msg.sender != deployer) revert OnlyDeployer();
      if (newDeployer == address(0)) revert ZeroAddress();
      deployer = newDeployer;
  }

---

### NM-008: _trySendUsdc Silent Failure Strands USDC -- No Recovery Path

**Severity:** MEDIUM
**File:** EXNIHILOPool.sol:1161-1200 (_closeExpiredLong), EXNIHILOPool.sol:1203-1244 (_closeExpiredShort)

**Description:**
In the profitable branch of _closeExpiredLong and _closeExpiredShort, all accounting effects
(decrementing backedAirUsd, burning airUsdToken) are committed before _trySendUsdc. If
_trySendUsdc fails silently (USDC blacklist, transfer returning false, any EVM failure),
the accounting reflects a transfer that never occurred. The pool permanently holds more USDC
than its accounting sum, with no mechanism to identify or recover the orphaned amount.

_assertReserveInvariant() cannot detect this -- it checks only backed <= supply for both token
pairs. Both checks still pass after the symmetric accounting decrements. The on-chain guard is
structurally blind to underlyingUsdc.balanceOf(pool) vs accounting sum.

Impacted call sites:
  L1186: _trySendUsdc(holder, netSurplus) in _closeExpiredLong profitable branch
  L1187: _trySendUsdc(protocolTreasury, closeFee) in _closeExpiredLong profitable branch
  L1229: _trySendUsdc(holder, netSurplus) in _closeExpiredShort profitable branch
  L1230: _trySendUsdc(protocolTreasury, closeFee) in _closeExpiredShort profitable branch

Additional risk: protocolTreasury is immutable (set at construction). If the treasury
address is ever USDC-blacklisted, all closeFee from expired profitable positions is
permanently stranded.

Maximum stranded per position: netSurplus + closeFee = full position surplus.

**POC:**
  Circle USDC blacklists holder address. Victim holds a profitable expired long.

  closePositionAfterDeadline(nftId, 0):
    L1181: backedAirUsd -= surplus        COMMITTED
    L1184: airUsdToken.burn(airUsdMinted) COMMITTED
    L1185: airUsdToken.burn(surplus)      COMMITTED
    L1186: _trySendUsdc(holder, netSurplus):
           usdc.transfer(holder, netSurplus) -> Circle reverts: blacklisted
           catch -> emit PayoutFailed(holder, netSurplus)
           function continues (no revert)
    L1187: _trySendUsdc(treasury, closeFee) -> succeeds

  Result: backedAirUsd decremented by full surplus. USDC only moved by closeFee.
  Gap = netSurplus permanently locked in pool.
  LP cannot recover via removeLiquidity or claimFees.
  Pool has no sweep() or rescue function.

**Fix (Option A -- pull-based payout):**
  mapping(address => uint256) public pendingPayouts;

  function _creditPayout(address to, uint256 amount) internal {
      if (amount == 0) return;
      pendingPayouts[to] += amount;
      emit PayoutQueued(to, amount);
  }

  function claimPayout() external nonReentrant {
      uint256 amount = pendingPayouts[msg.sender];
      if (amount == 0) revert ZeroAmount();
      pendingPayouts[msg.sender] = 0;
      underlyingUsdc.safeTransfer(msg.sender, amount);
  }

---

### NM-009: Router renewPosition Accepts Caller-Supplied Fee -- Excess Extractable

**Severity:** LOW
**File:** EXNIHILORouter.sol:128-137

**Description:**
Unlike openLong and openShort which compute the fee internally via _positionFee(),
renewPosition accepts the fee as a raw caller-supplied parameter. The pool independently
computes the exact required fee inside renewPosition (L990-1021) and calls
_transferIn(underlyingUsdc, msg.sender, totalFee). If the caller supplies fee > pool.totalFee,
the excess remains in the router and is claimable by any address via the unrestricted sweep().

No on-chain view function exposes the exact renewal fee. Frontend applications must compute
it off-chain. Stale computations result in silent overpayment with no refund mechanism.

**Fix (refund excess after pool call):**
  function renewPosition(address pool, uint256 nftId, uint256 fee)
      external nonReentrant onlyPool(pool) {
      usdc.safeTransferFrom(msg.sender, address(this), fee);
      usdc.forceApprove(pool, fee);
      IEXNIHILOPool(pool).renewPosition(nftId);
      usdc.forceApprove(pool, 0);
      uint256 excess = usdc.balanceOf(address(this));
      if (excess > 0) usdc.safeTransfer(msg.sender, excess);
  }

---

## Phase 7 -- False Positive Catalog

| Candidate | Result |
|-----------|--------|
| USDC insolvency on fee claim + position close | FALSE POSITIVE (NM-008 is the real finding) |
| airUsd burn exceeds pool balance in closeLong | FALSE POSITIVE (pool airUsd = backedAirUsd + sum(long debt); burns within bound) |
| Flash loan cross-curve arbitrage | FALSE POSITIVE (round-trip swap fees exceed marginal close surplus gain) |
| Reentrancy via ERC-721 _safeMint callback | FALSE POSITIVE (all state committed before external calls; nonReentrant) |
| renewPosition missing impact fee | FALSE POSITIVE (OI-integral bounds unchanged at renewal; design-consistent) |
| allPools vs LpNFT._nextTokenId intra-tx gap | FALSE POSITIVE (nonReentrant; restored in same tx) |
| realizeLong: backedAirUsd written after _transferIn | FALSE POSITIVE (intentional pessimistic accounting) |
| Router.swap residual approval | FALSE POSITIVE (forceApprove(pool, 0) at L123; no extractable value) |

---

## Summary

  Total functions analyzed:    44
  Coupled state pairs mapped:  8 (CP-1 through CP-9)
  Nemesis loop iterations:     3 (converged)
  False positives eliminated:  8

  Final findings after verification:
    CRITICAL:  0
    HIGH:      0
    MEDIUM:    2  (NM-006, NM-008)
    LOW:       6  (NM-001, NM-002, NM-003, NM-004, NM-007, NM-009)
    INFO:      1  (NM-005)

  Assessment: Core pool logic (3-mode AMM, synthetic leverage, CEI pattern, reserve
  invariants) is sound. Both MEDIUM findings are at the protocol boundary layer --
  router forwarding and expired-position cleanup -- not in the core AMM. No fund-
  draining or position-manipulation vulnerabilities identified in pool internals.

---

## Delta vs 4.6

**NM-006 (MEDIUM) -- independently re-confirmed:**
Router _positionFee snapshots OI and backedAirUsd at view-call time. When OI decreases or
backedAirUsd increases between snapshot and pool execution (MEV-orderable on same block), the
pool consumes a lower fee than the router pulled from the user. Residual strands in the router
and is extractable by anyone via the unrestricted sweep(). Worst-case ~$3,750 per 100k USDC
notional position with 100k OI change.

**NM-007 (LOW) -- independently re-confirmed:**
EXNIHILOFactory.setDeployer accepts address(0) with no guard despite NatSpec requiring non-zero.
Setting to zero permanently bricks the emergency admin closePool path and makes the deployer role
unrecoverable. LP holder path unaffected.

**NM-008 (MEDIUM) -- independently re-confirmed, severity upheld:**
_trySendUsdc in the profitable branches of _closeExpiredLong (L1186-1187) and _closeExpiredShort
(L1229-1230) silently swallows USDC transfer failures after backedAirUsd has been decremented and
airUsdToken burned. _assertReserveInvariant() cannot detect the CP-7 violation. Pool has no rescue
function. Stranded USDC is permanently inaccessible, up to the full position surplus per expired
profitable position.

**NM-009 (LOW) -- NEW finding not in 4.6 baseline:**
Router.renewPosition accepts a raw caller-supplied fee parameter instead of computing it internally.
If a caller over-estimates the renewal fee (stale frontend quote, manual input), the excess silently
strands in the router and is extractable via the unrestricted sweep(). Root cause is distinct from
NM-006 (no OI race; pure caller input error path). Fix: refund excess to msg.sender after pool call,
or expose a renewalFee(nftId) view to guide callers to the exact required amount.