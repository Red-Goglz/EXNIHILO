// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @dev Position data structure shared between PositionNFT and the pool.
 *      Declared at file level so both the interface and the pool can reference
 *      it without import gymnastics.
 *
 *      Fields used per side:
 *        Long  — lockedAmountAtOpen = airTokenLocked (airToken units),
 *                usdcIn, airUsdMinted, feesPaid
 *        Short — lockedAmountAtOpen = airUsdLocked (airUsd units),
 *                usdcIn, airTokenMinted, feesPaid
 *
 *      Every amount here is as it stood the moment the position was minted,
 *      and none is the live figure: funding shrinks every position on a side
 *      by the same factor — collateral, debt and notional together — so each
 *      of them now stands at
 *
 *        atOpen * fundingIndex(side) / fundingIndexAtOpen
 *
 *      `lockedAmountAtOpen` is deliberately awkwardly named, and the debt and
 *      notional fields decay the same way. Every consumer must go through
 *      EXNIHILOPool.liveAmountsOf() or effectiveLocked(); a bare read of any of
 *      them is a stale number.
 */
struct Position {
    bool    isLong;
    address pool;
    uint256 lockedAmountAtOpen;
    uint256 usdcIn;
    uint256 airUsdMinted;
    uint256 airTokenMinted;
    uint256 feesPaid;
    uint256 openedAt;
    uint256 fundingIndexAtOpen;
}

/**
 * @dev Minimal interface to PositionNFT — only what EXNIHILOPool calls.
 */
interface IPositionNFT {
    function mintLong(
        address to,
        address pool,
        uint256 usdcIn,
        uint256 airUsdMinted,
        uint256 airTokenLocked,
        uint256 feesPaid,
        uint256 fundingIndexAtOpen
    ) external returns (uint256 tokenId);

    function mintShort(
        address to,
        address pool,
        uint256 airTokenMinted,
        uint256 airUsdLocked,
        uint256 usdcIn,
        uint256 feesPaid,
        uint256 fundingIndexAtOpen
    ) external returns (uint256 tokenId);

    function release(uint256 tokenId) external returns (Position memory);

    function getPosition(uint256 tokenId) external view returns (Position memory);

    function ownerOf(uint256 tokenId) external view returns (address);
}

/**
 * @dev Minimal interface to LpNFT — pool only needs ownerOf.
 */
interface ILpNFT {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/**
 * @dev Minimal interface to EXNIHILOFactory — pool reads the emergency deployer.
 */
interface IEXNIHILOFactory {
    function deployer() external view returns (address);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXNIHILOPool
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @title  EXNIHILOPool
 * @author EXNIHILO
 * @notice Single-market AMM pool for the EXNIHILO "Out of Thin Air" trade
 *         platform. One pool is created per token/USDC market by the factory.
 *
 * ── AMM Modes ────────────────────────────────────────────────────────────────
 *
 *   x and y denote the two pool RESERVES (not trade direction — either side
 *   can be input or output depending on the operation).
 *
 *   SWAP-1  Normal swap          x = backedAirToken,     y = backedAirUsd
 *   SWAP-2  Long-open/Short-close x = backedAirToken,    y = airUsdSupply
 *   SWAP-3  Short-open/Long-close x = airTokenSupply,    y = backedAirUsd
 *
 *   All three modes use the standard constant-product formula:
 *     amountOut = amountIn * reserveOut / (reserveIn + amountIn)
 *
 * ── Reserve Accounting ───────────────────────────────────────────────────────
 *
 *   airToken / airUsd are pure accounting units (no ERC-20 exists for them).
 *   Each side is fully described by two counters:
 *
 *   airTokenSupply  Total airToken units in existence (backed + synthetic +
 *                  locked in positions). The SWAP-3 virtual reserve.
 *   airUsdSupply   Same for the airUsd side. The SWAP-2 virtual reserve.
 *
 *   backedAirToken  Tracks the amount of airToken that has real underlying token
 *                  collateral behind it.  Increases on LP deposits and on token
 *                  swaps-in; decreases on token swaps-out and on openLong
 *                  (collateral locked against the position).
 *
 *   backedAirUsd   Same for the airUsd / USDC side.  Increases on LP deposits
 *                  and USDC swaps-in; decreases on USDC swaps-out and on
 *                  openShort (collateral locked against the position).
 *
 *   Synthetic mints (openLong mints airUsd, openShort mints airToken) do NOT
 *   touch the backed reserves — they inflate the supply counters only.
 *
 *   Collateral locked in a position stays counted in the supply counters
 *   (it exists, it is just out of circulation); settlement math subtracts
 *   the position's effective locked collateral from the relevant supply where required.
 *
 * ── Fee Structure ────────────────────────────────────────────────────────────
 *
 *   All AMM modes:    swapFeeBps (a fixed 1 %) applied to SWAP-1, SWAP-2, and
 *                     SWAP-3 via _cpAmountOut. Fee is computed on the SPOT VALUE
 *                     of the input: fee = amountIn * reserveOut/reserveIn * feeBps.
 *                     This gives a true percentage-of-notional fee regardless of
 *                     trade size. Fee stays in pool as passive LP yield.
 *   Position open:    5 % flat on USDC notional + quadratic impact fee.
 *                       4 % → accrues to lpFeesAccumulated
 *                       1 % → accrues to protocolFeesAccumulated
 *                     All fees are PULL payments: the LP NFT holder claims via
 *                     claimFees(to), the treasury via claimProtocolFees(to).
 *                     No pool operation ever pushes USDC to a third party, so
 *                     no recipient (e.g. a USDC-blacklisted address) can block
 *                     or grief any pool operation.
 *                       Impact fee = 1500 × N × (2×OI+N) / (2 × backedAirUsd × 10000) → LP
 *                       OI-integral formula: split-proof, scales with cumulative OI.
 *
 * ── Security ─────────────────────────────────────────────────────────────────
 *
 *   - ReentrancyGuard  on every state-changing external function.
 *   - CEI pattern      throughout: state written before any external call.
 *   - Reserve invariant: backedAirToken ≤ airTokenSupply and vice versa,
 *                        checked after every operation that touches backed reserves.
 *   - Slippage guards  (minAmountOut) on swap, openLong, openShort.
 */
contract EXNIHILOPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Constants ─────────────────────────────────────────────────────────────

    uint256 private constant BPS_DENOM        = 10_000;
    uint256 private constant LP_FEE_BPS       = 400;   // 4 % of notional → LP
    uint256 private constant PROTOCOL_FEE_BPS = 100;   // 1 % of notional → protocol
    /// @dev Minimum position open fee in USDC (6 dec). Applies when 5 % of notional
    ///      would be less than this floor. Split 1/5 protocol, 4/5 LP.
    uint256 private constant MIN_POSITION_FEE = 50_000; // 0.05 USDC
    /// @dev 1 % of profit taken by the protocol on closeLong / closeShort.
    uint256 private constant CLOSE_FEE_BPS    = 100;   // 1 % of surplus → protocol
    /// @dev Impact fee scaling factor. Uses OI-based integral formula:
    ///        impactFee = IMPACT_FEE_BPS × N × (2×OI + N) / (2 × backedAirUsd × BPS_DENOM)
    ///      where OI = same-side open interest before this position.
    ///      Split-proof: the integral from OI=0 to OI=N is identical whether computed
    ///      as one position or many smaller ones.
    ///      All impact fee revenue goes to the LP to compensate for price distortion.
    uint256 private constant IMPACT_FEE_BPS   = 1500;  // 15 % impact scaling rate

    /// @notice Swap fee in bps applied to all AMM modes (SWAP-1, SWAP-2, SWAP-3).
    ///
    /// @dev A constant rather than a per-pool parameter. It was configurable, and
    ///      floored at this same 1 % — because a permissionless factory would
    ///      otherwise allow `swapFeeBps = 0`, removing the economic friction that
    ///      makes atomic manipulation (open → move price → close) unprofitable.
    ///      Every pool ever deployed took the floor, so the parameter only ever
    ///      offered a way to get it wrong: a market creator could raise the fee
    ///      on traders after the fact was never possible, but a factory deployed
    ///      with a high `defaultSwapFeeBps` would have silently taxed every pool
    ///      it created. Fixing it removes the lever and the migration surface,
    ///      and lets `_cpAmountOut` read the value without a storage load.
    uint256 public constant swapFeeBps = 100;   // 1 %

    /// @dev Per-position size cap, as a fraction of backedAirUsd, ramping
    ///      linearly from CAP_START_BPS at creation to CAP_MAX_BPS after
    ///      CAP_RAMP_DURATION.
    ///
    ///      A brand-new market is the most dangerous moment to allow size: the
    ///      price has no history, depth is whatever the creator seeded, and a
    ///      single large position can dominate the book before anyone can react.
    ///      Starting at 1 % and widening to 20 % over a day lets the market prove
    ///      itself before it accepts real size, with no parameter for anyone to
    ///      get wrong and no lever for the LP to pull afterwards.
    uint256 private constant CAP_START_BPS     = 100;    // 1 % of backedAirUsd
    uint256 private constant CAP_MAX_BPS       = 2_000;  // 20 % of backedAirUsd
    uint256 private constant CAP_RAMP_DURATION = 24 hours;

    /// @dev Funding. A position posts no margin — the open fee is the whole of
    ///      what the trader pays up front, and the collateral locked against it
    ///      is the LP's own. What the holder receives is therefore an option the
    ///      LP wrote, and with no expiry that option's value to the holder is
    ///      unbounded unless its premium is charged continuously.
    ///
    ///      Funding is that charge. Every second, each side is shrunk by a fixed
    ///      FRACTION d — collateral, synthetic debt and notional together — as if
    ///      that fraction of every position on the side were closed with its
    ///      payout kept by the pool:
    ///
    ///        Long   totalLongCollateral  -= d*C ; backedAirToken += d*C
    ///               longOpenInterest     -= d*D ; airUsdSupply   -= d*D
    ///        Short  totalShortCollateral -= d*C ; backedAirUsd   += d*C
    ///               totalShortDebt       -= d*D ; airTokenSupply -= d*D
    ///               shortOpenInterest    -= d*N
    ///
    ///      That is the underwater branch of _settle applied to a slice: the
    ///      collateral returns to the LP and the debt it was locked against is
    ///      cancelled. No swap is executed, so no swap fee is charged, and
    ///      nothing becomes claimable — whatever the slice was worth lands in
    ///      reserves the LP already owns. Only the open fee and the close fee
    ///      accrue to lpFeesAccumulated.
    ///
    ///      Multiplicative, not additive, and that is the load-bearing choice.
    ///      An additive debt (the usual perp `owed = N * dIndex`) can exceed
    ///      what the position holds, which creates bad debt and forces a
    ///      liquidation path with a bounty to pay for it. A fraction of what is
    ///      actually there is always collectible and can never drive a claim
    ///      below zero, so there is nothing to liquidate and no keeper to fund.
    ///
    ///      It is also what lets the whole book decay from a single number per
    ///      side. Every position on a side takes the same factor, so one index
    ///      serves all of them and no position is ever touched between open and
    ///      close. See fundingIndexLong / _accrueFunding.
    ///
    ///      What a holder pays is the slice itself. Collateral and debt shrink
    ///      in step, so a position keeps its break-even price and simply gets
    ///      smaller: a winner gives up `d` of its profit, a flat or losing
    ///      position `d` of its upside. Nothing is priced to do it, so there is
    ///      no spot read at accrual time for anyone to manipulate.
    ///
    ///      Shrinking the debt with the collateral is also what lets the book
    ///      heal on its own. Debt that outlived its collateral would go on
    ///      inflating the supply counters and open interest until someone swept
    ///      the position; decaying it in step means a decayed position stops
    ///      distorting the curves, the impact fee and the funding rate.
    ///
    ///      Price effect, in terms of the pool's own views:
    ///        Long funding   backedAirToken up, airUsdSupply down
    ///                         =>  spotPrice down, longPrice down
    ///        Short funding  backedAirUsd up, airTokenSupply down
    ///                         =>  spotPrice up,   shortPrice up
    ///      Each side moves the prices that contain its own reserves, against
    ///      itself — funding is a slow-motion version of that side's own close,
    ///      and it prices like one.
    uint256 private constant RAY = 1e27;

    /// @dev Funding rate, as bps of the position per FUNDING WINDOW:
    ///
    ///        ratePerWindow = FUNDING_BASE_BPS + FUNDING_UTIL_BPS * utilization
    ///        utilization   = sameSideOpenInterest / backedAirUsd
    ///
    ///      Priced against what the position is, not inherited from the renewal
    ///      fee it replaced. A position is a perpetual at-the-money option that
    ///      cannot be liquidated and loses at most its premium, so holding one
    ///      has to cost more than a perp's funding. At a mature market's 30-day
    ///      window the base term takes ~0.33 % of the position a day — roughly
    ///      what a perpetual option on a major pays at 100 % implied volatility —
    ///      and a young market, where volatility is highest, pays many times
    ///      that. The utilization term prices crowding on top: a side whose open
    ///      interest equals the pool's depth pays three times the base.
    ///
    ///      Funding shrinks the whole position rather than only its collateral,
    ///      so a winner gives up that share of its profit, and a flat or losing
    ///      position that share of its size.
    ///
    ///      Open interest decays with funding, so a crowded side pays more, and
    ///      pays less as its own positions shrink. _decayFactor integrates that
    ///      feedback exactly rather than holding the opening rate.
    uint256 private constant FUNDING_BASE_BPS = 1_000; // 10 % of the position / window
    uint256 private constant FUNDING_UTIL_BPS = 2_000; // + 20 % x utilization / window

    /// @dev Ceiling on the utilization term, in bps of utilization.
    ///
    ///      utilization is OI / backedAirUsd, and backedAirUsd is a denominator
    ///      nobody guarantees stays large: a pool whose reserves are drawn down
    ///      while open interest stands still can push the ratio arbitrarily
    ///      high. Uncapped, the per-second rate can reach or exceed RAY, and
    ///      `RAY - rate` in _accrueFunding underflows. Capped at 4x, the worst
    ///      per-window rate is 10 % + 80 % = 90 %, which at the one-hour floor is
    ///      2.5e-4 per second — more than three orders of magnitude clear of RAY.
    uint256 private constant FUNDING_UTIL_CAP_BPS = 4 * BPS_DENOM; // 4x utilization

