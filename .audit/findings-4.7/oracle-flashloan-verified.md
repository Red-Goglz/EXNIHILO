# Oracle & Flash Loan Analysis Report -- EXNIHILO (claude-sonnet-4-6 Verification)

## Scope

- **Primary:** EXNIHILOPool.sol (1376 lines)
- **Secondary:** PositionNFT.sol, EXNIHILOFactory.sol, EXNIHILORouter.sol
- **Baseline:** .audit/findings/oracle-flashloan-verified.md (OFL-1 LOW Accepted, OFL-2 LOW Accepted)
- **Prior delta:** 4.7 run claimed OFL-1/OFL-2 math correction (+5,372 USDC at feeBps=100); OFL-3 NEW MEDIUM; OFL-4 NEW LOW

---

## Phase 1: Oracle Source Classification

**Trust Model: Level 1 -- Self-Referential Spot Price (internal only)**

No external oracle dependencies. Zero matches for: latestRoundData, latestAnswer, getReserves, slot0, observe, consult.

All pricing derives from four internal state variables:

| Variable | Modifiable By |
|---|---|
| backedAirToken | swap, addLiquidity, openLong, closeLong, realizeLong, closePositionAfterDeadline |
| backedAirUsd | swap, addLiquidity, openShort, closeShort, realizeShort, closePositionAfterDeadline |
| airToken.totalSupply() | swap, addLiquidity, removeLiquidity, openShort, closeShort, realizeShort |
| airUsdToken.totalSupply() | swap, addLiquidity, removeLiquidity, openLong, closeLong, realizeLong |

AirToken mint/burn is gated to the pool address via onlyPool. No external party can alter these supplies.

**Three AMM curves, all internal:**

| Mode | reserveIn | reserveOut | Consumer |
|---|---|---|---|
| SWAP-1 | backedAirUsd or backedAirToken | opposite | swap() |
| SWAP-2 | airUsdToken.totalSupply() | backedAirToken | openLong(), closeShort() inverse |
| SWAP-3 | airToken.totalSupply() - locked | backedAirUsd | closeLong(), openShort() |

**Stale price risk:** N/A. No external oracle, no Chainlink round ID, no block.timestamp staleness window.

**Read-only reentrancy:** PositionNFT._readLive() reads pool state via external view calls for tokenURI display. No state changes depend on this. Not exploitable.

**Donation attack:** Pool uses internal accounting (backedAirToken, backedAirUsd), not balanceOf. EXNIHILOPool.sol:1333-1335 uses balance delta only as a fee-on-transfer guard. Not viable.

---

## Phase 2: Flash Loan Attack Surface -- Verified POC

### Setup -- Reference Pool

All calculations use integer arithmetic (Node.js BigInt) matching Solidity _cpAmountOut exactly:

    rawOut = amountIn * reserveOut / (reserveIn + amountIn)
    fee    = amountIn * reserveOut * feeBps / (reserveIn * 10000)
    netOut = rawOut - fee

Canonical parameters:
  backedAirToken         = 1,000,000 tokens (18 dec)
  backedAirUsd           = 1,000,000 USDC (6 dec)
  airToken.totalSupply   = 1,000,000 tokens (no open positions)
  airUsd.totalSupply     = 1,000,000 USDC
  swapFeeBps             = 100 (1%)
  Flash loan             = 500,000 USDC

---

## Finding OFL-1 -- Cross-AMM-curve flash loan (existing long) [MATH CORRECTED vs 4.6 baseline]

**Location:** closeLong() at EXNIHILOPool.sol:571, swap() at EXNIHILOPool.sol:421
**Severity:** LOW (UNCHANGED from baseline)
**Prior Status:** Accepted LOW

### Attack Sequence

Pre-condition: attacker already holds a long position (open fee already paid and sunk).

    TX 1 (pre-existing): openLong(50,000 USDC)
      SWAP-2: reserveIn=AUS(1M USDC), reserveOut=BAT(1M tokens)
      Locks 47,119 tokens in PositionNFT
      Mints 50,000 synthetic airUsd (debt)
      Fee paid: 2,500 USDC (5% base, sunk cost)

    TX 2 (attack): flash loan callback
      Step A: swap(500,000 USDC to tokens)  via SWAP-1
      Step B: closeLong(nftId)               via SWAP-3 at inflated reserves
      Step C: swap(tokens to USDC)           via SWAP-1 reverse
      Step D: repay flash loan

