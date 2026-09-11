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
 *        Long  — lockedAmount = airTokenLocked (airToken units),
 *                usdcIn, airUsdMinted, feesPaid
 *        Short — lockedAmount = airUsdLocked (airUsd units),
 *                airTokenMinted, feesPaid
 */
struct Position {
    bool    isLong;
    address pool;
    uint256 lockedAmount;
    uint256 usdcIn;
    uint256 airUsdMinted;
    uint256 airTokenMinted;
    uint256 feesPaid;
    uint256 openedAt;
    uint256 deadline;
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
        uint256 deadline
    ) external returns (uint256 tokenId);

    function mintShort(
        address to,
        address pool,
        uint256 airTokenMinted,
        uint256 airUsdLocked,
        uint256 usdcIn,
        uint256 feesPaid,
        uint256 deadline
    ) external returns (uint256 tokenId);

    function release(uint256 tokenId) external returns (Position memory);

    function applyRenewal(
        uint256 tokenId,
        uint256 newLockedAmount,
        uint256 newAirUsdMinted,
        uint256 addFeesPaid,
        uint256 newDeadline
    ) external;

    function getAutoRenew(uint256 tokenId) external view returns (bool enabled, uint256 maxFee);

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
 *   pos.lockedAmount from the relevant supply where required.
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

    /// @dev Position lifetime, stepped by market age. Like the size cap, this is
    ///      automatic rather than a creation parameter: a duration is genuinely
    ///      hard to pick correctly up front, and the right answer changes as a
    ///      market ages.
    ///
    ///      A market's first hours are its most volatile — a week-long position
    ///      opened into a token with no price history is a bet on noise, and the
    ///      LP writes it. Short lifetimes early force frequent repricing through
    ///      the renewal fee, which is exactly when repricing is worth most. Once
    ///      the market has a week behind it, long-dated positions are a normal
    ///      product rather than an asymmetric one.
    ///
    ///      MUST be non-decreasing in market age. closePool sets
    ///      closeDate = now + currentPositionDuration(), and the bound on how
    ///      long the LP can be kept waiting by it depends on no earlier
    ///      position having been issued a longer lifetime.
    uint256 private constant DURATION_AGE_1 = 1 hours;
    uint256 private constant DURATION_AGE_2 = 8 hours;
    uint256 private constant DURATION_AGE_3 = 24 hours;
    uint256 private constant DURATION_AGE_4 = 7 days;
    uint256 private constant DURATION_MAX   = 30 days;

    /// @dev Absolute ceiling on how far past NOW a renewal may place a deadline.
    ///
    ///      renewPosition extends from the position's existing deadline rather
    ///      than from now, so renewals STACK. closeDate was the only other
    ///      bound and it is zero until the LP closes the pool, so without this
    ///      a holder could push a deadline out arbitrarily far — and
    ///      removeLiquidity reverts while openPositionCount != 0. A dust
    ///      position renewed at the MIN_POSITION_FEE floor would freeze 100 %
    ///      of LP principal for as long as it cared to keep paying, at a cost
    ///      independent of pool size.
    ///
    ///      Two times DURATION_MAX. That is the smallest horizon that still
    ///      lets a position on the 30-day ceiling renew before it expires:
    ///      renewing a freshly opened one lands exactly on the horizon and is
    ///      allowed, renewing that result again is not. So a holder always has
    ///      one renewal in hand and never has to race their own deadline, and
    ///      a long-dated position has to be allowed to run down before it can
    ///      be extended again. Below the ceiling — a market's first week, where
    ///      durations are hours — renewal stays effectively unlimited, which is
    ///      the intent: short positions renew often, long ones renew once.
    ///
    ///      What it guarantees the LP: every deadline a renewal writes is at
    ///      most RENEW_HORIZON past the moment it was written, so at any time T
    ///      no outstanding position can expire later than T + RENEW_HORIZON.
    ///      closePool at T therefore bounds the wait for removeLiquidity at 60
    ///      days instead of leaving it open-ended.
    ///
    ///      It does NOT make closeDate bind retroactively: a deadline already
    ///      stacked past closeDate stands, and closePositionAfterDeadline
    ///      cannot reach that position until it passes. The wait is bounded,
    ///      not eliminated.
    uint256 private constant RENEW_HORIZON = 2 * DURATION_MAX; // 60 days from now

    /// @dev Expiry-settlement manipulation guard. Both expiry entry points read
    ///      live AMM reserves — through _priceClose for the payout and through
    ///      _renewFees for the auto-renew decision — so a third party could
    ///      otherwise swap, settle, and reverse the swap atomically: flipping a
    ///      renewable position onto the close path against the holder's recorded
    ///      opt-in, or suppressing the priced surplus the close pays out. The
    ///      round trip costs 2 × swapFeeBps, which the pool's sole LP receives
    ///      back into its own reserves (see _swapTokenToUsdc), so for the LP —
    ///      the only party that profits from either outcome — it is very nearly
    ///      free.
    ///
    ///      Two constants close it together, and the pairing is what makes it
    ///      work:
    ///
    ///        SETTLE_GUARD_BPS   a swap moving at least this fraction of
    ///                           backedAirUsd arms the guard, blocking
    ///                           third-party settlement for SETTLE_GUARD_BLOCKS.
    ///        RENEW_MARGIN_BPS   the auto-renew decision must clear the equity
    ///                           test by this fraction of the position's MARK.
    ///
    ///      The pairing rests on constant-product output being proportional to
    ///      the output-side reserve: a swap that moves backedAirUsd by a fraction
    ///      f of its depth moves a long's priced value (airUsdOut through SWAP-3)
    ///      by very nearly the same f, and correspondingly moves a short's
    ///      buyback cost through SWAP-2. So the achievable surplus swing is
    ///      ≈ f × mark, where mark = N + surplus — the same quantity _renewFees
    ///      prices the base fee on — and NOT f × N. Basing the margin on the
    ///      notional would under-size it by mark/N, which on a position several
    ///      times in profit is several-fold.
    ///
    ///      Capping f at SETTLE_GUARD_BPS therefore caps the swing at
    ///      SETTLE_GUARD_BPS × mark, and a margin of RENEW_MARGIN_BPS × mark
    ///      above that bound cannot be crossed by any swap small enough to evade
    ///      the guard. Dust cannot grief settlement, and real manipulation cannot
    ///      hide under the threshold.
    ///
    ///      RENEW_MARGIN_BPS is set to twice SETTLE_GUARD_BPS: the proportionality
    ///      above is first-order, so the factor absorbs curve convexity and the
    ///      integer flooring of the margin itself.
    ///
    ///      SETTLE_GUARD_BPS = 1 % also lines up with the swap fee: the smallest
    ///      flip-capable manipulation is about the size at which reversing it
    ///      becomes profitable for an arbitrageur, so the blocked blocks are real
    ///      exposure rather than a notional delay.
    uint256 private constant SETTLE_GUARD_BPS    = 100; // 1 % of backedAirUsd arms
    uint256 private constant RENEW_MARGIN_BPS    = 200; // 2 % of mark margin
    /// @dev Blocks of arbitrage exposure a manipulator must survive before it can
    ///      settle someone else's expired position. ~10 s at Avalanche block times.
    uint256 private constant SETTLE_GUARD_BLOCKS = 5;

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

    /// @notice USDC payouts (6 dec) credited from third-party-triggered
    ///         settlements (expired-position closes). Pull payment — the
    ///         recipient withdraws via claimPayout(to), so no recipient can
    ///         ever block position cleanup.
    mapping(address => uint256) public claimable;

    /// @notice Sum of all outstanding claimable payouts (solvency accounting).
    uint256 public totalClaimable;

    /// @notice Total number of open long + short positions.
    uint256 public openPositionCount;

    /// @notice Sum of USDC notional for all open long positions (6 dec).
    uint256 public longOpenInterest;

    /// @notice Sum of USDC notional for all open short positions (6 dec).
    uint256 public shortOpenInterest;

    /// @notice Duration (seconds) of each position period before expiry.
    ///         Set at market creation (1 hour – 1 year, default 7 days).

    /// @notice Timestamp after which no new positions can be opened and
    ///         existing positions cannot be renewed past. 0 = pool is open.
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
    ///         Long renewals do not touch it: applyRenewal carries
    ///         pos.lockedAmount through unchanged and charges the fee to
    ///         backedAirUsd instead, so the only movements are open and settle.
    uint256 public totalLongCollateral;

    /// @notice Block of the last swap large enough to move an expiry settlement
    ///         decision (see SETTLE_GUARD_BPS). Third-party settlement of an
    ///         expired position is blocked for SETTLE_GUARD_BLOCKS afterwards.
    ///         0 = never armed.
    ///
    /// @dev    Set by _armSettlementGuard from EVERY reserve-mutating path
    ///         except _settle, whenever a settlement price has moved
    ///         SETTLE_GUARD_BPS since the block opened.
    ///
    ///         `_settle` is the one deliberate exclusion, so a keeper can batch
    ///         several expiries in one block. It is safe in a way the former
    ///         openLong/openShort exclusion was not: the holder is exempt from
    ///         the guard anyway, so settlement is useless as a self-directed
    ///         lever, and a settle's price impact is fixed by the expiring
    ///         position's own size and side rather than chosen by the caller.
    ///         With no keeper bounty, batching is load-bearing for cleanup.
    uint256 public lastLargeSwapBlock;

    /// @dev The four reserve terms as one block OPENED, plus the block they
    ///      describe. A long settles against backedAirUsd / airTokenSupply, a
    ///      short against backedAirToken / airUsdSupply.
    ///      `timestamp` is carried alongside `blockNumber` so a snapshot can be
    ///      compared against Position.openedAt, which PositionNFT records as a
    ///      timestamp. A block's open predates any position opened IN that
    ///      block, and valuing a position against reserves from before it
    ///      existed is meaningless — see _priceCloseClamped.
    struct GuardSnapshot {
        uint256 blockNumber;
        uint256 timestamp;
        uint256 backedUsd;
        uint256 tokenSupply;
        uint256 backedToken;
        uint256 usdSupply;
    }

    /// @dev Ring of the opens of the last SETTLE_GUARD_BLOCKS blocks in which
    ///      the reserves were mutated. `guardRingHead` indexes the newest.
    ///
    ///      Two consumers, not one. _armSettlementGuard measures this block's
    ///      displacement against the newest entry; _priceCloseClamped clamps a
    ///      settlement payout to the worst of every entry still inside the
    ///      window. The second is what stops a holder pricing their own close
    ///      against a swap they made recently (H-2). The pairs are exactly the
    ///      ones _priceCloseAt reads, on both sides — the guard and settlement
    ///      pricing measure the same two prices, so one snapshot serves both and
    ///      they cannot disagree about what a block "opened with" means.
    ///
    ///      Sized to the window deliberately: entries are one per block and the
    ///      window admits blocks `asOfBlock - SETTLE_GUARD_BLOCKS + 1 ..
    ///      asOfBlock`, so SETTLE_GUARD_BLOCKS slots can never drop an entry
    ///      that is still eligible. Written once per block, so the per-block
    ///      cost is the same five words the single snapshot it replaced cost.
    GuardSnapshot[SETTLE_GUARD_BLOCKS] private guardRing;
    uint256 private guardRingHead;

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
    error PositionNotExpired();
    error PoolClosing();
    error PoolAlreadyClosed();
    error RenewalExceedsCloseDate();
    error RenewalExceedsHorizon();
    error OnlyLpHolderOrDeployer();
    error OnlyTreasury();
    error RenewalFeeExceedsMax();
    error AutoRenewActive();
    error SettlementGuardActive();

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
    event PositionRenewed(
        uint256 indexed nftId,
        address indexed caller,
        uint256 feePaid,
        uint256 newDeadline,
        bool autoRenewed
    );
    event PositionClosed(uint256 indexed nftId, address indexed holder, uint256 payout);
    event PositionClosedAfterDeadline(uint256 indexed nftId, address indexed caller, uint256 payout);
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
     * @dev Every path that mutates the backed reserves carries this. It pins the
     *      block's opening reserves before the body runs, asserts conservation
     *      after it, and re-arms the settlement guard from the resulting price
     *      displacement.
     *
     *      Binding the three together is the point. The settlement guard used to
     *      be armed by hand at the two swap sites, and openLong/openShort — which
     *      move the opposite side's settlement price by up to twenty times the
     *      arming threshold — were simply never wired to it. A guard hung off
     *      the same hook as the reserve invariant cannot be omitted from a new
     *      path without also dropping the invariant, which no review would miss.
     */
    modifier reserveMutation() {
        _guardSnapshot();
        _;
        _assertReserveInvariant();
        _armSettlementGuard();
    }

    /**
     * @dev As reserveMutation, but does not arm the guard. `_settle` is the only
     *      user — see lastLargeSwapBlock for why settlement is excluded. Named
     *      rather than left as a missing call so the exception is greppable.
     */
    modifier reserveMutationUnarmed() {
        _guardSnapshot();
        _;
        _assertReserveInvariant();
    }

    // ── Admin functions ───────────────────────────────────────────────────────

    /**
     * @notice Initiate pool closure. Sets closeDate = now + currentPositionDuration().
     *
     *         Once set:
     *           - No new positions can be opened (openLong / openShort revert).
     *           - Positions cannot be renewed past closeDate.
     *           - After closeDate all positions are guaranteed expired and can
     *             be closed via closePositionAfterDeadline(), allowing the LP to call removeLiquidity().
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

        closeDate = block.timestamp + currentPositionDuration();

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
     *   totalSupply until the position is closed.
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
        // airTokenSupply and is recorded as pos.lockedAmount on the NFT.
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
            block.timestamp + currentPositionDuration()
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
     */
    function closeLong(uint256 nftId, uint256 minUsdcOut) external nonReentrant {
        address holder = positionNFT.ownerOf(nftId);
        if (holder != msg.sender) revert OnlyPositionHolder();

        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();
        if (!pos.isLong) revert PositionNotLong();

        _settle(nftId, pos, holder, minUsdcOut, false);
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
     *   airTokenSupply until the position is closed.
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

        // Real airUsd leaves the backed reserves; it stays counted in
        // airUsdSupply and is recorded as pos.lockedAmount on the NFT.
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
            block.timestamp + currentPositionDuration()
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
     */
    function closeShort(uint256 nftId, uint256 minUsdcOut) external nonReentrant {
        address holder = positionNFT.ownerOf(nftId);
        if (holder != msg.sender) revert OnlyPositionHolder();

        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();
        if (pos.isLong) revert PositionNotShort();

        _settle(nftId, pos, holder, minUsdcOut, false);
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
    function removeLiquidity() external nonReentrant onlyLpHolder {
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
     *         on every position open/renewal and are withdrawn here.
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
     * @notice Withdraw USDC payouts credited to the caller by third-party
     *         settlements (expired-position closes). Sends the full amount
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
    // POSITION RENEWAL & EXPIRY
    // =========================================================================

    /**
     * @notice Renew a position by paying the dynamic renewal fee, extending the
     *         deadline by one currentPositionDuration() from the current deadline (or
     *         from now if the position has already expired).
     *         Only the position holder may renew — this prevents third parties
     *         from indefinitely extending positions to grief the LP's exit.
     *
     *         Because the extension starts from the existing deadline, renewals
     *         stack, and RENEW_HORIZON caps how far past now the result may
     *         land. Short-dated positions can therefore renew repeatedly while
     *         one already on the 30-day ceiling gets a single renewal and must
     *         then run down before it can be extended again. Quote the outcome
     *         with quoteRenewDeadline rather than reproducing the rule.
     *
     *         The fee reprices the position at today's state (see _renewFees):
     *         base fee on current mark value plus the position's slice of the
     *         OI-integral impact fee at current open interest and reserves.
     *
     * @param nftId   Position NFT to renew.
     * @param maxFee  Guard against fee movement between quote and execution
     *                (the fee depends on live reserves, PnL, and OI).
     */
    function renewPosition(uint256 nftId, uint256 maxFee) external nonReentrant {
        if (positionNFT.ownerOf(nftId) != msg.sender) revert OnlyPositionHolder();

        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();

        (uint256 totalFee, uint256 protocolFee, uint256 lpFee,) = _renewFees(pos);
        if (totalFee > maxFee) revert RenewalFeeExceedsMax();

        uint256 newDeadline = _renewDeadline(pos.deadline);

        // Absolute bound, measured from now rather than from the position's own
        // history, so no sequence of renewals can walk a deadline outwards. See
        // RENEW_HORIZON. Checked before closeDate because it always applies —
        // closeDate is zero on a pool that is not closing.
        if (newDeadline > block.timestamp + RENEW_HORIZON) revert RenewalExceedsHorizon();

        // If pool is closing, the new deadline must not exceed closeDate.
        if (closeDate != 0 && newDeadline > closeDate) revert RenewalExceedsCloseDate();

        // INTERACTIONS
        _transferIn(underlyingUsdc, msg.sender, totalFee);
        _accrueProtocolFee(protocolFee);
        _accrueLpFee(lpFee);
        positionNFT.applyRenewal(nftId, pos.lockedAmount, pos.airUsdMinted, totalFee, newDeadline);

        emit PositionRenewed(nftId, msg.sender, totalFee, newDeadline, false);
    }

    /**
     * @notice Settle an expired position. Callable by anyone.
     *
     *         Callers are unpaid: cleanup is funded by the incentives the
     *         parties already have — the LP earns the renewal fee on an
     *         auto-renew and gets its capital back on a close, and the holder
     *         collects their own payout. A bounty carved from the settlement
     *         flow could exceed the payout it was carved from and hand a
     *         keeper the holder's entire profit, which is worse than a
     *         position that simply waits.
     *
     *         If the holder opted into auto-renewal (PositionNFT.setAutoRenew)
     *         and the position's own equity covers the dynamic renewal fee with
     *         the RENEW_MARGIN_BPS margin — and the fee is within the holder's
     *         cap and the new deadline within closeDate — the position is
     *         renewed instead of closed, with the fee charged against its
     *         equity:
     *
     *           Long  — synthetic debt (airUsdMinted) grows by the fee. The
     *                   USDC leaves backedAirUsd now and is recouped at close
     *                   through the equally-reduced surplus.
     *           Short — locked airUsd collateral shrinks by the fee.
     *
     *         A winning position therefore sustains itself; a position that
     *         cannot pay is settled exactly like closePositionAfterDeadline
     *         (profit credited as pull payment, or collateral returned to LP).
     *
     * @param nftId      Position NFT to settle.
     * @param minPayout  Slippage guard on the holder's credited payout when the
     *                   close path runs (0 = accept any outcome).
     */
    function settleExpired(uint256 nftId, uint256 minPayout) external nonReentrant {
        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();
        if (block.timestamp < pos.deadline) revert PositionNotExpired();

        address holder = positionNFT.ownerOf(nftId);
        // Guards both outcomes: the renew/close decision below and, on the close
        // path, the surplus _settle pays out from the same live reserves.
        _assertSettlementUnguarded(holder);

        if (_tryAutoRenew(nftId, pos)) return;

        _settle(nftId, pos, holder, minPayout, true);
    }

    /**
     * @dev Checks whether the keeper-driven auto-renewal can execute for an
     *      expired position: holder opted in, dynamic fee within the holder's
     *      cap, equity covers the fee by RENEW_MARGIN_BPS of notional, new
     *      deadline within closeDate.
     *
     *      The margin is the second half of the settlement guard. Both the
     *      equity test and the fee are priced from live reserves, so without it
     *      a position sitting at surplus ≈ totalFee flips outcome on an
     *      arbitrarily small nudge — cheap enough to stay under
     *      SETTLE_GUARD_BPS and slip past the block guard. Requiring the test to
     *      clear by RENEW_MARGIN_BPS of the position's MARK means any flip needs
     *      a swap large enough to arm that guard; see SETTLE_GUARD_BPS for why
     *      the mark, and not the notional, is the right base.
     *
     *      Deliberately strict rather than tolerant: renewing on a surplus that
     *      does not actually cover the fee would have _tryAutoRenew charge the
     *      shortfall to backedAirUsd, i.e. the LP advancing real USDC against
     *      equity the position does not have. The cost of strictness is that a
     *      position whose surplus lands inside the margin closes instead of
     *      renewing — it could only have funded a renewal that left it with
     *      near-zero equity anyway, and it is paid its surplus on the close.
     */
    function _autoRenewQuote(uint256 nftId, Position memory pos)
        internal
        view
        returns (bool ok, uint256 totalFee, uint256 protocolFee, uint256 lpFee)
    {
        (bool enabled, uint256 maxFee) = positionNFT.getAutoRenew(nftId);
        if (!enabled) return (false, 0, 0, 0);

        uint256 surplus;
        (totalFee, protocolFee, lpFee, surplus) = _renewFees(pos);
        if (totalFee > maxFee) return (false, 0, 0, 0);

        uint256 n = pos.isLong ? pos.airUsdMinted : pos.usdcIn;
        uint256 margin = ((n + surplus) * RENEW_MARGIN_BPS) / BPS_DENOM;
        if (surplus < totalFee + margin) return (false, 0, 0, 0);

        // Expired ⇒ the new deadline extends from now.
        if (closeDate != 0 && block.timestamp + currentPositionDuration() > closeDate) {
            return (false, 0, 0, 0);
        }
        ok = true;
    }

    /**
     * @dev Execute the auto-renewal if possible. Returns false (no state
     *      change) when any condition fails, letting the caller fall through
     *      to the close path.
     */
    function _tryAutoRenew(uint256 nftId, Position memory pos) internal reserveMutation returns (bool) {
        (bool ok, uint256 totalFee, uint256 protocolFee, uint256 lpFee) =
            _autoRenewQuote(nftId, pos);
        if (!ok) return false;

        uint256 cost = totalFee;
        // Extends from now, not from the old deadline — the auto path only runs
        // on an already-expired position, and it does not stack. That is why it
        // needs no RENEW_HORIZON check: currentPositionDuration() is capped at
        // DURATION_MAX and the horizon is twice that, so this can never reach it.
        uint256 newDeadline = block.timestamp + currentPositionDuration();

        // ── EFFECTS — charge the position's own equity ───────────────────────
        if (pos.isLong) {
            // The fee leaves the backed reserves now; the position's debt
            // grows by the same amount, so the surplus paid from backedAirUsd
            // at close shrinks equally — the LP is made whole over the cycle.
            // airUsdSupply is net unchanged: −cost (USDC leaving reserve
            // accounting) +cost (new synthetic debt).
            backedAirUsd     -= cost;
            longOpenInterest += cost; // OI tracks airUsdMinted; keep in sync for _settle
            positionNFT.applyRenewal(
                nftId, pos.lockedAmount, pos.airUsdMinted + cost, totalFee, newDeadline
            );
        } else {
            // The fee comes out of the locked airUsd collateral, which
            // leaves pool accounting (it was counted in airUsdSupply only).
            airUsdSupply         -= cost;
            totalShortCollateral -= cost; // lockedAmount shrinks by the same cost
            positionNFT.applyRenewal(
                nftId, pos.lockedAmount - cost, pos.airUsdMinted, totalFee, newDeadline
            );
        }
        _accrueProtocolFee(protocolFee);
        _accrueLpFee(lpFee);

        emit PositionRenewed(nftId, msg.sender, totalFee, newDeadline, true);
        return true;
    }

    /**
     * @notice Close an expired position. Callable by anyone after the deadline.
     *
     *         If the position is in profit, the profit (minus the 1 % close
     *         fee) is CREDITED to the holder's claimable balance — pull
     *         payment, withdrawable via claimPayout(). No push transfer means
     *         no recipient can ever block cleanup.
     *
     *         If the position is underwater, the locked collateral returns to the
     *         LP's backed reserves and the synthetic debt is cancelled. No payment
     *         to anyone — the position is simply cleaned up.
     *
     * @param nftId      Position NFT to close.
     * @param minPayout  Slippage guard on the holder's credited payout (profitable
     *                   branch). Pass 0 to accept any outcome (including underwater
     *                   liquidation with zero payout).
     */
    function closePositionAfterDeadline(uint256 nftId, uint256 minPayout) external nonReentrant {
        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();
        if (block.timestamp < pos.deadline) revert PositionNotExpired();

        address holder = positionNFT.ownerOf(nftId);
        _assertSettlementUnguarded(holder);

        // A position whose holder opted into auto-renewal (and whose equity can
        // fund it) must not be closeable through this path — otherwise anyone
        // could bypass the opt-in and kill the position. settleExpired() will
        // renew it instead. Same predicate as the renew branch, so there is no
        // band where this path refuses and settleExpired closes anyway.
        (bool renewable,,,) = _autoRenewQuote(nftId, pos);
        if (renewable) revert AutoRenewActive();

        _settle(nftId, pos, holder, minPayout, true);
    }

    // =========================================================================
    // VIEWS
    // =========================================================================

    /**
     * @notice First block at which a third party may settle an expired position.
     *         0 means unguarded now. Keepers should poll this rather than
     *         discovering the window through a reverted settleExpired.
     *         The position holder is never blocked (see
     *         _assertSettlementUnguarded), so this does not apply to them.
     */
    function settlementGuardedUntilBlock() external view returns (uint256) {
        // Mirrors _assertSettlementUnguarded's wind-down exemption, so a keeper
        // polling this is never told to wait for a window that will not be
        // enforced.
        if (closeDate != 0) return 0;
        if (lastLargeSwapBlock == 0) return 0;
        uint256 until = lastLargeSwapBlock + SETTLE_GUARD_BLOCKS;
        return block.number < until ? until : 0;
    }

    /**
     * @notice Relative move, in bps, that either settlement price must make
     *         within one block to arm the guard.
     *
     * @dev    Replaces the former settlementGuardArmingSize(), which reported a
     *         single swap's USDC size. Arming is no longer a property of one
     *         call: it is the net displacement of backedAirUsd / airTokenSupply
     *         or backedAirToken / airUsdSupply since the block opened, from any
     *         reserve-mutating path. There is no longer a "size that arms".
     */
    function settlementGuardBps() external pure returns (uint256) {
        return SETTLE_GUARD_BPS;
    }

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
            uint256 protocolFeesLifetime
        )
    {
        backedAirToken_      = backedAirToken;
        backedAirUsd_        = backedAirUsd;
        longPrice_           = _longPrice();
        shortPrice_          = _shortPrice();
        lpFeesLifetime       = lpFeesAccumulated + lpFeesPaidTotal;
        protocolFeesLifetime = protocolFeesAccumulated + protocolFeesPaidTotal;
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
     * @notice Lifetime a position opened right now would receive, in seconds.
     *
     *         Stepped by market age rather than smoothly interpolated: the four
     *         steps are the product, and a reader can tell at a glance what they
     *         will get. Non-decreasing, which closePool relies on.
     *
     *           age < 1 hour    →  1 hour
     *           age < 8 hours   →  8 hours
     *           age < 24 hours  →  24 hours
     *           age < 7 days    →  7 days
     *           age >= 7 days   →  30 days  (the ceiling)
     */
    function currentPositionDuration() public view returns (uint256) {
        uint256 age = block.timestamp - createdAt;
        if (age < DURATION_AGE_1) return DURATION_AGE_1;
        if (age < DURATION_AGE_2) return DURATION_AGE_2;
        if (age < DURATION_AGE_3) return DURATION_AGE_3;
        if (age < DURATION_AGE_4) return DURATION_AGE_4;
        return DURATION_MAX;
    }

    /**
     * @dev Deadline a renewal would write for a position currently expiring at
     *      `currentDeadline`. Extends from that deadline, or from now once it
     *      has passed, so an expired position is never punished for the delay.
     *
     *      Single source of truth for renewPosition and quoteRenewDeadline, so
     *      the executed deadline and the quoted one cannot drift.
     */
    function _renewDeadline(uint256 currentDeadline) internal view returns (uint256) {
        uint256 base = currentDeadline > block.timestamp ? currentDeadline : block.timestamp;
        return base + currentPositionDuration();
    }

    /**
     * @notice The deadline renewPosition(nftId, ...) would write right now, and
     *         whether the call would be accepted.
     *
     *         `allowed == false` means renewPosition reverts: the position is
     *         already extended as far as RENEW_HORIZON permits, or the pool is
     *         closing and the extension would outlive closeDate. `newDeadline`
     *         is reported either way, so a frontend can show how far the
     *         position would have to run down first.
     *
     *         Frontends and keepers must quote here rather than replicating the
     *         rule — this is its single source of truth alongside the executing
     *         path.
     */
    function quoteRenewDeadline(uint256 nftId)
        external
        view
        returns (uint256 newDeadline, bool allowed)
    {
        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();

        newDeadline = _renewDeadline(pos.deadline);
        allowed =
            newDeadline <= block.timestamp + RENEW_HORIZON &&
            (closeDate == 0 || newDeadline <= closeDate);
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
        (totalFee,,) = _openFees(notional, isLong ? longOpenInterest : shortOpenInterest);
    }

    /**
     * @notice Total USDC fee charged to renew position `nftId` right now.
     *         Dynamic — repriced at current mark value, OI, and reserves (see
     *         _renewFees). This is the single source of truth for the fee —
     *         frontends must quote here instead of replicating the formula.
     */
    function quoteRenewFee(uint256 nftId) external view returns (uint256 totalFee) {
        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();
        (totalFee,,,) = _renewFees(pos);
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
     *      in this state stays uncloseable and still expires worthless.
     *
     *      Short: the debt costs more airUsd than the collateral can buy. The
     *      proportional cost is extrapolated from the partial fill the curve
     *      does allow; with no fill at all the loss is the whole collateral.
     *      Long: no airToken supply outside the position means nothing can be
     *      realised, so the entire synthetic debt is the shortfall.
     */
    function _quoteShortfall(Position memory pos) internal view returns (uint256) {
        if (pos.isLong) return pos.airUsdMinted;
        if (airUsdSupply < pos.lockedAmount) return pos.lockedAmount;

        uint256 totalBuyable = _cpAmountOut(
            pos.lockedAmount,
            airUsdSupply - pos.lockedAmount,
            backedAirToken
        );
        if (totalBuyable == 0) return pos.lockedAmount;

        uint256 cost =
            (pos.lockedAmount * pos.airTokenMinted + totalBuyable - 1) / totalBuyable;
        return cost > pos.lockedAmount ? cost - pos.lockedAmount : 0;
    }

    // =========================================================================
    // INTERNAL — expiry settlement guard
    // =========================================================================

    /**
     * @dev Record the reserves this block opened with, once per block, before
     *      any mutation. Paired with _armSettlementGuard by the reserveMutation
     *      modifiers so the snapshot and the check can never drift apart.
     */
    function _guardSnapshot() internal {
        // At most one entry per block: the first mutation of a block records
        // what that block opened with, and every later mutation in the same
        // block is part of what the entry is there to measure.
        if (guardRing[guardRingHead].blockNumber == block.number) return;

        uint256 next = guardRingHead + 1;
        if (next == SETTLE_GUARD_BLOCKS) next = 0;

        guardRing[next] = GuardSnapshot({
            blockNumber: block.number,
            timestamp:   block.timestamp,
            backedUsd:   backedAirUsd,
            tokenSupply: airTokenSupply,
            backedToken: backedAirToken,
            usdSupply:   airUsdSupply
        });
        guardRingHead = next;
    }

    /**
     * @dev Arm the settlement guard when either settlement price has moved by
     *      SETTLE_GUARD_BPS or more since this block opened.
     *
     *      Measures NET DISPLACEMENT OF THE PRICE, not the size of one call.
     *      The previous version compared a single swap's USDC leg against live
     *      depth, which failed two ways:
     *
     *        1. No aggregation. A sequence of individually sub-threshold swaps
     *           never armed it, however far they moved the price together, and
     *           the whole sequence plus a settlement fits in one block.
     *        2. Only swaps consulted it. openShort writes both terms a LONG's
     *           _priceClose reads, and openLong both a short's — at up to
     *           CAP_MAX_BPS (20 %) of depth, twenty times the threshold a swap
     *           arms at. Neither armed the guard at any size. The exclusion was
     *           justified on the open fee being a real cost, but LP_FEE_BPS is
     *           400 of the 500 bps base fee and the impact fee is wholly LP —
     *           so for an LP attacking its own pool's holders, which is the
     *           actor with both the access and the motive, ~80 % of that fee
     *           comes straight back.
     *
     *      Both ratios are checked because the two sides settle against
     *      different pairs: a long against backedAirUsd / airTokenSupply, a
     *      short against backedAirToken / airUsdSupply. See _priceClose.
     *
     *      Arming latches for the block. A move that is reverted later in the
     *      same block still arms, deliberately: the 5-block window exists so a
     *      manipulator cannot settle from a price they set in an earlier block,
     *      and recomputing downward would hand that back.
     */
    function _armSettlementGuard() internal {
        // The newest entry is this block's open: _guardSnapshot runs at the top
        // of the same modifier, before the mutation this is measuring.
        GuardSnapshot storage open = guardRing[guardRingHead];
        if (
            _priceMoved(open.backedUsd,   open.tokenSupply, backedAirUsd,   airTokenSupply)
            || _priceMoved(open.backedToken, open.usdSupply, backedAirToken, airUsdSupply)
        ) {
            lastLargeSwapBlock = block.number;
        }
    }

    /**
     * @dev True when the ratio num/den has moved at least SETTLE_GUARD_BPS away
     *      from open/openDen, relative to the opening value.
     *
     *      |R₁ − R₀| / R₀ ≥ bps, cross-multiplied so there is no division:
     *      |curNum·openDen − openNum·curDen| · BPS_DENOM ≥ openNum·curDen·bps.
     *
     *      A zero on either opening term means there is no baseline to compare
     *      against (a pool before its first addLiquidity), which is not a move.
     */
    function _priceMoved(
        uint256 openNum,
        uint256 openDen,
        uint256 curNum,
        uint256 curDen
    ) private pure returns (bool) {
        if (openNum == 0 || openDen == 0 || curDen == 0) return false;
        uint256 a = curNum * openDen;
        uint256 b = openNum * curDen;
        uint256 delta = a > b ? a - b : b - a;
        return delta * BPS_DENOM >= openNum * curDen * SETTLE_GUARD_BPS;
    }

    /**
     * @dev Reject third-party settlement of an expired position while the guard
     *      is armed. The position holder is exempt: they are choosing to settle
     *      at the current price exactly as closeLong / closeShort lets them, and
     *      exempting them means an armed guard can never trap a holder in a
     *      position. `lastLargeSwapBlock == 0` (never armed) is not a live
     *      window — without that check a chain whose height is still below
     *      SETTLE_GUARD_BLOCKS would report every pool as guarded.
     */
    function _assertSettlementUnguarded(address holder) internal view {
        if (msg.sender == holder) return;

        // A pool that is winding down is never guarded against third-party
        // settlement.
        //
        // Arming is relative to depth, so in a thin enough market an ORDINARY
        // trade moves the price by SETTLE_GUARD_BPS and the guard is armed
        // essentially all the time (audit NM-R2-005). Combined with
        // removeLiquidity's openPositionCount == 0 requirement that turns one
        // abandoned expired position into a permanent lock on the LP's
        // principal: the holder can always close, but nobody can make them, and
        // no third party is allowed to clean up on their behalf.
        //
        // Little is given up. _priceCloseClamped prices every settlement,
        // third-party ones included, against the worst open in the same window
        // this guard covers — so the manipulation the lockout exists to prevent
        // is already answered as a price. The guard is the blunter, second copy
        // of that protection, and it is the copy whose failure mode is a
        // permanently stranded LP. closePool is irreversible and blocks new
        // positions, so this cannot be switched on to open a window: it is a
        // one-way move into wind-down.
        if (closeDate != 0) return;

        if (lastLargeSwapBlock == 0) return;
        if (block.number < lastLargeSwapBlock + SETTLE_GUARD_BLOCKS) {
            revert SettlementGuardActive();
        }
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
    // INTERNAL — settlement (single path for voluntary and expiry closes)
    // =========================================================================

    /**
     * @dev Single source of truth for close pricing — used by closeLong,
     *      closeShort, closePositionAfterDeadline, and quoteClose.
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
        return _priceCloseAt(pos, airTokenSupply, backedAirUsd, airUsdSupply, backedAirToken);
    }

    /**
     * @dev _priceClose against an arbitrary reserve state instead of the live
     *      one. Pure, so the caller decides which state a given path is
     *      entitled to price against — see _priceCloseSettlement.
     */
    function _priceCloseAt(
        Position memory pos,
        uint256 tokenSupply,
        uint256 backedUsd,
        uint256 usdSupply,
        uint256 backedToken
    )
        internal
        pure
        returns (bool priceable, uint256 surplus, uint256 deficit, uint256 restore)
    {
        if (pos.isLong) {
            if (tokenSupply <= pos.lockedAmount) return (false, 0, 0, 0);
            uint256 airUsdOut = _cpAmountOut(
                pos.lockedAmount,
                tokenSupply - pos.lockedAmount,
                backedUsd
            );
            if (airUsdOut >= pos.airUsdMinted) {
                return (true, airUsdOut - pos.airUsdMinted, 0, 0);
            }
            return (true, 0, pos.airUsdMinted - airUsdOut, 0);
        }

        // Short: locked airUsd is out of circulation — subtract it from the
        // SWAP-2 reserve, mirroring the long side's supply subtraction.
        if (usdSupply < pos.lockedAmount) return (false, 0, 0, 0);
        uint256 totalBuyable = _cpAmountOut(
            pos.lockedAmount,
            usdSupply - pos.lockedAmount,
            backedToken
        );
        if (totalBuyable == 0 || totalBuyable < pos.airTokenMinted) return (false, 0, 0, 0);
        uint256 cost =
            (pos.lockedAmount * pos.airTokenMinted + totalBuyable - 1) / totalBuyable;
        if (pos.lockedAmount >= cost) {
            return (true, pos.lockedAmount - cost, 0, cost);
        }
        return (true, 0, cost - pos.lockedAmount, cost);
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
     *      re-arm every SETTLE_GUARD_BLOCKS and hold every holder in position
     *      indefinitely. Here the holder can always close. They simply cannot
     *      close at a price they moved inside the window.
     *
     *      Clamping to ONE block's open — the first version of this fix — closed
     *      the atomic variant and left pump-in-N / settle-in-N+1 paying, because
     *      block N+1 opens on the pumped reserves. Widening the reference to
     *      every open still inside SETTLE_GUARD_BLOCKS closes that too: the
     *      pre-pump open is still in the ring, and rolling it out takes a fresh
     *      entry per block, so the attacker has to hold the displaced price for
     *      the whole window with arbitrage open against them the entire time.
     *      That is the same assumption SETTLE_GUARD_BLOCKS already rests on for
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
     *      every entry is SETTLE_GUARD_BLOCKS old the clamp is a no-op and
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
        for (uint256 i = 0; i < SETTLE_GUARD_BLOCKS; i++) {
            GuardSnapshot storage e = guardRing[i];
            uint256 at = e.blockNumber;

            // Slot never written (a pool younger than the ring), or an open old
            // enough that a manipulator would have had to hold it through the
            // whole window to put it here.
            if (at == 0 || at + SETTLE_GUARD_BLOCKS <= asOfBlock) continue;

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

            (bool p, uint256 s, uint256 d, uint256 r) =
                _priceCloseAt(pos, e.tokenSupply, e.backedUsd, e.usdSupply, e.backedToken);

            // Underwater at any open in the window outranks any surplus the
            // window produced, and takes that valuation's restore with it.
            if (!p || d > 0) return (p, 0, d, r);

            // surplus and restore must come from the SAME valuation:
            // _priceCloseAt keeps restore + surplus == lockedAmount on the short
            // side, and _settle relies on that identity to leave the reserves
            // consistent.
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
     * @dev Shared settlement for voluntary and expired-position closes.
     *
     *      Voluntary (viaExpiry = false): caller is the verified holder;
     *      reverts if the position is underwater; pays the holder directly
     *      (they are msg.sender and chose to receive).
     *
     *      Expiry (viaExpiry = true): callable by anyone; a profitable
     *      position CREDITS the holder's claimable balance (pull payment —
     *      no recipient can block cleanup); an underwater position returns
     *      its collateral to the LP reserves and cancels the synthetic debt.
     *
     *      State changes on profitable settlement:
     *        Long:  backedAirToken += locked; backedAirUsd −= surplus;
     *               airUsdSupply −= debt + surplus
     *        Short: backedAirUsd += buyback cost; airTokenSupply −= debt;
     *               airUsdSupply −= surplus
     */
    function _settle(
        uint256 nftId,
        Position memory pos,
        address holder,
        uint256 minPayout,
        bool viaExpiry
    ) internal reserveMutationUnarmed {
        // Priced against the block open where that is worse for the holder, so
        // a settler cannot move their own payout in the same transaction they
        // collect it. See _priceCloseSettlement (audit finding H-2).
        (bool priceable, uint256 surplus, uint256 deficit, uint256 restore) =
            _priceCloseSettlement(pos);
        bool underwater = !priceable || deficit > 0;

        if (!viaExpiry && underwater) revert PositionUnderwater();

        // ── EFFECTS ───────────────────────────────────────────────────────────
        openPositionCount--;
        if (pos.isLong) {
            longOpenInterest -= pos.airUsdMinted;
        } else {
            shortOpenInterest -= pos.usdcIn;
        }

        if (underwater) {
            // Expiry only: return collateral to LP, cancel synthetic debt.
            if (pos.isLong) {
                backedAirToken += pos.lockedAmount;
                totalLongCollateral -= pos.lockedAmount;
                airUsdSupply   -= pos.airUsdMinted;
            } else {
                backedAirUsd   += pos.lockedAmount;
                airTokenSupply -= pos.airTokenMinted;
                totalShortCollateral -= pos.lockedAmount;
            }

            // ── INTERACTIONS ──────────────────────────────────────────────────
            positionNFT.release(nftId);
            emit PositionClosedAfterDeadline(nftId, msg.sender, 0);
        } else {
            uint256 closeFee = (surplus * CLOSE_FEE_BPS) / BPS_DENOM;
            uint256 netSurplus = surplus - closeFee;
            if (netSurplus < minPayout) revert InsufficientOutput();

            if (pos.isLong) {
                backedAirToken += pos.lockedAmount;
                totalLongCollateral -= pos.lockedAmount;
                backedAirUsd  -= surplus;
                airUsdSupply  -= pos.airUsdMinted + surplus;
            } else {
                backedAirUsd   += restore;
                airTokenSupply -= pos.airTokenMinted;
                airUsdSupply   -= surplus;
                // restore + surplus == lockedAmount exactly (see _priceClose):
                // the buyback cost returns to the LP, the surplus is paid out.
                totalShortCollateral -= pos.lockedAmount;
            }
            _accrueProtocolFee(closeFee);

            // ── INTERACTIONS ──────────────────────────────────────────────────
            positionNFT.release(nftId);
            if (viaExpiry) {
                _creditPayout(holder, netSurplus);
                emit PositionClosedAfterDeadline(nftId, msg.sender, netSurplus);
            } else {
                underlyingUsdc.safeTransfer(holder, netSurplus);
                emit PositionClosed(nftId, holder, netSurplus);
            }
        }

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
     * @dev Dynamic renewal fee: renewal re-buys the position's optionality and
     *      its open-interest slot at TODAY's prices instead of entry prices.
     *
     *        mark      = N + surplus       (current gross value, floored at N)
     *        baseFee   = _baseFees(mark)   (5 % of mark, 4/1 LP/protocol split)
     *        impactFee = IMPACT_FEE_BPS × N × (2×(OI−N) + N)
     *                    ────────────────────────────────────  → LP
     *                        2 × backedAirUsd × BPS_DENOM
     *
     *      where N is the position's original notional (its OI contribution)
     *      and OI the current same-side open interest (which includes N). The
     *      impact term is the position's own slice of the OI integral — what a
     *      new entrant would pay for that slot at current crowding and depth —
     *      not the full integral again, which would double-charge vs. opens.
     *
     *      The mark is floored at N (losers pay full size): a losing position's
     *      synthetic debt stays full-size and keeps distorting SWAP-2/3 for all
     *      traders, and the floor makes the fee manipulation-bounded below at
     *      the flat fee — curve manipulation can suppress the surplus term to
     *      zero but never below it.
     *
     * @return totalFee    Total USDC renewal fee (base + impact slice).
     * @return protocolFee Protocol share of the base fee.
     * @return lpFee       LP share of the base fee plus the full impact slice.
     * @return surplus     The position's current profit (0 if underwater or
     *                     unpriceable) — reused by the auto-renew equity check.
     */
    function _renewFees(Position memory pos)
        internal
        view
        returns (uint256 totalFee, uint256 protocolFee, uint256 lpFee, uint256 surplus)
    {
        uint256 n = pos.isLong ? pos.airUsdMinted : pos.usdcIn;

        (bool priceable, uint256 s,,) = _priceClose(pos);
        surplus = priceable ? s : 0;

        (totalFee, protocolFee, lpFee) = _baseFees(n + surplus);

        if (backedAirUsd != 0) {
            uint256 oi = pos.isLong ? longOpenInterest : shortOpenInterest;
            uint256 offset = oi > n ? oi - n : 0;
            uint256 impactFee = (IMPACT_FEE_BPS * n * (2 * offset + n))
                              / (2 * backedAirUsd * BPS_DENOM);
            lpFee    += impactFee;
            totalFee += impactFee;
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