    /// @dev The funding window: the period over which one `ratePerWindow` is
    ///      charged. It opens at one hour and widens by one second per second of
    ///      market age, to a thirty-day ceiling:
    ///
    ///        window(age) = min(1 hour + age, 30 days)
    ///
    ///      A market's first hours are its most volatile. The token has no price
    ///      history, depth is whatever the creator seeded, and an option written
    ///      against it is a bet on noise that the LP is on the wrong side of —
    ///      so rent starts high and falls as the market earns a history.
    ///
    ///      This replaces a five-step ladder (1h / 8h / 24h / 7d / 30d keyed on
    ///      age) and reproduces it to within a few percent at every step — age 8h
    ///      gives a 9-hour window against the ladder's 8, age 24h gives 25
    ///      against 24 — while removing the cliffs, where a market seconds either
    ///      side of a step boundary priced eight times differently.
    uint256 private constant FUNDING_WINDOW_MIN = 1 hours;
    uint256 private constant FUNDING_WINDOW_MAX = 30 days;

    /// @dev Wind-down. closePool blocks new opens immediately and sets
    ///      closeDate = now + WIND_DOWN_GRACE. Past closeDate the funding rate
    ///      DOUBLES every WIND_DOWN_DOUBLING, up to a shift of WIND_DOWN_MAX_SHIFT.
    ///
    ///      This is the whole of the LP's exit guarantee, and it replaces
    ///      per-position deadlines, RENEW_HORIZON, and the stacking analysis
    ///      those required. Positions are never force-closed at a price someone
    ///      else chose; they are made progressively more expensive to hold until
    ///      the holder closes voluntarily or the collateral decays to dust that
    ///      sweepDust() can clear.
    ///
    ///      The doubling period sets the whole of the wait, and it is the number
    ///      worth arguing about. At seven days an abandoned position on a mature
    ///      market still holds 0.6 % of its collateral after three months, which
    ///      is not a wind-down, it is a lien. At one day the slowest case — a
    ///      mature market at its 30-day window, carrying a small position —
    ///      still holds 3.2 % ten days past closeDate and is dust about a day
    ///      later, so the LP's worst case is the grace period plus about eleven
    ///      days. Measured, not asserted — see the wind-down tests.
    ///
    ///      The shift cap exists so the rate cannot overflow on a pool left
    ///      closed for years; it binds at 16 days past closeDate, after every
    ///      position has already decayed into sweep range.
    uint256 private constant WIND_DOWN_GRACE     = 7 days;
    uint256 private constant WIND_DOWN_DOUBLING  = 1 days;
    uint256 private constant WIND_DOWN_MAX_SHIFT = 16;

    /// @dev A position is sweepable once its effective collateral has decayed to
    ///      this fraction of what it was opened with.
    ///
    ///      Funding decays a position geometrically, so it approaches zero
    ///      without reaching it. Its debt and notional decay in step, so by then
    ///      the husk distorts nothing — but it still holds a slot in
    ///      openPositionCount, and removeLiquidity cannot unblock until every
    ///      slot is released. The sweep releases it.
    ///
    ///      Permissionless and unpaid, like the settlement it replaces. It needs
    ///      no bounty because it is never urgent and never involves bad debt: the
    ///      party with both the motive and the standing is the LP, whose
    ///      withdrawal the husk is blocking. At 0.1 % of opening collateral the
    ///      holder's claim is worth less than the gas to collect it, so nothing
    ///      of value is taken — but the test is on COLLATERAL rather than on
    ///      claim, so a position cannot be swept by anyone who first pushes its
    ///      claim to zero on a manipulated curve.
    uint256 private constant SWEEP_DUST_BPS = 10; // 0.1 % of opening collateral

    /// @dev Close-price clamp. A holder can move the curve their own close
    ///      settles against — closeLong / closeShort are ungated and must stay
    ///      that way — so _priceCloseClamped values a close against the worst of
    ///      the last CLAMP_BLOCKS block-opens wherever that is less favourable
    ///      than live. See _priceCloseClamped (audit finding H-2).
    ///
    ///      This is all that remains of what used to be the "settlement guard".
    ///      The other half of it — lastLargeSwapBlock, SETTLE_GUARD_BPS,
    ///      RENEW_MARGIN_BPS, and _assertSettlementUnguarded — existed to stop a
    ///      third party flipping or suppressing the settlement of somebody
    ///      else's EXPIRED position. Positions no longer expire, and the only
    ///      third-party path that remains is sweepDust, which by construction
    ///      can only touch a position whose collateral is already worth nothing.
    ///      There is no longer a valuable settlement for a stranger to steer, so
    ///      the lockout and its threshold are gone. The clamp is not: it defends
    ///      against the HOLDER, and voluntary closes are untouched by any of it.
    uint256 private constant CLAMP_BLOCKS = 5;

    // ── Immutables ────────────────────────────────────────────────────────────

    /// @notice Decimals of the underlying token (airToken units use the same scale).
    uint8 public immutable tokenDecimals;

    /// @notice Raw underlying ERC-20 held as collateral by this pool.
    IERC20 public immutable underlyingToken;

    /// @notice USDC ERC-20 (6 decimals) held as collateral by this pool.
    IERC20 public immutable underlyingUsdc;

    /// @notice PositionNFT contract that custodies position collateral.
    IPositionNFT public immutable positionNFT;

    /// @notice LpNFT contract — ownerOf(lpNftId) holds LP authority.
    ILpNFT public immutable lpNftContract;

    /// @notice Token ID of the LP NFT that governs this pool.
    uint256 public immutable lpNftId;

    /// @notice Receives the 1 % protocol fee on every position open.
    address public immutable protocolTreasury;

    /// @notice Market creation timestamp. Anchors the position-cap ramp.
    uint256 public immutable createdAt;

    /// @notice Factory that deployed this pool. Used to look up the emergency deployer.
    IEXNIHILOFactory public immutable factory;

    // ── Mutable state ─────────────────────────────────────────────────────────

    /// @notice Total airToken units in existence (backed + synthetic + locked).
    ///         Virtual reserve for SWAP-3. Replaces the former wrapper ERC-20's
    ///         totalSupply().
    uint256 public airTokenSupply;

    /// @notice Total airUsd units in existence (backed + synthetic + locked).
    ///         Virtual reserve for SWAP-2.
    uint256 public airUsdSupply;

    /// @notice airToken backed 1 : 1 by deposited underlying tokens.
    uint256 public backedAirToken;

    /// @notice airUsd backed 1 : 1 by deposited underlying USDC.
    uint256 public backedAirUsd;

    /// @notice Accrued LP fees in USDC (6 dec). Pull payment — the LP NFT
    ///         holder claims via claimFees(to).
    uint256 public lpFeesAccumulated;

    /// @notice Accrued protocol fees in USDC (6 dec). Pull payment — the
    ///         treasury claims via claimProtocolFees(to).
    uint256 public protocolFeesAccumulated;

    /// @notice Cumulative USDC (6 dec) claimed by LP holders. Display only.
    uint256 public lpFeesPaidTotal;

    /// @notice Cumulative USDC (6 dec) claimed by the treasury. Display only.
    uint256 public protocolFeesPaidTotal;

    /// @notice USDC payouts (6 dec) credited by sweepDust when a swept position
    ///         still had a residual claim. Pull payment — the recipient
    ///         withdraws via claimPayout(to), so no recipient can ever block
    ///         position cleanup.
    mapping(address => uint256) public claimable;

    /// @notice Sum of all outstanding claimable payouts (solvency accounting).
    uint256 public totalClaimable;

    /// @notice Total number of open long + short positions.
    uint256 public openPositionCount;

    /// @notice Sum of the LIVE USDC notional of every open long (6 dec). A long's
    ///         notional is also its synthetic airUsd debt, so this doubles as
    ///         the long-side debt aggregate: funding shrinks it by the side's
    ///         decay and burns the same amount out of airUsdSupply.
    ///
    /// @dev    As of the last accrual. Between accruals it overstates the live
    ///         figure by the funding not yet written; views that price off it
    ///         project first (see _projectedOpenInterest).
    uint256 public longOpenInterest;

    /// @notice Sum of the LIVE USDC notional of every open short (6 dec). Decays
    ///         with the short side's funding. See longOpenInterest.
    uint256 public shortOpenInterest;

    /// @notice End of the wind-down grace period, set by closePool to
    ///         now + WIND_DOWN_GRACE. New positions are blocked from the moment
    ///         it is set; past it the funding rate starts doubling. 0 = pool is
    ///         open.
    uint256 public closeDate;

    /// @notice Sum of `lockedAmount` across all open SHORT positions (6 dec).
    ///
    /// @dev    openShort moves real USDC out of `backedAirUsd` and records it as
    ///         the position's `lockedAmount`. That USDC is still held by this
    ///         contract but belongs to the trader, so without this counter the
    ///         reserve invariant treated it as free surplus and could not tell
    ///         a healthy pool from one that had leaked short collateral.
    ///         Appended at the end of storage so existing slot offsets are
    ///         unchanged.
    uint256 public totalShortCollateral;

    /// @notice Sum of every OPEN long's `lockedAmount` — underlying token moved
    ///         out of backedAirToken at open and owed back to the position.
    ///
    /// @dev    The symmetric completion of totalShortCollateral. Without it the
    ///         token leg of the reserve invariant was a loose lower bound: a
    ///         long's collateral leaves the backed reserve but never leaves the
    ///         contract, so the balance check passed against a figure smaller
    ///         than the real obligation and could not detect a leak of that
    ///         collateral. Measured slack over 360 randomised ops was 17 % on
    ///         the token leg against 0 % on USDC, and exactly 0 once this term
    ///         is added (audit SI-001).
    ///
    ///         Moves on open, on settle, and with funding: _accrueFunding
    ///         shrinks it by the long side's decay and hands the released units
    ///         to backedAirToken.
    uint256 public totalLongCollateral;

    /// @notice Funding index for the long side, in RAY. Starts at RAY and only
    ///         ever decreases. A position's live collateral is
    ///         `lockedAmountAtOpen * fundingIndexLong / fundingIndexAtOpen`.
    ///
    /// @dev    One number per side is enough because funding takes the same
    ///         FRACTION from every position on that side. See RAY.
    uint256 public fundingIndexLong = RAY;

    /// @notice Funding index for the short side, in RAY. See fundingIndexLong.
    uint256 public fundingIndexShort = RAY;

    /// @notice Timestamp through which long-side funding has been charged.
    ///
    /// @dev    Advanced only when an accrual actually lands. A release that
    ///         rounds to zero — a sub-second interval, or a side whose whole
    ///         collateral is dust — leaves this where it was so the elapsed time
    ///         is not silently forgiven; the next accrual charges for it.
    uint256 public lastFundingLong;

    /// @notice Timestamp through which short-side funding has been charged.
    uint256 public lastFundingShort;

    /// @dev The four reserve terms as one block OPENED, the block they describe,
    ///      and the two funding indices that were live at that moment. A long
    ///      settles against backedAirUsd / airTokenSupply, a short against
    ///      backedAirToken / airUsdSupply.
    ///
    ///      `timestamp` is carried alongside `blockNumber` so a snapshot can be
    ///      compared against Position.openedAt, which PositionNFT records as a
    ///      timestamp. A block's open predates any position opened IN that
    ///      block, and valuing a position against reserves from before it
    ///      existed is meaningless — see _priceCloseClamped.
    ///
    ///      The indices are carried for the same reason the reserves are. A
    ///      position's collateral shrinks continuously, so pricing it against an
    ///      older block's reserves while using TODAY's collateral values a
    ///      position that never existed — and in the holder's favour, since
    ///      collateral only ever falls. The clamp has to reconstruct the
    ///      collateral as of the snapshot, which needs the index as of the
    ///      snapshot.
    struct PriceSnapshot {
        uint256 blockNumber;
        uint256 timestamp;
        uint256 backedUsd;
        uint256 tokenSupply;
        uint256 backedToken;
        uint256 usdSupply;
        uint256 fundingLong;
        uint256 fundingShort;
    }

    /// @dev Ring of the opens of the last CLAMP_BLOCKS blocks in which the
    ///      reserves were mutated. `priceRingHead` indexes the newest.
    ///
    ///      One consumer now: _priceCloseClamped, which clamps a close payout to
    ///      the worst of every entry still inside the window. That is what stops
    ///      a holder pricing their own close against a swap they just made (H-2).
    ///      It used to have a second — _armSettlementGuard, which measured this
    ///      block's displacement to decide whether a stranger could settle
    ///      somebody else's expired position. Nothing expires any more, so that
    ///      consumer and its threshold are gone; see CLAMP_BLOCKS.
    ///
    ///      The pairs are exactly the ones _priceCloseAt reads, on both sides, so
    ///      the snapshot and the settlement pricing cannot disagree about what a
    ///      block "opened with".
    ///
    ///      Sized to the window deliberately: entries are one per block and the
    ///      window admits blocks `asOfBlock - CLAMP_BLOCKS + 1 .. asOfBlock`, so
    ///      CLAMP_BLOCKS slots can never drop an entry that is still eligible.
    ///      Written once per block.
    PriceSnapshot[CLAMP_BLOCKS] private priceRing;
    uint256 private priceRingHead;

    /// @notice Sum of every OPEN short's live synthetic airToken debt.
    ///
    /// @dev    The short-side counterpart of longOpenInterest, which already
    ///         carries the long debt. Shorts need their own counter because
    ///         their notional is USDC and their debt airToken. Funding shrinks it
    ///         by the side's decay and burns the same amount out of
    ///         airTokenSupply, which keeps
    ///
    ///           airTokenSupply == backedAirToken + totalLongCollateral + totalShortDebt
    ///
    ///         exact. Declared last so no existing storage slot moves.
    uint256 public totalShortDebt;