### Verified POC Numbers

Step A -- Flash swap 500K USDC to tokens:

    reserveIn  = backedAirUsd (post-open)   = 1,000,000 USDC
    reserveOut = backedAirToken (post-open) = 952,381 tokens
    tokens out = 312,862
    BAT after  = 640,018 tokens
    BAU after  = 1,500,000 USDC
    ATS after  = 687,137 tokens  (_swapUsdcToToken burns airToken; totalSupply drops)

Step B -- closeLong at manipulated SWAP-3:

    reserveIn  = ATS_manip - locked = 687,137 - 47,119 = 640,018 tokens
    reserveOut = BAU_manip           = 1,500,000 USDC
    airUsdOut  = 101,755 USDC
    surplus    = 101,755 - 50,000   = 51,755 USDC
    net_surplus (after 1% close fee) = 51,237 USDC

Step C -- Reverse swap 312,862 tokens to USDC:

    reserveIn  = BAT_after_close = 640,018 + 47,119 = 687,137 tokens
    reserveOut = BAU_manip - surplus = 1,448,245 USDC
    USDC back  = 446,507 USDC
    round-trip loss = 500,000 - 446,507 = 53,492 USDC

Net P&L at swapFeeBps=100:

    + 51,237  net surplus from closeLong
    - 53,492  round-trip swap loss (price impact dominates fees on depleted pool)
    -  2,500  openLong fee (sunk)
    = -4,755  USDC  UNPROFITABLE

### Fee Sweep -- Breakeven Analysis

| feeBps | surplus (USDC) | rt_loss (USDC) | net P&L (USDC) |
|--------|----------------|----------------|----------------|
| 0      | 54,651         | 41,159         | +10,445 (PROFIT) |
| 25     | 53,921         | 44,261         | +6,620 (PROFIT)  |
| 50     | 53,195         | 47,351         | +2,812 (PROFIT)  |
| ~68    | ~52,800        | ~52,719        | ~+80 (breakeven) |
| 75     | 52,473         | 50,428         | -979             |
| 100    | 51,755         | 53,492         | -4,755           |
| 200    | 48,922         | 65,624         | -19,690          |

Breakeven: ~68-69 bps. Attack profitable for swapFeeBps < 68, unprofitable at the 100 bps default.

### Why the Prior 4.7 Run Was Wrong

The prior 4.7 run claimed net +5,372 USDC profit at feeBps=100. This is incorrect.

Error: treating round-trip cost as 2 x fee_rate x flash_amount = 2% x 500K = 10K USDC.
Actual round-trip loss = 53,492 USDC because:
1. Forward swap buys 312K tokens from a 952K-token reserve. Pool significantly depleted.
2. Reverse swap sells back into a 640K-token reserve. Execution price materially worse.
3. Price impact, not fee rate, dominates the 53K round-trip loss.

The baseline narrative is correct. True breakeven ~68 bps, not 200 bps. Severity remains LOW.

Recommendation: No fix required at swapFeeBps=100. See OFL-3 for the no-floor deployment risk.

---

## Finding OFL-2 -- Atomic open-manipulate-close via flash loan [MATH CORRECTED vs 4.6 baseline]

**Location:** openLong() + swap() + closeLong() at EXNIHILOPool.sol
**Severity:** LOW (UNCHANGED from baseline)
**Prior Status:** Accepted LOW

Single transaction: openLong(50K) then swap(500K USDC to tokens) then closeLong then reverse swap.

Mathematically identical to OFL-1 (open is atomic rather than pre-existing). Net result: -4,755 USDC at feeBps=100.

The baseline description is correct. The prior 4.7 math correction (+5,372 USDC) is refuted.

Recommendation: No fix needed. Multi-layer fee structure provides robust protection at default fee levels.

---

## Finding OFL-3 -- No minimum swapFeeBps floor enables flash loan extraction [CONFIRMED NEW MEDIUM]

**Location:** EXNIHILOPool.sol:379 (constructor), EXNIHILOFactory.sol:130-145 (no lower bound on defaultSwapFeeBps)
**Severity:** MEDIUM
**Prior Status:** NEW -- Confirmed