    // ── Custom errors ─────────────────────────────────────────────────────────

    error OnlyLpHolder();
    error OnlyPositionHolder();
    error PositionNotFromThisPool();
    error PositionNotLong();
    error PositionNotShort();
    error ZeroAmount();
    error InsufficientOutput();
    error LeverageCapExceeded();
    error PositionUnderwater();
    error OpenPositionsExist();
    error ZeroAddress();
    error InsufficientBackedReserves();
    error ReserveInvariantViolated();
    error ZeroLiquidity();
    error RatioMismatch();
    error FeeOnTransferNotSupported();
    error PoolClosing();
    error PoolAlreadyClosed();
    error OnlyLpHolderOrDeployer();
    error OnlyTreasury();
    error PositionNotDust();

    // ── Events ────────────────────────────────────────────────────────────────




    /**
     * @notice Emitted on every spot swap (SWAP-1).
     *
     *         Carries the post-swap backed reserves so a consumer can derive the
     *         spot price and pool depth without a follow-up RPC read.
     *
     * @dev    Deliberately NOT shaped like a Uniswap V2 `Swap`. This pool has one
     *         input and one output per call rather than V2's four amount fields,
     *         no token0/token1 ordering, and reserves that only describe the
     *         *backed* side — leveraged opens and closes move `airTokenSupply` /
     *         `airUsdSupply` without emitting here. Pretending to be a V2 pair
     *         would misreport all three.
     *
     * @param sender         Caller (the router, when routed).
     * @param recipient      Receives `amountOut`.
     * @param tokenToUsdc    true = token in / USDC out, false = the reverse.
     * @param amountIn       Raw input, in the input asset's own decimals.
     * @param amountOut      Raw output, net of the swap fee.
     * @param backedAirToken Token-side backed reserve after the swap.
     * @param backedAirUsd   USDC-side backed reserve after the swap.
     */
    event Swap(
        address indexed sender,
        address indexed recipient,
        bool    tokenToUsdc,
        uint256 amountIn,
        uint256 amountOut,
        uint256 backedAirToken,
        uint256 backedAirUsd
    );

    event PositionOpened(uint256 indexed nftId, address indexed holder, bool isLong);
    event PositionClosed(uint256 indexed nftId, address indexed holder, uint256 payout);

    /// @notice A dust position was cleared by a third party. `payout` is what was
    ///         credited to the holder, which is 0 in every case the sweep can
    ///         reach — see SWEEP_DUST_BPS.
    event PositionSwept(uint256 indexed nftId, address indexed caller, uint256 payout);

    /// @notice Funding charged to one side since the last accrual.
    ///
    /// @dev    The indexer cannot read funding out of lpFeesAccumulated the way
    ///         it reads the open and close fees, because funding is not a fee:
    ///         it lands directly in the backed reserves and never becomes
    ///         claimable. This event is the only record that separates reserve
    ///         growth caused by funding from reserve growth caused by trading,
    ///         so LP yield attribution depends on it.
    ///
    /// @param isLong        Which side paid.
    /// @param released      Collateral units moved into the backed reserve —
    ///                      airToken for the long side, airUsd (== USDC, 6 dec)
    ///                      for the short.
    /// @param debtCancelled Synthetic debt burned with it — airUsd (6 dec) for
    ///                      the long side, airToken for the short. Both describe
    ///                      the same slice of the same positions, so `released`
    ///                      valued at the time, minus `debtCancelled`, is a lower
    ///                      bound on what the slice was worth to the LP: winners
    ///                      and losers net against each other in an aggregate.
    /// @param newIndex      The side's funding index after this accrual, in RAY.
    /// @param elapsed       Seconds covered by this accrual.
    event FundingAccrued(
        bool indexed isLong,
        uint256 released,
        uint256 debtCancelled,
        uint256 newIndex,
        uint256 elapsed
    );
    event PayoutCredited(address indexed recipient, uint256 amount);
    event PayoutClaimed(address indexed recipient, address indexed to, uint256 amount);
    event PoolClosed(address indexed closedBy, uint256 closeDate);
    event LpFeesPaid(address indexed to, uint256 amount);
    event ProtocolFeesPaid(address indexed to, uint256 amount);


    // ── Modifiers ─────────────────────────────────────────────────────────────

    /// @dev Checks the direct ERC-721 owner of lpNftId; approved operators are
    ///      intentionally excluded per spec.
    modifier onlyLpHolder() {
        if (lpNftContract.ownerOf(lpNftId) != msg.sender) revert OnlyLpHolder();
        _;
    }

    /**
     * @dev Every path that mutates the backed reserves carries this. It charges
     *      funding up to this block, pins the block's opening reserves for the
     *      close-price clamp, and asserts conservation after the body runs.
     *
     *      Binding them to one hook is the point: none of the three can be
     *      omitted from a new path without dropping the other two, which no
     *      review would miss.
     */
    modifier reserveMutation() {
        _accrueFunding();
        _priceRingSnapshot();
        _;
        _assertReserveInvariant();
    }

    // ── Admin functions ───────────────────────────────────────────────────────

    /**
     * @notice Initiate pool closure. Sets closeDate = now + WIND_DOWN_GRACE.
     *
     *         Once set:
     *           - No new positions can be opened (openLong / openShort revert).
     *           - Holders may still close voluntarily, at any time, at the same
     *             price they always could. Nothing is force-settled.
     *           - After closeDate the funding rate DOUBLES every
     *             WIND_DOWN_DOUBLING, without limit up to WIND_DOWN_MAX_SHIFT.
     *             Holding becomes geometrically more expensive until every
     *             position is either closed by its holder or decayed to dust
     *             that sweepDust() can clear, which is what finally lets the LP
     *             call removeLiquidity().
     *
     *         This replaces the former guarantee that all positions are expired
     *         and closeable after closeDate. That one was exact but rested on
     *         per-position deadlines and a horizon cap on stacked renewals; this
     *         one is economic, and bounds the wait at weeks rather than at a
     *         constant. See WIND_DOWN_GRACE.
     *
     *         Callable by the LP NFT holder or the factory's emergency deployer.
     *         Irreversible — reverts if already closed.
     */
    function closePool() external nonReentrant {
        if (closeDate != 0) revert PoolAlreadyClosed();

        address lpHolder = lpNftContract.ownerOf(lpNftId);
        address emergencyDeployer = factory.deployer();

        if (msg.sender != lpHolder && msg.sender != emergencyDeployer) {
            revert OnlyLpHolderOrDeployer();
        }

        // Accrue at the pre-close rate before closeDate starts bending it —
        // _ratePerSecond reads closeDate, so writing it first would apply the
        // wind-down multiplier to time that elapsed before the wind-down began.
        _accrueFunding();

        closeDate = block.timestamp + WIND_DOWN_GRACE;

        emit PoolClosed(msg.sender, closeDate);
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param underlyingToken_   Raw underlying ERC-20 deposited by LP.
     * @param underlyingUsdc_   USDC ERC-20 (6 dec) deposited by LP.
     * @param tokenDecimals_    Decimals of the underlying token (airToken scale).
     * @param positionNFT_      Shared PositionNFT contract.
     * @param lpNftContract_    Shared LpNFT contract.
     * @param lpNftId_          Which LP NFT token governs this pool.
     * @param protocolTreasury_ Receives 1 % on every position open.
     * @param factory_          Factory that deployed this pool (for emergency deployer lookup).
     */
    constructor(
        address underlyingToken_,
        address underlyingUsdc_,
        uint8   tokenDecimals_,
        address positionNFT_,
        address lpNftContract_,
        uint256 lpNftId_,
        address protocolTreasury_,
        address factory_
    ) {
        if (underlyingToken_   == address(0)) revert ZeroAddress();
        if (underlyingUsdc_   == address(0)) revert ZeroAddress();
        if (positionNFT_      == address(0)) revert ZeroAddress();
        if (lpNftContract_    == address(0)) revert ZeroAddress();
        if (protocolTreasury_ == address(0)) revert ZeroAddress();
        if (factory_          == address(0)) revert ZeroAddress();

        tokenDecimals    = tokenDecimals_;
        underlyingToken   = IERC20(underlyingToken_);
        underlyingUsdc   = IERC20(underlyingUsdc_);
        positionNFT      = IPositionNFT(positionNFT_);
        lpNftContract    = ILpNFT(lpNftContract_);
        lpNftId          = lpNftId_;
        protocolTreasury = protocolTreasury_;
        createdAt        = block.timestamp;
        factory          = IEXNIHILOFactory(factory_);

        // Both sides start charging from creation. Leaving these at zero would
        // make the first accrual bill an elapsed time measured from the unix
        // epoch — _projectFunding would find no collateral and simply advance
        // the clock, but only by luck of ordering, and the invariant that these
        // are always <= block.timestamp is worth having unconditionally.
        lastFundingLong  = block.timestamp;
        lastFundingShort = block.timestamp;
    }

    // =========================================================================
    // SWAP  (SWAP-1: x = backedAirToken, y = backedAirUsd)
    // =========================================================================

    /**
     * @notice Swap raw underlying tokens for USDC or vice versa.
     *
     *         The pool auto-wraps the inbound raw token into the matching
     *         airToken (increasing that side's backed reserve) and auto-unwraps
     *         the outbound airToken back to raw (decreasing that side's backed
     *         reserve). The swap fee (swapFeeBps) is kept in the pool by *not*
     *         reducing the output-side backed reserve by the fee amount, which
     *         passively grows LP value over time.
     *
     * @param amountIn     Raw token amount in (token decimals or USDC 6 dec).
     * @param minAmountOut Slippage guard on the raw output amount.
     * @param tokenToUsdc   true = token → USDC, false = USDC → token.
     */
    function swap(
        uint256 amountIn,
        uint256 minAmountOut,
        bool tokenToUsdc,
        address recipient
    ) external nonReentrant {
        if (amountIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        if (backedAirToken == 0 || backedAirUsd == 0) revert InsufficientBackedReserves();

        uint256 amountOut = tokenToUsdc
            ? _swapTokenToUsdc(amountIn, minAmountOut, recipient)
            : _swapUsdcToToken(amountIn, minAmountOut, recipient);

        // Reserves read after the swap, so the event is self-contained.
        emit Swap(
            msg.sender, recipient, tokenToUsdc, amountIn, amountOut, backedAirToken, backedAirUsd
        );
    }

    // =========================================================================
    // LONG POSITIONS
    // =========================================================================

    /**
     * @notice Open a leveraged long on the underlying token.
     *
     *   How leverage works
     *   ──────────────────
     *   The pool mints `usdcAmount` of synthetic airUsd without adding any USDC
     *   backing (totalSupply grows, backedAirUsd stays flat). SWAP-2 then prices
     *   airToken against this inflated airUsd supply, so the trader receives more
     *   airToken per USDC than the backed ratio would give — that is the leverage.
     *   The minted airToken leaves the pool's backed reserves and is locked in the
     *   PositionNFT. The synthetic airUsd remains as an outstanding debt in
     *   airUsdSupply, shrinking with funding, until the position is closed.
     *
     *   State changes
     *   ─────────────
     *     backedAirToken  −= airTokenOut  (collateral locked away)
     *     airUsd supply  += usdcAmount  (synthetic debt created; NOT backed)
     *
     * @param usdcAmount    USDC notional (6 dec). A 5 % fee is charged on top.
     * @param minAirTokenOut Slippage guard on the airToken locked in the NFT.
     */
    function openLong(
        uint256 usdcAmount,
        uint256 minAirTokenOut,
        address recipient
    ) external nonReentrant reserveMutation {
        if (closeDate != 0) revert PoolClosing();
        if (recipient == address(0)) revert ZeroAddress();
        if (usdcAmount == 0) revert ZeroAmount();
        if (backedAirToken == 0 || backedAirUsd == 0) revert InsufficientBackedReserves();

        _checkLeverageCap(usdcAmount);

        // Fee split: 5 % base + OI-integral impact fee, minimum 0.05 USDC.
        // Uses longOpenInterest BEFORE this position is added.
        (uint256 totalFee, uint256 protocolFee, uint256 lpFee) =
            _openFees(usdcAmount, longOpenInterest);

        // SWAP-2: compute airToken output before any state changes.
        // reserveIn  = airUsdSupply before the synthetic mint below.
        // reserveOut = backedAirToken
        uint256 airTokenOut = _cpAmountOut(
            usdcAmount,
            airUsdSupply,
            backedAirToken
        );

        if (airTokenOut == 0) revert ZeroAmount();
        if (airTokenOut < minAirTokenOut) revert InsufficientOutput();
        if (airTokenOut > backedAirToken) revert InsufficientBackedReserves();

        // ── EFFECTS ───────────────────────────────────────────────────────────
        openPositionCount++;
        longOpenInterest += usdcAmount;

        // Mint synthetic airUsd: inflates the supply counter, no new backing.
        // The full usdcAmount becomes the synthetic debt regardless of fees
        // because the trader's notional position size is usdcAmount.
        airUsdSupply += usdcAmount;

        // Collateral leaves the backed reserves; it stays counted in
        // airTokenSupply and is recorded as lockedAmountAtOpen on the NFT.
        backedAirToken -= airTokenOut;
        totalLongCollateral += airTokenOut;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        // The notional is NOT pulled — it is represented synthetically by the
        // airUsd minted above.  Only the 5 % fee is collected from the trader
        // and accrued for the treasury and LP to claim (pull payment).
        _transferIn(underlyingUsdc, msg.sender, totalFee);
        _accrueProtocolFee(protocolFee);
        _accrueLpFee(lpFee);

        uint256 nftId = positionNFT.mintLong(
            recipient,
            address(this),
            usdcAmount,   // usdcIn
            usdcAmount,   // airUsdMinted — synthetic debt owed
            airTokenOut,   // airTokenLocked
            totalFee,
            fundingIndexLong
        );


        emit PositionOpened(nftId, recipient, true);
    }

    /**
     * @notice Close a profitable long position.
     *
     *   Settlement
     *   ──────────
     *   SWAP-3 prices the locked airToken against
     *   (airTokenSupply − lockedAmount, backedAirUsd). If the resulting
     *   airUsd ≥ the synthetic debt (airUsdMinted), the surplus is paid to the
     *   holder as USDC. The synthetic debt is cancelled; the locked airToken
     *   re-enters the backed reserves as fully-backed LP collateral.
     *
     *   State changes
     *   ─────────────
     *     backedAirToken  += lockedAmount  (airToken collateral returns to LP reserves)
     *     backedAirUsd   −= surplus       (only the profit USDC exits the pool's backing)
     *     airUsdSupply   −= airUsdMinted  (synthetic debt cancelled)
     *     airUsdSupply   −= surplus       (backed units burned for USDC paid to holder)
     *
     *   Note: airTokenSupply is unchanged. The underlying token never left the
     *   pool, so the locked airToken units correctly represent LP's restored
     *   claim on that token. Burning them would orphan the underlying tokens.
     *
     * @param nftId      Position NFT token ID.
     * @param minUsdcOut Slippage guard on USDC profit (surplus after debt).
     * @param to         Where the profit is sent. Pass a different address if
     *                   the holder wallet itself cannot receive USDC.
     */
    function closeLong(uint256 nftId, uint256 minUsdcOut, address to) external nonReentrant {
        address holder = positionNFT.ownerOf(nftId);
        if (holder != msg.sender) revert OnlyPositionHolder();
        if (to == address(0)) revert ZeroAddress();

        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();
        if (!pos.isLong) revert PositionNotLong();

        _settle(nftId, pos, holder, to, minUsdcOut, false);
    }

    // =========================================================================
    // SHORT POSITIONS
    // =========================================================================

    /**
     * @notice Open a leveraged short on the underlying token.
     *
     *   How leverage works
     *   ──────────────────
     *   The pool mints synthetic airToken proportional to the USDC notional at
     *   the current backed rate. This inflates airTokenSupply.
     *   The resulting airUsd (real, from backedAirUsd) is locked against the
     *   position. The synthetic airToken remains as outstanding debt in
     *   airTokenSupply, shrinking with funding, until the position is closed.
     *
     *   State changes
     *   ─────────────
     *     airTokenSupply += airTokenMinted  (synthetic debt; NOT backed)
     *     backedAirUsd   -= airUsdOut      (real airUsd locked)
     *
     * @param usdcNotional  Notional size in USDC terms (6 dec). A 5 % fee is charged on top.
     * @param minAirUsdOut  Slippage guard on airUsd locked in PositionNFT.
     */
    function openShort(
        uint256 usdcNotional,
        uint256 minAirUsdOut,
        address recipient
    ) external nonReentrant reserveMutation {
        if (closeDate != 0) revert PoolClosing();
        if (recipient == address(0)) revert ZeroAddress();
        if (usdcNotional == 0) revert ZeroAmount();
        if (backedAirToken == 0 || backedAirUsd == 0) revert InsufficientBackedReserves();

        _checkLeverageCap(usdcNotional);

        // Fee split: 5 % base + OI-integral impact fee, minimum 0.05 USDC.
        // Uses shortOpenInterest BEFORE this position is added.
        (uint256 totalFee, uint256 protocolFee, uint256 lpFee) =
            _openFees(usdcNotional, shortOpenInterest);

        // Compute synthetic airToken to mint using the current SWAP-1 reference rate:
        //   airTokenMinted = usdcNotional * airTokenSupply / backedAirUsd
        // This gives the airToken amount that is worth usdcNotional at backed prices.
        uint256 airTokenSupplyBefore = airTokenSupply;
        if (airTokenSupplyBefore == 0) revert InsufficientBackedReserves();

        uint256 airTokenMinted = (usdcNotional * airTokenSupplyBefore) / backedAirUsd;
        if (airTokenMinted == 0) revert ZeroAmount();

        // SWAP-3: compute airUsd output before any state changes.
        // reserveIn  = airTokenSupply before the synthetic mint below.
        // reserveOut = backedAirUsd
        uint256 airUsdOut = _cpAmountOut(airTokenMinted, airTokenSupplyBefore, backedAirUsd);

        if (airUsdOut == 0) revert ZeroAmount();
        if (airUsdOut < minAirUsdOut) revert InsufficientOutput();
        if (airUsdOut > backedAirUsd) revert InsufficientBackedReserves();

        // ── EFFECTS ──────────────────────────────────────────────────────────
        openPositionCount++;
        shortOpenInterest += usdcNotional;

        // Mint synthetic airToken: inflates the supply counter, no new token backing.
        airTokenSupply += airTokenMinted;
        totalShortDebt += airTokenMinted;

        // Real airUsd leaves the backed reserves; it stays counted in
        // airUsdSupply and is recorded as lockedAmountAtOpen on the NFT.
        backedAirUsd -= airUsdOut;
        // Still this contract's USDC, but now owed to the trader — track it so
        // the reserve invariant keeps covering it.
        totalShortCollateral += airUsdOut;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        // The notional is NOT pulled — it is represented synthetically by the
        // airToken minted above.  Only the 5 % fee is collected from the trader
        // and accrued for the treasury and LP to claim (pull payment).
        _transferIn(underlyingUsdc, msg.sender, totalFee);
        _accrueProtocolFee(protocolFee);
        _accrueLpFee(lpFee);

        uint256 nftId = positionNFT.mintShort(
            recipient,
            address(this),
            airTokenMinted,
            airUsdOut,
            usdcNotional,
            totalFee,
            fundingIndexShort
        );


        emit PositionOpened(nftId, recipient, false);
    }

    /**
     * @notice Close a profitable short position.
     *
     *   Settlement
     *   ──────────
     *   SWAP-2 (inverse formula) computes how much of the locked airUsd it
     *   costs to buy back exactly airTokenMinted airToken. If the locked
     *   airUsd covers that cost, the surplus is paid to the holder as USDC.
     *
     *   State changes
     *   ─────────────
     *     airTokenSupply −= airTokenMinted   (synthetic debt cancelled)
     *     backedAirUsd   += airUsdCostForDebt (cost of buyback restores backing)
     *     airUsdSupply   −= surplus         (burned for USDC paid out; the cost
     *                                        portion stays as backed supply)
     *
     * @param nftId      Position NFT token ID.
     * @param minUsdcOut Slippage guard on USDC profit.
     * @param to         Where the profit is sent. Pass a different address if
     *                   the holder wallet itself cannot receive USDC.
     */
    function closeShort(uint256 nftId, uint256 minUsdcOut, address to) external nonReentrant {
        address holder = positionNFT.ownerOf(nftId);
        if (holder != msg.sender) revert OnlyPositionHolder();
        if (to == address(0)) revert ZeroAddress();

        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();
        if (pos.isLong) revert PositionNotShort();

        _settle(nftId, pos, holder, to, minUsdcOut, false);
    }

    // =========================================================================
    // LIQUIDITY MANAGEMENT
    // =========================================================================

    /**
     * @notice Deposit liquidity on both sides of the pool.
     *
     *         For non-empty pools the deposit must match the current
     *         backedAirToken : backedAirUsd ratio (within 0.01 % rounding
     *         tolerance) to avoid shifting the AMM price.
     *
     *         Only the direct owner of the LP NFT may call this — not approved
     *         operators. This is intentional: ownership is the gate.
     *
     * @param tokenAmount  Raw underlying tokens to deposit.
     * @param usdcAmount  USDC to deposit (6 dec).
     */
    function addLiquidity(uint256 tokenAmount, uint256 usdcAmount) external nonReentrant onlyLpHolder reserveMutation {
        if (tokenAmount == 0 || usdcAmount == 0) revert ZeroAmount();

        // Ratio check for non-empty pools (cross-multiplication avoids precision loss).
        if (backedAirToken != 0 && backedAirUsd != 0) {
            uint256 lhs       = tokenAmount * backedAirUsd;
            uint256 rhs       = usdcAmount * backedAirToken;
            uint256 tolerance = (lhs > rhs ? lhs : rhs) / 10_000 + 1;
            if (lhs > rhs + tolerance || rhs > lhs + tolerance) revert RatioMismatch();
        }

        // ── EFFECTS ───────────────────────────────────────────────────────────
        airTokenSupply += tokenAmount;
        airUsdSupply   += usdcAmount;
        backedAirToken += tokenAmount;
        backedAirUsd  += usdcAmount;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        _transferIn(underlyingToken, msg.sender, tokenAmount);
        _transferIn(underlyingUsdc, msg.sender, usdcAmount);


    }

    /**
     * @notice Withdraw 100 % of both backed reserves (full withdrawal only;
     *         partial withdrawal is intentionally unsupported).
     *
     *         Requires openPositionCount == 0 so that no synthetic debt is
     *         outstanding — otherwise the pool's airToken supply accounting
     *         would be corrupted.
     */
    function removeLiquidity() external nonReentrant onlyLpHolder reserveMutation {
        if (openPositionCount != 0) revert OpenPositionsExist();
        if (backedAirToken == 0 && backedAirUsd == 0) revert ZeroLiquidity();

        uint256 tokenOut = backedAirToken;
        uint256 usdcOut = backedAirUsd;

        // EFFECTS before interactions.
        airTokenSupply -= tokenOut;
        airUsdSupply   -= usdcOut;
        backedAirToken = 0;
        backedAirUsd  = 0;

        if (tokenOut > 0) {
            underlyingToken.safeTransfer(msg.sender, tokenOut);
        }

        if (usdcOut > 0) {
            underlyingUsdc.safeTransfer(msg.sender, usdcOut);
        }

    }

    /**
     * @notice Claim all accrued LP fees. Fees are pull payments — they accrue
     *         on every position open and are withdrawn here.
     *         Sends the full accumulated amount to `to` — pass a different
     *         address if the holder wallet itself cannot receive USDC
     *         (e.g. blacklisted).
     */
    function claimFees(address to) external nonReentrant onlyLpHolder {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = lpFeesAccumulated;
        if (amount == 0) revert ZeroAmount();

        lpFeesAccumulated = 0;
        lpFeesPaidTotal += amount;

        underlyingUsdc.safeTransfer(to, amount);
        emit LpFeesPaid(to, amount);
    }

    /**
     * @notice Claim all accrued protocol fees. Callable only by the treasury;
     *         sends the full accumulated amount to `to` (a blacklisted
     *         treasury can still redirect, since the restriction is on
     *         receiving USDC, not on calling).
     */
    function claimProtocolFees(address to) external nonReentrant {
        if (msg.sender != protocolTreasury) revert OnlyTreasury();
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = protocolFeesAccumulated;
        if (amount == 0) revert ZeroAmount();

        protocolFeesAccumulated = 0;
        protocolFeesPaidTotal += amount;

        underlyingUsdc.safeTransfer(to, amount);
        emit ProtocolFeesPaid(to, amount);
    }

    /**
     * @notice Withdraw USDC payouts credited to the caller by sweepDust, when
     *         it cleared a position of theirs that still had a residual claim.
     *         Sends the full amount
     *         to `to` — pass a different address if the caller wallet itself
     *         cannot receive USDC (e.g. blacklisted).
     */
    function claimPayout(address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert ZeroAmount();

        claimable[msg.sender] = 0;
        totalClaimable -= amount;

        underlyingUsdc.safeTransfer(to, amount);
        emit PayoutClaimed(msg.sender, to, amount);
    }

    // =========================================================================
    // DUST SWEEP
    // =========================================================================

    /**
     * @notice Clear a position whose collateral has decayed to dust. Callable by
     *         anyone.
     *
     *         Positions do not expire. Funding shrinks them geometrically
     *         instead — collateral, debt and notional together — which
     *         approaches zero without ever arriving. By the time a position is
     *         dust its debt is dust too, so it no longer distorts the curves;
     *         what it still does is hold a slot in openPositionCount, and
     *         removeLiquidity cannot unblock while any slot is taken.
     *
     *         Only reachable once effective collateral has fallen below
     *         SWEEP_DUST_BPS of what the position opened with, so the holder's
     *         claim is worth less than the gas to collect it. Any claim that does
     *         somehow survive is still paid — as a pull payment, credited to the
     *         holder — so the sweep can never be used to take value.
     *
     *         Unpaid, deliberately. The party with the motive is the LP, whose
     *         withdrawal a dead position blocks, and a bounty carved out of the
     *         settlement flow could exceed the payout it was carved from.
     *
     * @param nftId Position NFT to sweep.
     */
    function sweepDust(uint256 nftId) external nonReentrant {
        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();

        // Accrue before measuring: the position may only have become dust in the
        // seconds since the last mutation, and refusing a sweep on a stale index
        // would make the caller trade first to make their own call succeed.
        _accrueFunding();

        // Measured against the position's OWN opening collateral, not against
        // any live price. A claim-based test could be dodged the other way —
        // push the mark down for one block and sweep a position that is not
        // dust at all — whereas collateral only moves with funding, which no
        // caller controls.
        uint256 live = effectiveLocked(pos);
        if (live * BPS_DENOM > pos.lockedAmountAtOpen * SWEEP_DUST_BPS) {
            revert PositionNotDust();
        }

        address holder = positionNFT.ownerOf(nftId);
        _settle(nftId, pos, holder, holder, 0, true);
    }


    // =========================================================================
    // VIEWS
    // =========================================================================

    /**
     * @notice Current AMM spot price: USDC per whole token (divide by 1e6 for USD).
     *         Uses SWAP-1 backed reserves: backedAirUsd / backedAirToken.
     */
    function spotPrice() external view returns (uint256) {
        if (backedAirToken == 0) return 0;
        return (backedAirUsd * (10 ** uint256(tokenDecimals))) / backedAirToken;
    }

    /**
     * @notice Long entry price (SWAP-2 marginal rate): airUsdSupply / backedAirToken.
     *         This is the effective token price when opening a long.
     */
    function longPrice() external view returns (uint256) {
        return _longPrice();
    }

    function _longPrice() internal view returns (uint256) {
        if (backedAirToken == 0) return 0;
        return (airUsdSupply * (10 ** uint256(tokenDecimals))) / backedAirToken;
    }

    /**
     * @notice Short entry price (SWAP-3 marginal rate): backedAirUsd / airTokenSupply.
     *         This is the effective token price when opening a short.
     */
    function shortPrice() external view returns (uint256) {
        return _shortPrice();
    }

    function _shortPrice() internal view returns (uint256) {
        if (airTokenSupply == 0) return 0;
        return (backedAirUsd * (10 ** uint256(tokenDecimals))) / airTokenSupply;
    }

    /**
     * @notice Everything an off-chain indexer needs from this pool, in one call.
     *
     * @dev Indexers read all of these together on every pool event. Fetching
     *      them as eight separate eth_calls made RPC volume — not the database —
     *      the dominant cost of a sync, and it is the first thing a rate-limited
     *      provider punishes. Bundling is chain-independent, unlike relying on
     *      Multicall3 being deployed.
     *
     *      Fees are returned as LIFETIME totals (accrued + already withdrawn)
     *      because that is the only monotonic form: collecting fees zeroes the
     *      accumulator and adds the same amount to the paid total, so the sum
     *      never decreases and a consumer can safely diff it between events.
     */
    function indexerState()
        external
        view
        returns (
            uint256 backedAirToken_,
            uint256 backedAirUsd_,
            uint256 longPrice_,
            uint256 shortPrice_,
            uint256 lpFeesLifetime,
            uint256 protocolFeesLifetime,
            uint256 fundingIndexLong_,
            uint256 fundingIndexShort_,
            uint256 fundingRateLong_,
            uint256 fundingRateShort_
        )
    {
        backedAirToken_      = backedAirToken;
        backedAirUsd_        = backedAirUsd;
        longPrice_           = _longPrice();
        shortPrice_          = _shortPrice();
        lpFeesLifetime       = lpFeesAccumulated + lpFeesPaidTotal;
        protocolFeesLifetime = protocolFeesAccumulated + protocolFeesPaidTotal;

        // Projected, not stored. Funding accrues continuously but is only
        // written on a reserve mutation, so the stored index is stale by however
        // long the pool has been quiet — and an indexer diffing stored indices
        // would attribute a quiet week's funding to whichever trade happened to
        // end it.
        (fundingIndexLong_,,)  = _projectFunding(true);
        (fundingIndexShort_,,) = _projectFunding(false);
        fundingRateLong_  = backedAirUsd == 0 ? 0 : _ratePerSecond(_projectedOpenInterest(true), block.timestamp);
        fundingRateShort_ = backedAirUsd == 0 ? 0 : _ratePerSecond(_projectedOpenInterest(false), block.timestamp);
    }

    /**
     * @notice Current per-position cap as a fraction of backedAirUsd, in bps.
     *         Ramps linearly from 1 % at creation to 20 % after 24 hours, then
     *         holds. Fixed by construction — there is no setter and no caller
     *         who can move it.
     */
    function currentMaxPositionBps() public view returns (uint256) {
        uint256 elapsed = block.timestamp - createdAt;
        if (elapsed >= CAP_RAMP_DURATION) return CAP_MAX_BPS;
        return CAP_START_BPS
             + ((CAP_MAX_BPS - CAP_START_BPS) * elapsed) / CAP_RAMP_DURATION;
    }

    /**
     * @notice Effective per-position leverage cap in USDC (6 dec) right now —
     *         currentMaxPositionBps() applied to the live backed reserve.
     *         Moves with both the clock and pool depth.
     */
    function effectiveLeverageCap() external view returns (uint256) {
        return (backedAirUsd * currentMaxPositionBps()) / BPS_DENOM;
    }

    /**
     * @notice Returns true if the pool is closing (closeDate has been set).
     */
    function isClosing() external view returns (bool) {
        return closeDate != 0;
    }

    /**
     * @notice Total USDC fee charged to open a position of `notional` right now
     *         (5 % base with 0.05 USDC minimum + OI-integral impact fee).
     *         This is the single source of truth for the fee — the Router and
     *         frontends must quote here instead of replicating the formula.
     */
    function quoteOpenFee(uint256 notional, bool isLong) external view returns (uint256 totalFee) {
        // Projected open interest, because the open this quotes accrues funding
        // first and prices its impact fee off what is left.
        (totalFee,,) = _openFees(notional, _projectedOpenInterest(isLong));
    }

    /**
     * @notice Live close quote for position `nftId`, mirroring the exact
     *         settlement math of closeLong / closeShort.
     *
     *         `ready` is false when current reserves cannot price the position
     *         (locked collateral exceeds active supply, or the synthetic debt
     *         cannot be bought back).
     *
     *         `pnl` is in USDC (6 dec): positive = profit the holder would
     *         receive on close (net of the 1 % close fee); negative = current
     *         shortfall below break-even.
     */
    /**
     * @notice Quote what closing a position would pay, for display only.
     *
     * @return ready Whether the settlement math can price the position. False
     *               means it is underwater past the point where its debt can be
     *               bought back at all, so it cannot be closed — unchanged, and
     *               still what `_settle` gates on.
     * @return pnl   Payout on close when `ready`, negative when the position is
     *               below break-even. When `!ready` this is the *estimated*
     *               shortfall, also negative: a position nobody can close is
     *               exactly the one whose holder most needs a number, and
     *               returning 0 there rendered "N/A" on the certificate.
     */
    function quoteClose(uint256 nftId) external view returns (bool ready, int256 pnl) {
        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();

        // Priced for the NEXT block, because that is the earliest one a close
        // submitted now can be mined in, and the clamp window it will face ends
        // there rather than at the latest mined block. Quoting live instead
        // would overstate the payout for the whole window after any favourable
        // move — the caller would set minUsdcOut from a number the pool has
        // already decided not to pay. The residual gap between quote and
        // execution is ordinary slippage, which minUsdcOut covers.
        //
        // Back when the clamp reached back exactly one block this had to be
        // live: the reference was the current block's open, which a close mined
        // later never faces. A window that outlives the current block reverses
        // that reasoning.
        (bool priceable, uint256 surplus, uint256 deficit,) =
            _priceCloseClamped(pos, block.number + 1);
        if (!priceable) return (false, -int256(_quoteShortfall(pos)));
        if (deficit > 0) return (true, -int256(deficit));
        return (true, int256(surplus - (surplus * CLOSE_FEE_BPS) / BPS_DENOM));
    }

    /**
     * @dev Estimated shortfall for a position `_priceClose` refuses to price.
     *      Display-only: it deliberately extrapolates past the point the
     *      settlement math stops, so it must never feed settlement — a position
     *      in this state stays uncloseable, and a sweep pays it nothing.
     *
     *      Short: the debt costs more airUsd than the collateral can buy. The
     *      proportional cost is extrapolated from the partial fill the curve
     *      does allow; with no fill at all the loss is the whole collateral.
     *      Long: no airToken supply outside the position means nothing can be
     *      realised, so the entire synthetic debt is the shortfall.
     */
    function _quoteShortfall(Position memory pos) internal view returns (uint256) {
        (uint256 locked, uint256 debt,) = _live(pos);
        if (pos.isLong) return debt;
        if (airUsdSupply < locked) return locked;

        uint256 totalBuyable = _cpAmountOut(
            locked,
            airUsdSupply - locked,
            backedAirToken
        );
        if (totalBuyable == 0) return locked;

        uint256 cost =
            (locked * debt + totalBuyable - 1) / totalBuyable;
        return cost > locked ? cost - locked : 0;
    }

    // =========================================================================
    // INTERNAL — close-price ring
    // =========================================================================

    /**
     * @dev Record the reserves and funding indices this block opened with, once
     *      per block, before any mutation.
     *
     *      Paired with _accrueFunding by the reserveMutation modifier and
     *      ordered after it, so the indices written here are the ones the
     *      reserves written here correspond to. Consumed only by
     *      _priceCloseClamped.
     */
    function _priceRingSnapshot() internal {
        // At most one entry per block: the first mutation of a block records
        // what that block opened with, and every later mutation in the same
        // block is part of what the entry is there to measure.
        if (priceRing[priceRingHead].blockNumber == block.number) return;

        uint256 next = priceRingHead + 1;
        if (next == CLAMP_BLOCKS) next = 0;

        priceRing[next] = PriceSnapshot({
            blockNumber:  block.number,
            timestamp:    block.timestamp,
            backedUsd:    backedAirUsd,
            tokenSupply:  airTokenSupply,
            backedToken:  backedAirToken,
            usdSupply:    airUsdSupply,
            fundingLong:  fundingIndexLong,
            fundingShort: fundingIndexShort
        });
        priceRingHead = next;
    }

    // =========================================================================
    // INTERNAL — swap helpers
    // =========================================================================

    /**
     * @dev Execute a token → USDC SWAP-1.
     *      Extracted to a dedicated function to keep swap()'s stack frame lean.
     */
    function _swapTokenToUsdc(uint256 amountIn, uint256 minAmountOut, address recipient)
        internal
        reserveMutation
        returns (uint256 netOut)
    {
        // ── CHECK (against pre-swap reserves) ─────────────────────────────────
        netOut = _cpAmountOut(amountIn, backedAirToken, backedAirUsd);
        // A trade large enough that the fee exceeds the raw output yields zero;
        // without this, a caller passing minAmountOut == 0 pays amountIn for nothing.
        if (netOut == 0) revert InsufficientOutput();
        if (netOut < minAmountOut) revert InsufficientOutput();

        // ── EFFECTS ───────────────────────────────────────────────────────────
        // netOut is the USDC that actually crossed the pool boundary — the
        // USDC-denominated size of this trade. Armed against pre-swap depth.

        // Wrap the inbound token (supply grows), unwrap the outbound airUsd
        // (supply shrinks by the USDC leaving the pool).
        airTokenSupply += amountIn;
        airUsdSupply   -= netOut;
        backedAirToken += amountIn;
        backedAirUsd  -= netOut;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        _transferIn(underlyingToken, msg.sender, amountIn);
        underlyingUsdc.safeTransfer(recipient, netOut);


    }

    /**
     * @dev Execute a USDC → token SWAP-1.
     */
    function _swapUsdcToToken(uint256 amountIn, uint256 minAmountOut, address recipient)
        internal
        reserveMutation
        returns (uint256 netOut)
    {
        // ── CHECK (against pre-swap reserves) ─────────────────────────────────
        netOut = _cpAmountOut(amountIn, backedAirUsd, backedAirToken);
        // A trade large enough that the fee exceeds the raw output yields zero;
        // without this, a caller passing minAmountOut == 0 pays amountIn for nothing.
        if (netOut == 0) revert InsufficientOutput();
        if (netOut < minAmountOut) revert InsufficientOutput();

        // ── EFFECTS ───────────────────────────────────────────────────────────
        // amountIn is the USDC leg of this trade. Armed against pre-swap depth.

        // Wrap the inbound USDC (supply grows), unwrap the outbound airToken
        // (supply shrinks by the token leaving the pool).
        airUsdSupply   += amountIn;
        airTokenSupply -= netOut;
        backedAirUsd  += amountIn;
        backedAirToken -= netOut;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        _transferIn(underlyingUsdc, msg.sender, amountIn);
        underlyingToken.safeTransfer(recipient, netOut);


    }

    // =========================================================================
    // INTERNAL — settlement (single path for voluntary closes and dust sweeps)
    // =========================================================================

    /**
     * @dev Single source of truth for close pricing — reached through
     *      _priceCloseClamped by every close path: closeLong, closeShort and
     *      sweepDust (all via _settle), and quoteClose.
     *
     *      Long:  values the locked airToken through SWAP-3
     *             (reserveIn = airTokenSupply − locked, reserveOut = backedAirUsd)
     *             and compares against the synthetic airUsd debt.
     *      Short: computes the proportional airUsd cost of buying back the
     *             synthetic airToken debt through SWAP-2. Ceil-divide so
     *             integer truncation never undercuts the real cost; concavity
     *             of the CP curve makes the estimate conservative (the pool
     *             never overpays).
     *
     * @return priceable false when current reserves cannot price the position
     *                   (locked collateral ≥ active supply, or the debt cannot
     *                   be bought back). Unpriceable ⇒ underwater.
     * @return surplus   USDC profit before the close fee (0 when in deficit).
     * @return deficit   USDC shortfall below break-even (0 when in surplus).
     * @return restore   Short only: airUsd cost of the debt buyback, which
     *                   returns to backedAirUsd on settlement.
     */
    function _priceClose(Position memory pos)
        internal
        view
        returns (bool priceable, uint256 surplus, uint256 deficit, uint256 restore)
    {
        (uint256 locked, uint256 debt,) = _live(pos);
        return _priceCloseAt(
            pos.isLong, locked, debt, airTokenSupply, backedAirUsd, airUsdSupply, backedAirToken
        );
    }

    /**
     * @dev _priceClose against an arbitrary reserve state and position size
     *      instead of the live ones. Pure, so the caller decides which state a
     *      given path is entitled to price against — see _priceCloseSettlement.
     *      `locked` and `debt` must describe the position at the same index.
     */
    function _priceCloseAt(
        bool isLong,
        uint256 locked,
        uint256 debt,
        uint256 tokenSupply,
        uint256 backedUsd,
        uint256 usdSupply,
        uint256 backedToken
    )
        internal
        pure
        returns (bool priceable, uint256 surplus, uint256 deficit, uint256 restore)
    {
        if (isLong) {
            if (tokenSupply <= locked) return (false, 0, 0, 0);
            uint256 airUsdOut = _cpAmountOut(
                locked,
                tokenSupply - locked,
                backedUsd
            );
            if (airUsdOut >= debt) {
                return (true, airUsdOut - debt, 0, 0);
            }
            return (true, 0, debt - airUsdOut, 0);
        }

        // Short: locked airUsd is out of circulation — subtract it from the
        // SWAP-2 reserve, mirroring the long side's supply subtraction.
        if (usdSupply < locked) return (false, 0, 0, 0);
        uint256 totalBuyable = _cpAmountOut(
            locked,
            usdSupply - locked,
            backedToken
        );
        if (totalBuyable == 0 || totalBuyable < debt) return (false, 0, 0, 0);
        uint256 cost =
            (locked * debt + totalBuyable - 1) / totalBuyable;
        if (locked >= cost) {
            return (true, locked - cost, 0, cost);
        }
        return (true, 0, cost - locked, cost);
    }

    /**
     * @dev Close pricing as SETTLEMENT is entitled to see it: the live
     *      valuation, clamped to the block-opening one wherever that is less
     *      favourable to the holder.
     *
     *      Without the clamp a holder can swap the settlement price in their own
     *      favour, settle at the mark they just moved, and unwind — one
     *      transaction, no privileged role. The block guard cannot cover this
     *      direction by construction: the holder is exempt from it (an armed
     *      guard must never trap someone in a position) and closeLong /
     *      closeShort are ungated for the same reason. Audit finding H-2
     *      measured $4,122 of LP USDC leaving per close — 3.2 % of pool depth,
     *      token leg byte-identical, so a one-sided drain rather than a
     *      valuation artefact — and it pays on any position whose mark clears
     *      ~1 % of backedAirUsd, against a cap that permits 20 %.
     *
     *      Fixing it as a PRICE rather than a lockout is the whole point.
     *      Gating the close on lastLargeSwapBlock would hand the LP a free
     *      hostage lever: arming costs the LP nothing, because the swap fee is
     *      retained in the reserves it owns (see _swapTokenToUsdc), so it could
     *      re-arm every CLAMP_BLOCKS and hold every holder in position
     *      indefinitely. Here the holder can always close. They simply cannot
     *      close at a price they moved inside the window.
     *
     *      Clamping to ONE block's open — the first version of this fix — closed
     *      the atomic variant and left pump-in-N / settle-in-N+1 paying, because
     *      block N+1 opens on the pumped reserves. Widening the reference to
     *      every open still inside CLAMP_BLOCKS closes that too: the
     *      pre-pump open is still in the ring, and rolling it out takes a fresh
     *      entry per block, so the attacker has to hold the displaced price for
     *      the whole window with arbitrage open against them the entire time.
     *      That is the same assumption CLAMP_BLOCKS already rests on for
     *      third parties, now applied to the holder as a price instead of a
     *      lockout.
     *
     *      A symmetric reference — an average, or the old state used outright —
     *      would be strictly worse than either. The payout is funded from the
     *      very reserves that define the price (_settle takes surplus straight
     *      out of backedAirUsd), so a reference ABOVE live pays out more than
     *      the curve supports and rebuilds the same attack mirrored: displace
     *      the price down, settle at the stale-high mark, buy back. Hence the
     *      clamp is one-way, always.
     *
     *      Entries age out by block number rather than by ring position, so a
     *      pool that stops trading is not frozen against a stale reference: once
     *      every entry is CLAMP_BLOCKS old the clamp is a no-op and
     *      pricing is live again.
     *
     *      Only ever moves the outcome against the holder, never for it.
     *
     * @param asOfBlock The block the close is priced FOR. Settlement passes
     *                  block.number. quoteClose passes block.number + 1: a
     *                  close submitted now is mined no earlier than the next
     *                  block, and the window it will face is the one that ends
     *                  there, not the one that ends at the latest mined block.
     */
    function _priceCloseClamped(Position memory pos, uint256 asOfBlock)
        internal
        view
        returns (bool priceable, uint256 surplus, uint256 deficit, uint256 restore)
    {
        (priceable, surplus, deficit, restore) = _priceClose(pos);

        // Bounded by a compile-time constant, and every iteration is a pure
        // valuation of the same position — no external calls, no state writes.
        for (uint256 i = 0; i < CLAMP_BLOCKS; i++) {
            PriceSnapshot storage e = priceRing[i];
            uint256 at = e.blockNumber;

            // Slot never written (a pool younger than the ring), or an open old
            // enough that a manipulator would have had to hold it through the
            // whole window to put it here.
            if (at == 0 || at + CLAMP_BLOCKS <= asOfBlock) continue;

            // Never reach back past the position's own open. A snapshot is
            // taken before its block's first mutation, so one whose timestamp
            // equals openedAt describes the moment BEFORE the position was
            // created; the reserves there do not contain it and _priceCloseAt
            // would be valuing something that did not exist. This costs no
            // security: the manipulation being priced out is always a move made
            // AFTER the position was opened, so every snapshot that matters
            // survives the test. Two blocks sharing a timestamp can drop one
            // otherwise-eligible entry, which only ever weakens the clamp
            // inside the first second of a position's life — when it is
            // underwater by its own opening fee anyway.
            if (e.timestamp <= pos.openedAt) continue;

            // The position as it stood at that snapshot — collateral and debt
            // both — not as it stands now. Funding shrinks it between blocks, so
            // pricing today's size against an older block's reserves would value
            // a position that never existed.
            (uint256 lockedThen, uint256 debtThen,) =
                _liveAt(pos, pos.isLong ? e.fundingLong : e.fundingShort);
            (bool p, uint256 s, uint256 d, uint256 r) = _priceCloseAt(
                pos.isLong,
                lockedThen,
                debtThen,
                e.tokenSupply,
                e.backedUsd,
                e.usdSupply,
                e.backedToken
            );

            // Underwater at any open in the window outranks any surplus the
            // window produced, and takes that valuation's restore with it.
            if (!p || d > 0) return (p, 0, d, r);

            // surplus and restore come from the SAME valuation, so the pair a
            // caller receives is internally consistent. _settle does not take
            // restore from here, though: this valuation's restore + surplus is
            // the collateral as it stood at the snapshot, not as it stands now.
            if (s < surplus) {
                surplus = s;
                restore = r;
            }
        }
    }

    /**
     * @dev Close pricing as SETTLEMENT is entitled to see it. Thin wrapper so
     *      the settlement path and quoteClose cannot drift apart on anything
     *      but the block they price for.
     */
    function _priceCloseSettlement(Position memory pos)
        internal
        view
        returns (bool priceable, uint256 surplus, uint256 deficit, uint256 restore)
    {
        return _priceCloseClamped(pos, block.number);
    }

    /**
     * @dev Shared settlement for voluntary closes and dust sweeps.
     *
     *      Voluntary (isSweep = false): caller is the verified holder;
     *      reverts if the position is underwater; pays `payTo` directly (the
     *      holder is msg.sender and chose both the moment and the recipient).
     *
     *      Sweep (isSweep = true): callable by anyone, but only for a position
     *      whose collateral has decayed to dust; a residual claim CREDITS the
     *      holder's claimable balance (pull payment — no recipient can block
     *      cleanup); an underwater position returns its collateral to the LP
     *      reserves and cancels the synthetic debt.
     *
     *      State changes on profitable settlement:
     *        Long:  backedAirToken += locked; backedAirUsd −= surplus;
     *               airUsdSupply −= debt + surplus
     *        Short: backedAirUsd += locked − surplus; airTokenSupply −= debt;
     *               airUsdSupply −= surplus
     */
    function _settle(
        uint256 nftId,
        Position memory pos,
        address holder,
        address payTo,
        uint256 minPayout,
        bool isSweep
    ) internal reserveMutation {
        // Priced against the block open where that is worse for the holder, so
        // a settler cannot move their own payout in the same transaction they
        // collect it. See _priceCloseSettlement (audit finding H-2).
        (bool priceable, uint256 surplus, uint256 deficit,) =
            _priceCloseSettlement(pos);
        bool underwater = !priceable || deficit > 0;

        if (!isSweep && underwater) revert PositionUnderwater();

        // What this position actually still has after every second of funding
        // charged since it opened — collateral, debt and notional alike.
        // reserveMutation has already accrued to this block, so these are final
        // rather than projections, and the same figures _priceCloseSettlement
        // just priced against.
        (uint256 locked, uint256 debt, uint256 notional) = _live(pos);

        // ── EFFECTS ───────────────────────────────────────────────────────────
        openPositionCount--;
        if (pos.isLong) {
            longOpenInterest -= debt; // a long's notional IS its debt
        } else {
            shortOpenInterest -= notional;
            totalShortDebt    -= debt;
        }

        if (underwater) {
            // Sweep only: return collateral to LP, cancel synthetic debt.
            if (pos.isLong) {
                backedAirToken += locked;
                totalLongCollateral -= locked;
                airUsdSupply   -= debt;
            } else {
                backedAirUsd   += locked;
                airTokenSupply -= debt;
                totalShortCollateral -= locked;
            }
            _flushResidue();

            // ── INTERACTIONS ──────────────────────────────────────────────────
            positionNFT.release(nftId);
            emit PositionSwept(nftId, msg.sender, 0);
        } else {
            uint256 closeFee = (surplus * CLOSE_FEE_BPS) / BPS_DENOM;
            uint256 netSurplus = surplus - closeFee;
            if (netSurplus < minPayout) revert InsufficientOutput();

            if (pos.isLong) {
                backedAirToken += locked;
                totalLongCollateral -= locked;
                backedAirUsd  -= surplus;
                airUsdSupply  -= debt + surplus;
            } else {
                // Everything the collateral does not pay out returns to the LP.
                // Derived from `locked` rather than taken from the valuation:
                // the clamp may have priced this close against an older block,
                // when funding had taken less, and that valuation's buyback cost
                // plus surplus adds up to the collateral as it stood THEN.
                // Crediting it here would pay out more USDC than the position
                // still has. surplus <= locked always: the live valuation pays at
                // most the collateral, and the clamp only ever lowers it.
                backedAirUsd   += locked - surplus;
                airTokenSupply -= debt;
                airUsdSupply   -= surplus;
                totalShortCollateral -= locked;
            }
            _flushResidue();
            _accrueProtocolFee(closeFee);

            // ── INTERACTIONS ──────────────────────────────────────────────────
            positionNFT.release(nftId);
            if (isSweep) {
                _creditPayout(holder, netSurplus);
                emit PositionSwept(nftId, msg.sender, netSurplus);
            } else {
                // Pushed, not credited: the holder chose this moment and this
                // recipient, so a transfer that reverts can only inconvenience
                // them. `payTo` is separate from `holder` precisely so that a
                // holder whose own wallet cannot receive USDC still has an exit
                // — without it, removing the expiry path would have stranded
                // them, since a blacklisted address could previously wait for a
                // third party to settle and credit the payout instead.
                underlyingUsdc.safeTransfer(payTo, netSurplus);
                emit PositionClosed(nftId, holder, netSurplus);
            }
        }

    }

    // =========================================================================
    // FUNDING
    // =========================================================================

    /**
     * @notice Charge funding to both sides up to the current block timestamp.
     *
     *         Called automatically at the top of every reserve mutation, so no
     *         one ever has to call it. It is exposed because a pool that has not
     *         traded for a long time carries unaccrued funding that the LP is
     *         owed and the holders have not yet paid, and anyone should be able
     *         to realise that without having to trade to do it.
     */
    function pokeFunding() external nonReentrant reserveMutation {}

    /**
     * @dev Charge funding to both sides: move the released collateral into the
     *      matching backed reserve, and burn the debt and open interest that
     *      collateral was locked against.
     *
     *      Runs FIRST in reserveMutation, ahead of the price-ring snapshot, for
     *      two reasons. The snapshot has to record reserves and funding indices
     *      that describe the same instant, and every rate input — both open
     *      interest figures and backedAirUsd — is about to be changed by the
     *      call this modifier wraps. Accruing first means the interval just
     *      charged was one over which the rate genuinely was constant, which is
     *      what lets a single _rpow stand in for the integral.
     *
     *      The clock advances under exactly two conditions, and the distinction
     *      matters:
     *
     *        released != 0            the charge landed; time is paid for.
     *        nothing to charge        no collateral on that side, or no depth to
     *                                 measure utilization against. There is no
     *                                 debt to carry, and NOT advancing here would
     *                                 make the first position opened into a long
     *                                 idle pool retroactively liable for the
     *                                 whole idle period.
     *
     *      When neither holds — collateral exists but the release rounded to
     *      zero — the clock stays put and the index does not move, so the
     *      elapsed time is carried into the next accrual rather than forgiven.
     *      The index and the aggregate must move together or they drift apart,
     *      and the aggregate is what settlement subtracts from.
     */
    function _accrueFunding() internal {
        (uint256 idxL, uint256 factorL, uint256 elapsedL) = _projectFunding(true);
        if (factorL != RAY) {
            uint256 relColl = _released(totalLongCollateral, factorL);
            // A long's notional is its airUsd debt, so one release covers both
            // the open interest and the debt burned out of airUsdSupply.
            uint256 relDebt = _released(longOpenInterest, factorL);
            fundingIndexLong     = idxL;
            totalLongCollateral -= relColl;
            backedAirToken      += relColl;
            longOpenInterest    -= relDebt;
            airUsdSupply        -= relDebt;
            lastFundingLong      = block.timestamp;
            emit FundingAccrued(true, relColl, relDebt, idxL, elapsedL);
        } else if (elapsedL != 0 && (totalLongCollateral == 0 || backedAirUsd == 0)) {
            lastFundingLong = block.timestamp;
        }

        (uint256 idxS, uint256 factorS, uint256 elapsedS) = _projectFunding(false);
        if (factorS != RAY) {
            uint256 relColl = _released(totalShortCollateral, factorS);
            uint256 relDebt = _released(totalShortDebt, factorS);
            fundingIndexShort     = idxS;
            totalShortCollateral -= relColl;
            backedAirUsd         += relColl;
            totalShortDebt       -= relDebt;
            airTokenSupply       -= relDebt;
            shortOpenInterest    -= _released(shortOpenInterest, factorS);
            lastFundingShort      = block.timestamp;
            emit FundingAccrued(false, relColl, relDebt, idxS, elapsedS);
        } else if (elapsedS != 0 && (totalShortCollateral == 0 || backedAirUsd == 0)) {
            lastFundingShort = block.timestamp;
        }
    }

    /**
     * @dev What _accrueFunding would do to one side right now, without doing it.
     *
     *      The single source of truth for both the executing path and every view
     *      that has to show a position net of funding it has not been charged
     *      yet. A quote that read the stored index directly would be optimistic
     *      by however long the pool has sat idle, and the holder would discover
     *      the difference only on execution.
     *
     * @return newIndex The side's funding index after the accrual. Equal to the
     *                  stored one when nothing is charged.
     * @return factor   The fraction of every aggregate on the side KEPT over the
     *                  interval, in RAY. Exactly RAY when nothing is charged,
     *                  which is what callers test for.
     * @return elapsed  Seconds since this side was last charged.
     */
    function _projectFunding(bool isLong)
        internal
        view
        returns (uint256 newIndex, uint256 factor, uint256 elapsed)
    {
        uint256 last   = isLong ? lastFundingLong     : lastFundingShort;
        uint256 locked = isLong ? totalLongCollateral : totalShortCollateral;
        newIndex       = isLong ? fundingIndexLong    : fundingIndexShort;
        factor         = RAY;

        if (block.timestamp <= last) return (newIndex, RAY, 0);
        elapsed = block.timestamp - last;

        // No collateral to charge, or no depth to measure utilization against.
        if (locked == 0 || backedAirUsd == 0) return (newIndex, RAY, elapsed);

        // The window widens continuously, so the charge over the interval is an
        // integral of a moving rate rather than a rate times a duration.
        //
        // The window term is handled by evaluating at the interval MIDPOINT,
        // which is correct to second order and costs one addition — the window
        // moves by one second per second, so over any interval it is very nearly
        // linear.
        //
        // The wind-down term cannot be handled that way and must not be. It
        // rises GEOMETRICALLY, so a midpoint evaluation of a month-long interval
        // undercharges it several-fold, and the size of the error depends on how
        // often the pool happened to be touched — which hands a holder a lever:
        // keep the pool quiet and the wind-down barely bites. _weightedElapsed
        // integrates it exactly instead, so the charge for a stretch of time is
        // the same however many pieces it is accrued in.
        uint256 midpoint = last + elapsed / 2;
        uint256 window   = _fundingWindowAt(midpoint);
        uint256 oi       = isLong ? longOpenInterest : shortOpenInterest;
        uint256 rate     = _ratePerSecond(oi, midpoint);
        if (rate == 0) return (newIndex, RAY, elapsed);

        uint256 f = _decayFactor(
            rate, oi, window, _weightedElapsed(last, block.timestamp, window)
        );

        // Move the index only when the collateral aggregate moved. A release
        // that rounds to nothing must not shrink the positions either, or the
        // holders pay something the LP never receives.
        if (_released(locked, f) == 0) return (newIndex, RAY, elapsed);
        newIndex = (newIndex * f) / RAY;
        factor   = f;
    }

    /**
     * @dev The fraction of a side KEPT over `weighted` seconds, in RAY.
     *
     *      The rate has two terms, and only the base term is constant. The
     *      utilization term is the side's own open interest over depth, and
     *      funding shrinks that open interest as it goes, so a crowded side's
     *      rate falls as its positions decay. Holding the opening rate for the
     *      whole interval would overcharge a quiet crowded pool — overnight on a
     *      young market, by an order of magnitude — and make the charge depend on
     *      how often anyone happened to accrue.
     *
     *      With `a` the base rate and `b` the utilization term at the start of
     *      the interval, utilization x follows dx/dt = −(a + b·x/x0)·x, which
     *      solves in closed form:
     *
     *        q    = (1 − a)^t                      the base term alone
     *        kept = a·q / (a + b·(1 − q))
     *
     *      That composes exactly — keeping kept(t1), then kept(t2) from the
     *      shrunken utilization, is kept(t1 + t2) — so an interval accrued in one
     *      step or in fifty charges the same. At or above FUNDING_UTIL_CAP_BPS
     *      the rate does not start falling until utilization drops back under
     *      the cap, and the closed form would undercharge that stretch; there
     *      the full rate is held instead, which can only overcharge and is
     *      corrected by the next accrual.
     *
     *      Left out, and second order: short funding raises backedAirUsd — the
     *      utilization denominator — while the interval runs. Ignoring that holds
     *      utilization slightly high, which again can only overcharge.
     */
    function _decayFactor(uint256 rate, uint256 oi, uint256 window, uint256 weighted)
        internal
        view
        returns (uint256)
    {
        uint256 base = (FUNDING_BASE_BPS * RAY) / (BPS_DENOM * window);
        if (rate <= base || (oi * BPS_DENOM) / backedAirUsd >= FUNDING_UTIL_CAP_BPS) {
            return _rpow(RAY - rate, weighted);
        }
        uint256 q = _rpow(RAY - base, weighted);
        return (base * q) / (base + ((rate - base) * (RAY - q)) / RAY);
    }

    /**
     * @dev What decaying `amount` by `factor` releases.
     *
     *      Rounds the amount KEPT up, against _liveAt rounding what each
     *      position keeps down. The two must be biased in opposite directions so
     *      that every aggregate — collateral, debt, open interest — stays >= the
     *      sum of the positions it stands for: settlement subtracts a position's
     *      live figures from these aggregates, and the reverse bias would let the
     *      last position out of a pool underflow them.
     */
    function _released(uint256 amount, uint256 factor) internal pure returns (uint256) {
        uint256 kept = (amount * factor + RAY - 1) / RAY;
        if (kept > amount) kept = amount; // factor <= RAY, so only rounding can do this
        return amount - kept;
    }

    /// @dev One side's open interest net of funding not yet written — what an
    ///      accrual in this block would leave. Views that price off open
    ///      interest read this, so a quote matches the execution that accrues
    ///      before it prices.
    function _projectedOpenInterest(bool isLong) internal view returns (uint256) {
        (, uint256 factor,) = _projectFunding(isLong);
        uint256 oi = isLong ? longOpenInterest : shortOpenInterest;
        return oi - _released(oi, factor);
    }

    /**
     * @notice Funding rate for one side right now, in RAY per second.
     *         Multiply by 86400 and divide by 1e25 for percent per day.
     */
    function fundingRatePerSecond(bool isLong) external view returns (uint256) {
        if (backedAirUsd == 0) return 0;
        uint256 rate = _ratePerSecond(_projectedOpenInterest(isLong), block.timestamp);
        // Display figure, so the wind-down multiplier IS applied here: someone
        // asking what a position is paying right now wants the rate it is
        // actually paying. The accrual path applies the same multiplier through
        // _weightedElapsed, where it can be integrated rather than sampled.
        uint256 shift = _windDownShift(block.timestamp);
        if (shift != 0) rate <<= shift;
        uint256 ceiling = RAY / 2;
        return rate > ceiling ? ceiling : rate;
    }

    /**
     * @dev Per-second funding rate in RAY, for a side carrying `oi` of open
     *      interest, as it stands at timestamp `atTs`.
     *
     *        perWindow = FUNDING_BASE_BPS + FUNDING_UTIL_BPS * min(util, cap)
     *        rate      = perWindow / window(atTs), doubled once per
     *                    WIND_DOWN_DOUBLING past closeDate
     *
     *      Caller must ensure backedAirUsd != 0.
     */
    function _ratePerSecond(uint256 oi, uint256 atTs) internal view returns (uint256) {
        uint256 util = (oi * BPS_DENOM) / backedAirUsd;
        if (util > FUNDING_UTIL_CAP_BPS) util = FUNDING_UTIL_CAP_BPS;

        uint256 perWindow = FUNDING_BASE_BPS + (FUNDING_UTIL_BPS * util) / BPS_DENOM;

        // BASE rate only — the wind-down multiplier is NOT applied here. It is
        // carried by _weightedElapsed instead, which integrates it exactly. A
        // rate returned pre-multiplied would then be held constant across an
        // interval the multiplier doubles several times inside, which is the
        // whole error _weightedElapsed exists to avoid.
        //
        // Bounded well below RAY by construction — at the utilization cap and the
        // one-hour window floor the worst case is 90 % / 3600 s = 2.5e-4 — but the
        // decay factor is RAY - rate and the invariant that it stays strictly
        // positive is load-bearing enough to assert rather than infer.
        uint256 rate    = (perWindow * RAY) / (BPS_DENOM * _fundingWindowAt(atTs));
        uint256 ceiling = RAY / 2;
        return rate > ceiling ? ceiling : rate;
    }

    /// @dev Ceiling on the integration walk in _weightedElapsed. The window
    ///      doubles at most log2(30 days / 1 hour) ~ 10 times over the life of
    ///      any market and the wind-down shift is capped at WIND_DOWN_MAX_SHIFT,
    ///      so 32 pieces cannot be reached; it is a bound, not a budget.
    uint256 private constant _MAX_INTEGRATION_STEPS = 32;

    /**
     * @dev Seconds between `from` and `to`, each weighted so that
     *
     *        decay = (RAY - rate(windowRef)) ^ weightedElapsed
     *
     *      is the compounded charge over the interval rather than an
     *      approximation of it. Charging a stretch of time in one accrual or in
     *      fifty then gives the same answer, which is what stops a holder paying
     *      less by keeping the pool quiet — and, since pokeFunding is
     *      permissionless, what stops the model depending on anyone calling it.
     *
     *      Each second carries two factors, and the reason they have to be
     *      integrated TOGETHER is that they are correlated:
     *
     *        the wind-down multiplier   2^shift, doubling once per
     *                                   WIND_DOWN_DOUBLING past closeDate
     *        the window ratio           windowRef / window(t), because the rate
     *                                   is inversely proportional to the window
     *
     *      Late seconds in a wind-down carry the largest multiplier AND the
     *      widest window. Evaluating the rate once at the interval midpoint and
     *      scaling it by the multiplier integral therefore overcharges by about
     *      a factor of two over a month-long interval, by an amount that depends
     *      on how often the pool happened to be touched.
     *
     *      The interval is split at every point where either factor changes
     *      shape — each wind-down doubling, and each doubling of the window
     *      itself — and integrated with Simpson's rule inside each piece. The
     *      window is linear in time, so 1/window is convex, and a midpoint rule
     *      on a piece spanning a full doubling undercharges it by 3.8 %; Simpson
     *      on the same piece is within 0.2 %. Both bounds are compile-time: the
     *      window doubles at most log2(30 days / 1 hour) ~ 10 times over the life
     *      of any market, and the wind-down shift is capped at
     *      WIND_DOWN_MAX_SHIFT, so the walk is bounded at _MAX_INTEGRATION_STEPS
     *      pieces however long the pool has been left alone.
     *
     * @param windowRef The funding window the caller evaluated its rate at. With
     *                  no wind-down and a single piece this cancels exactly and
     *                  the result is the plain elapsed time.
     */
    function _weightedElapsed(uint256 from, uint256 to, uint256 windowRef)
        internal
        view
        returns (uint256 weighted)
    {
        if (to <= from) return 0;

        uint256 t = from;
        for (uint256 i = 0; i < _MAX_INTEGRATION_STEPS && t < to; i++) {
            uint256 next  = _nextIntegrationBoundary(t, to);
            uint256 shift = _windDownShift(t);
            weighted += _simpson(t, next, windowRef) << shift;
            t = next;
        }

        // Unreachable given the bounds above, but a silently truncated integral
        // would be a silent undercharge, so the remainder is charged flat at the
        // rate in force where the walk stopped rather than dropped.
        if (t < to) {
            weighted += _simpson(t, to, windowRef) << _windDownShift(t);
        }
    }

    /**
     * @dev The next point at or before `to` where the funding rate changes
     *      shape: a wind-down doubling, or a doubling of the window.
     */
    function _nextIntegrationBoundary(uint256 t, uint256 to) internal view returns (uint256) {
        uint256 next = to;

        // Next wind-down doubling.
        if (closeDate != 0 && t >= closeDate) {
            uint256 shift = (t - closeDate) / WIND_DOWN_DOUBLING;
            if (shift < WIND_DOWN_MAX_SHIFT) {
                uint256 stepEnd = closeDate + (shift + 1) * WIND_DOWN_DOUBLING;
                if (stepEnd < next) next = stepEnd;
            }
        } else if (closeDate != 0 && closeDate < next) {
            next = closeDate;
        }

        // Next doubling of the window. Once the window has reached its ceiling
        // it stops moving and there are no further boundaries from this source.
        uint256 w = _fundingWindowAt(t);
        if (w < FUNDING_WINDOW_MAX) {
            uint256 target = 2 * w;
            if (target > FUNDING_WINDOW_MAX) target = FUNDING_WINDOW_MAX;
            // window(t) = FUNDING_WINDOW_MIN + (t - createdAt), so the time at
            // which it reaches `target` is direct.
            uint256 at = createdAt + target - FUNDING_WINDOW_MIN;
            if (at > t && at < next) next = at;
        }

        return next;
    }

    /**
     * @dev Simpson's rule for the integral of windowRef / window(t) over
     *      [a, b], i.e. the length of that interval re-expressed in units of the
     *      reference window so it can be compounded at a single rate.
     *
     *        (b - a) / 6 * windowRef * (1/w(a) + 4/w(mid) + 1/w(b))
     *
     *      Kept as one fraction so the three reciprocals are never truncated
     *      individually — at a 30-day window they would each floor to zero.
     */
    function _simpson(uint256 a, uint256 b, uint256 windowRef)
        internal
        view
        returns (uint256)
    {
        if (b <= a) return 0;
        uint256 wa = _fundingWindowAt(a);
        uint256 wm = _fundingWindowAt((a + b) / 2);
        uint256 wb = _fundingWindowAt(b);
        uint256 num = (b - a) * windowRef * (wm * wb + 4 * wa * wb + wa * wm);
        return num / (6 * wa * wm * wb);
    }

    /**
     * @notice Length of the current funding window, in seconds. One hour at
     *         market creation, widening by one second per second, capped at 30
     *         days. See FUNDING_WINDOW_MIN.
     */
    function fundingWindow() external view returns (uint256) {
        return _fundingWindowAt(block.timestamp);
    }

    function _fundingWindowAt(uint256 atTs) internal view returns (uint256) {
        uint256 age = atTs > createdAt ? atTs - createdAt : 0;
        uint256 w   = FUNDING_WINDOW_MIN + age;
        return w > FUNDING_WINDOW_MAX ? FUNDING_WINDOW_MAX : w;
    }

    /**
     * @notice How many times the funding rate is currently doubled by the
     *         wind-down. 0 while the pool is open or inside the grace period.
     */
    function windDownShift() external view returns (uint256) {
        return _windDownShift(block.timestamp);
    }

    function _windDownShift(uint256 atTs) internal view returns (uint256) {
        if (closeDate == 0 || atTs <= closeDate) return 0;
        uint256 shift = (atTs - closeDate) / WIND_DOWN_DOUBLING;
        return shift > WIND_DOWN_MAX_SHIFT ? WIND_DOWN_MAX_SHIFT : shift;
    }

    /**
     * @notice Collateral currently backing `pos`, net of all funding charged to
     *         its side since it opened — including funding not yet accrued to
     *         storage.
     *
     *         This, not `Position.lockedAmountAtOpen`, is the position's real
     *         size. Every consumer must read it here.
     */
    function effectiveLockedOf(uint256 nftId) external view returns (uint256) {
        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();
        return effectiveLocked(pos);
    }

    /**
     * @notice Fraction of its opening size that position `nftId` still has, in
     *         bps — collateral, debt and notional alike, since funding shrinks
     *         them together. 10000 = untouched, 0 = fully decayed.
     *
     *         The honest headline number for a UI: it is what the holder has
     *         paid in funding since opening, expressed as the thing that
     *         actually changed.
     */
    function remainingSizeBps(uint256 nftId) external view returns (uint256) {
        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();
        if (pos.lockedAmountAtOpen == 0) return 0;
        return (effectiveLocked(pos) * BPS_DENOM) / pos.lockedAmountAtOpen;
    }

    /**
     * @notice Everything funding shrinks about position `nftId`, as it stands
     *         right now: collateral, synthetic debt (airUsd for a long, airToken
     *         for a short) and USDC notional. All three decay by the same factor,
     *         so the position keeps its break-even price and simply gets smaller.
     *         Includes funding not yet accrued to storage.
     */
    function liveAmountsOf(uint256 nftId)
        external
        view
        returns (uint256 locked, uint256 debt, uint256 notional)
    {
        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();
        return _live(pos);
    }

    function effectiveLocked(Position memory pos) public view returns (uint256 locked) {
        (locked,,) = _live(pos);
    }

    /// @dev `pos`'s live amounts at its side's projected funding index.
    function _live(Position memory pos) internal view returns (uint256, uint256, uint256) {
        (uint256 idx,,) = _projectFunding(pos.isLong);
        return _liveAt(pos, idx);
    }

    /**
     * @dev `pos`'s collateral, debt and notional as of a given funding index.
     *      Each rounds DOWN, against _released rounding the aggregates' retained
     *      amounts up; see there for why the two biases must oppose.
     */
    function _liveAt(Position memory pos, uint256 idx)
        internal
        pure
        returns (uint256 locked, uint256 debt, uint256 notional)
    {
        uint256 debtAtOpen = pos.isLong ? pos.airUsdMinted : pos.airTokenMinted;
        uint256 opened = pos.fundingIndexAtOpen;
        // A position can never be at a HIGHER index than it opened at — the
        // indices only fall — so this is belt and braces against a malformed
        // position rather than a live branch.
        if (opened == 0 || idx >= opened) {
            return (pos.lockedAmountAtOpen, debtAtOpen, pos.usdcIn);
        }
        locked   = (pos.lockedAmountAtOpen * idx) / opened;
        debt     = (debtAtOpen * idx) / opened;
        notional = (pos.usdcIn * idx) / opened;
    }

    /**
     * @dev x^n with x and the result in RAY, by binary exponentiation.
     *
     *      Compounds the per-second decay exactly over an arbitrary interval.
     *      The obvious alternative — a linear `RAY - rate * elapsed` — is not
     *      merely imprecise but unsafe: at the opening rate of 10 % per hour it
     *      goes NEGATIVE after ten hours, so a pool nobody touched overnight
     *      would zero every position on it. This cannot, because every
     *      intermediate is a product of two values <= RAY.
     *
     *      Overflow: x <= RAY = 1e27, so x * x <= 1e54, far inside 2^256.
     *      Cost is one squaring per bit of `n` — about 25 for a year.
     */
    function _rpow(uint256 x, uint256 n) internal pure returns (uint256 z) {
        z = n % 2 != 0 ? x : RAY;
        for (n /= 2; n != 0; n /= 2) {
            x = (x * x) / RAY;
            if (n % 2 != 0) z = (z * x) / RAY;
        }
    }

    /**
     * @dev Clear whatever the aggregates still carry once the last position has
     *      left.
     *
     *      _released rounds each aggregate's retained amount up while _liveAt
     *      rounds each position's down, so the aggregates run a few wei ahead of
     *      the sum of their positions, and the gap grows by at most one wei per
     *      accrual. The bias is deliberate and in the safe direction, but the
     *      residue has to go somewhere. Collateral left behind would keep the
     *      reserve invariant demanding funds against positions that no longer
     *      exist, so it goes to the LP — where funding was sending it anyway.
     *      Debt and open interest left behind belong to nobody, so they are
     *      burned: the debt out of the supply counter it was minted into, which
     *      keeps both supply identities exact.
     */
    function _flushResidue() internal {
        if (openPositionCount != 0) return;
        if (totalLongCollateral != 0) {
            backedAirToken     += totalLongCollateral;
            totalLongCollateral = 0;
        }
        if (totalShortCollateral != 0) {
            backedAirUsd        += totalShortCollateral;
            totalShortCollateral = 0;
        }
        if (longOpenInterest != 0) {
            airUsdSupply    -= longOpenInterest;
            longOpenInterest = 0;
        }
        if (totalShortDebt != 0) {
            airTokenSupply -= totalShortDebt;
            totalShortDebt  = 0;
        }
        shortOpenInterest = 0;
    }

    // =========================================================================
    // INTERNAL — AMM math
    // =========================================================================

    /**
     * @dev Constant-product output formula with spot-price fee model.
     *      First computes the raw CP output (no fee), then deducts a fee equal
     *      to swapFeeBps percent of the input's SPOT VALUE (amountIn * Ro/Ri).
     *      This gives a true percentage-of-notional fee that scales with trade
     *      size, making large price-impacting swaps pay proportionally more.
     *
     *      rawOut  = amountIn * reserveOut / (reserveIn + amountIn)
     *      fee     = ⌈amountIn * reserveOut * swapFeeBps / (reserveIn * BPS_DENOM)⌉
     *      netOut  = rawOut - fee   (returns 0 if rawOut <= fee)
     *
     *      Maximum amountIn before fee >= rawOut:
     *        reserveIn * (BPS_DENOM - swapFeeBps) / swapFeeBps
     *      e.g. for 1% fee: 99 × reserveIn
     *
     *      The fee is rounded UP to the next output atom whenever it is
     *      mathematically positive. Flooring it let any trade whose spot-value
     *      fee came to less than one atom of the output token through at the
     *      full raw CP output — a free swap, contradicting the invariant that
     *      every swap retains fee value in the pool as LP yield (see
     *      swapFeeBps, which is fixed at 1 % to guarantee that friction). Dust
     *      trades whose raw output cannot cover even one atom of fee now return
     *      0 and are rejected by the netOut == 0 guards in both swap helpers.
     *
     *      Rounding up is also the correct direction for the settlement callers:
     *      _priceClose values a long's collateral through this function and
     *      prices a short's debt buyback with it, so a larger fee means a
     *      slightly lower surplus on both sides — never one the pool cannot pay.
     */
    function _cpAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) internal pure returns (uint256) {
        if (reserveIn == 0 || reserveOut == 0) return 0;
        uint256 rawOut = (amountIn * reserveOut) / (reserveIn + amountIn);

        uint256 feeNum = amountIn * reserveOut * swapFeeBps;
        uint256 feeDen = reserveIn * BPS_DENOM;
        // Ceil-divide so a positive fee never truncates to nothing. feeNum == 0
        // only when amountIn == 0, which the callers reject separately.
        uint256 fee = feeNum == 0 ? 0 : (feeNum + feeDen - 1) / feeDen;

        if (rawOut <= fee) return 0;
        return rawOut - fee;
    }



    // =========================================================================
    // INTERNAL — fee computation (single source of truth for position fees)
    // =========================================================================

    /**
     * @dev Base position fee: 5 % of notional (4 % LP + 1 % protocol) with a
     *      MIN_POSITION_FEE floor split in the same 4:1 ratio.
     */
    function _baseFees(uint256 notional)
        internal
        pure
        returns (uint256 totalFee, uint256 protocolFee, uint256 lpFee)
    {
        protocolFee = (notional * PROTOCOL_FEE_BPS) / BPS_DENOM;
        lpFee       = (notional * LP_FEE_BPS)       / BPS_DENOM;
        totalFee    = protocolFee + lpFee;
        if (totalFee < MIN_POSITION_FEE) {
            totalFee    = MIN_POSITION_FEE;
            protocolFee = (MIN_POSITION_FEE * PROTOCOL_FEE_BPS) / (PROTOCOL_FEE_BPS + LP_FEE_BPS);
            lpFee       = MIN_POSITION_FEE - protocolFee;
        }
    }

    /**
     * @dev Full open fee: base fee + OI-based integral impact fee (split-proof).
     *        impactFee = IMPACT_FEE_BPS × N × (2×OI + N) / (2 × backedAirUsd × BPS_DENOM)
     *      where OI is the same-side open interest BEFORE this position.
     *      The impact fee goes entirely to the LP. Returns base fee only when
     *      backedAirUsd == 0 (open paths revert on that separately; the quote
     *      view must not divide by zero).
     */
    function _openFees(uint256 notional, uint256 oi)
        internal
        view
        returns (uint256 totalFee, uint256 protocolFee, uint256 lpFee)
    {
        (totalFee, protocolFee, lpFee) = _baseFees(notional);
        if (backedAirUsd == 0) return (totalFee, protocolFee, lpFee);
        uint256 impactFee = (IMPACT_FEE_BPS * notional * (2 * oi + notional))
                          / (2 * backedAirUsd * BPS_DENOM);
        lpFee    += impactFee;
        totalFee += impactFee;
    }

    // =========================================================================
    // INTERNAL — leverage cap
    // =========================================================================

    function _checkLeverageCap(uint256 usdcNotional) internal view {
        uint256 cap = (backedAirUsd * currentMaxPositionBps()) / BPS_DENOM;
        if (usdcNotional > cap) revert LeverageCapExceeded();
    }

    // =========================================================================
    // INTERNAL — safe token pull
    // =========================================================================

    /**
     * @dev Pull `amount` of `token` from `from` into this contract and verify
     *      that the contract's balance increased by exactly `amount`.
     *      Reverts with FeeOnTransferNotSupported() for fee-on-transfer,
     *      rebasing, or other non-standard ERC-20s that deliver less than
     *      the requested amount.
     */
    function _transferIn(IERC20 token, address from, uint256 amount) internal {
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        if (token.balanceOf(address(this)) - balanceBefore != amount) {
            revert FeeOnTransferNotSupported();
        }
    }

    // =========================================================================
    // INTERNAL — fee accrual and payout crediting (pull payments)
    // =========================================================================

    /**
     * @dev Accrue an LP fee. Claimable by the LP NFT holder via claimFees(to).
     */
    function _accrueLpFee(uint256 amount) internal {
        if (amount == 0) return;
        lpFeesAccumulated += amount;
    }

    /**
     * @dev Accrue a protocol fee. Claimable by the treasury via
     *      claimProtocolFees(to).
     */
    function _accrueProtocolFee(uint256 amount) internal {
        if (amount == 0) return;
        protocolFeesAccumulated += amount;
    }

    /**
     * @dev Credit a settlement payout to `recipient`'s claimable balance.
     *      Withdrawable via claimPayout(to). Pure state write — cannot fail,
     *      so no recipient can block the settlement that credits it.
     */
    function _creditPayout(address recipient, uint256 amount) internal {
        if (amount == 0) return;
        claimable[recipient] += amount;
        totalClaimable += amount;
        emit PayoutCredited(recipient, amount);
    }

    // =========================================================================
    // INTERNAL — invariant assertion
    // =========================================================================

    /**
     * @dev Two families of solvency checks, run after every value-moving op:
     *
     *      1. Backed reserves must never exceed the corresponding supply
     *         counter — the pool cannot claim more units than exist.
     *
     *      2. The pool's REAL token balances must cover its accounted
     *         obligations: the underlying token balance must cover
     *         backedAirToken, and the USDC balance must cover backedAirUsd
     *         plus all accrued (unclaimed) LP fees, protocol fees, and
     *         credited payouts. The balances may legitimately exceed the
     *         accounted amounts (locked position collateral backing,
     *         donations) — never fall below.
     */
    function _assertReserveInvariant() internal view {
        if (backedAirToken > airTokenSupply) revert ReserveInvariantViolated();
        if (backedAirUsd  > airUsdSupply)  revert ReserveInvariantViolated();
        // Long collateral is held here but deliberately absent from
        // backedAirToken, so the obligation is the sum of the two. Omitting it
        // left this as a lower bound that could not tell a healthy pool from
        // one that had leaked that collateral (audit SI-001).
        if (underlyingToken.balanceOf(address(this))
            < backedAirToken + totalLongCollateral) {
            revert ReserveInvariantViolated();
        }
        // Every USDC liability this contract carries: LP-backed reserves, short
        // collateral held for traders, unclaimed fees, and credited payouts.
        // Short collateral used to be omitted, which left it as untracked
        // surplus — the check passed whether or not that collateral was still
        // there, so it could not detect a leak of it.
        if (underlyingUsdc.balanceOf(address(this))
            < backedAirUsd
            + totalShortCollateral
            + lpFeesAccumulated
            + protocolFeesAccumulated
            + totalClaimable) {
            revert ReserveInvariantViolated();
        }
    }
}