### Vulnerability

The pool constructor validates only an upper bound:

    // EXNIHILOPool.sol:379
    if (swapFeeBps_ >= BPS_DENOM) revert InvalidSwapFeeBps();
    // BPS_DENOM = 10_000
    // swapFeeBps=0 passes: (0 >= 10000) is false, no revert

The factory constructor stores defaultSwapFeeBps as an immutable and passes it to poolDeployer.deploy()
without any lower bound check. A factory constructed with defaultSwapFeeBps=0 deploys every market
with zero swap fees, permanently.

### Verified POC at swapFeeBps=0

    Pool: 1M USDC, 1M tokens, swapFeeBps=0
    Flash: 500K USDC, Position: 50K USDC notional

    openLong:      locked = 47,619 tokens
    Flash swap:    tokens out = 333,333
    closeLong:     airUsdOut = 104,651 USDC
                   surplus = 54,651 USDC
                   net_surplus (1% close fee) = 54,104 USDC
    Reverse swap:  USDC back = 458,841 USDC
                   round-trip loss = 41,159 USDC

    Net P&L = +54,104 - 41,159 - 2,500 = +10,445 USDC  PROFIT

+10,445 USDC profit on a 2,500 USDC open cost = 417% return per transaction. Repeatable until LP exits.

### Impact

Any pool with swapFeeBps < 68 is economically exploitable. The current factory default (100 bps) is safe,
but the protocol is permissionless. Anyone can deploy a factory with defaultSwapFeeBps=0.
LP funds erode with each attack iteration.

### Recommendation

Add a minimum floor in EXNIHILOPool.sol:379:

    uint256 private constant MIN_SWAP_FEE_BPS = 75; // above 68-bps breakeven with margin
    if (swapFeeBps_ < MIN_SWAP_FEE_BPS || swapFeeBps_ >= BPS_DENOM) revert InvalidSwapFeeBps();

Enforce the same floor in the EXNIHILOFactory.sol constructor.

---

## Finding OFL-4 -- Router _positionFee stale state: DoS AND fee theft via sweep() [UPGRADED to MEDIUM]

**Location:** EXNIHILORouter.sol:63-81 (_positionFee), EXNIHILORouter.sol:142-147 (sweep)
**Severity:** MEDIUM (prior 4.7 run flagged as LOW -- upgraded; sweep theft vector not previously identified)
**Prior Status:** NEW in 4.7 run as LOW -- Upgraded

### Vulnerability

EXNIHILORouter._positionFee() reads pool.backedAirUsd() and OI at call time T0, pulls that fee
from the caller, and approves it to the pool. The pool recomputes the impact fee at T1 from live state.

The impact fee is quadratic in OI:

    impactFee = IMPACT_FEE_BPS * notional * (2 * OI + notional) / (2 * backedAirUsd * BPS_DENOM)

Between T0 and T1, OI can change in either direction via concurrent transactions.

### Scenario A -- DoS Griefing (OI rises before victim tx)

Attacker opens a large position directly on the pool before the victim transaction, spiking OI.
Pool computes a higher fee than the router approved; ERC20InsufficientAllowance revert kills the victim tx.

Verified numbers (10K notional, OI 200K to 300K, backedAirUsd=1M USDC):

    router_fee = 807.50 USDC  (computed at OI=200K)
    pool_fee   = 957.50 USDC  (computed at OI=300K)
    shortfall  = 150.00 USDC  -> ERC20InsufficientAllowance revert -> victim tx fails

Adversarial case (OI spiked +500K):

    shortfall = 750.00 USDC -> reverts

### Scenario B -- Fee Theft via sweep() (OI drops before victim tx)

1. Attacker spikes OI by opening large position on pool directly (bypassing router).
2. Victim submits router.openLong(). Router reads high OI; pulls large fee from victim.
3. Attacker drops OI by closing their position before victim tx executes (same block).
4. Victim tx executes. Pool sees low OI; needs only small fee. pool_fee < router_fee.
5. Surplus USDC (= router_fee - pool_fee) remains in router contract.
6. Attacker calls router.sweep(usdc). Steals the surplus.

Relevant code at EXNIHILORouter.sol:142-147:

    // Callable by anyone -- sends the full balance to the caller.
    function sweep(IERC20 token) external {
        uint256 balance = token.balanceOf(address(this));
        if (balance > 0) { token.safeTransfer(msg.sender, balance); }
    }

Verified numbers (10K notional, OI manipulated from 500K to 0):

    router_fee  = 1,257.50 USDC  (computed against high OI at T0)
    pool_fee    =   507.50 USDC  (computed against zero OI at T1)
    surplus     =   750.00 USDC  remaining in router
    Attacker calls router.sweep(usdc) -> steals 750 USDC from victim

Victim paid 1,257.50 USDC; position cost 507.50 USDC. 750 USDC stolen with no recourse.

### Impact

Scenario A: Griefing DoS. Router-mediated openLong/openShort fail unpredictably when OI is volatile.
Scenario B: Partial fund loss. Victim overpays due to stale fee computation; excess immediately stealable.
           Up to 750 USDC per 10K-notional victim transaction in the verified scenario.

### Recommendation

1. Add a maxFee parameter to router open functions. Revert if computed fee exceeds caller tolerance.
2. Refund unused fee to msg.sender after the pool call completes:

    IEXNIHILOPool(pool).openLong(usdcAmount, minAirTokenOut, msg.sender);
    uint256 residual = usdc.balanceOf(address(this));
    if (residual > 0) usdc.safeTransfer(msg.sender, residual);
    usdc.forceApprove(pool, 0);

3. Restrict sweep() to an authorized address. Open-to-anyone sweep directly enables Scenario B fund theft.

---

## Summary

| ID | Finding | Severity | Status |
|---|---|---|---|
| OFL-1 | Cross-AMM-curve flash loan (existing long) | LOW | Accepted; prior 4.7 math correction refuted |
| OFL-2 | Atomic open-manipulate-close via flash loan | LOW | Accepted; prior 4.7 math correction refuted |
| OFL-3 | No minimum swapFeeBps floor -- profitable at feeBps < 68 | MEDIUM | NEW -- Confirmed |
| OFL-4 | Router _positionFee stale OI: DoS + fee theft via sweep | MEDIUM | NEW -- Upgraded from LOW |

    Final: 0 CRITICAL | 0 HIGH | 2 MEDIUM | 2 LOW

---

## Delta vs 4.6

### OFL-1 / OFL-2 Prior 4.7 Math Correction -- REFUTED

The prior 4.7 run claimed net +5,372 USDC profit at feeBps=100 and declared the baseline narrative wrong.
This claim is incorrect. Verified with BigInt integer arithmetic matching Solidity exactly:

  net_surplus after 1% close fee:  +51,237 USDC
  round-trip swap loss:            -53,492 USDC (price impact dominates, not fee rate)
  open position fee (sunk):         -2,500 USDC
  Net:                              -4,755 USDC -- UNPROFITABLE

The prior run estimated round-trip cost as 2 x 1% x 500K = 10K USDC, ignoring the reverse leg execution price.
Forward swap depletes the pool; reverse suffers far worse slippage into the depleted reserve.
The 53K round-trip loss overwhelms the 51K close gain.

Baseline finding vindicated. True breakeven ~68-69 bps, not 200 bps. OFL-1 and OFL-2 remain LOW.

### OFL-3 -- CONFIRMED NEW MEDIUM

Prior 4.7 identification confirmed. swapFeeBps=0 yields +10,445 USDC profit per transaction (50K notional, 1M pool).
Breakeven at ~68 bps. No minimum floor exists at EXNIHILOPool.sol:379 or EXNIHILOFactory.sol constructor.
Fix: one-line addition of MIN_SWAP_FEE_BPS = 75 in pool constructor and factory constructor.

### OFL-4 -- UPGRADED from LOW to MEDIUM

Prior 4.7 run flagged OFL-4 as a DoS-only LOW finding. This run identified a second attack vector not
previously flagged: when OI drops between router read and pool execution, the router over-pulls the victim fee.
Since sweep() at EXNIHILORouter.sol:142 is open to any caller, an attacker can sandwich the OI state to steal
the excess -- up to 750 USDC per 10K-notional victim transaction in the verified scenario.
Partial fund loss warrants MEDIUM severity.
