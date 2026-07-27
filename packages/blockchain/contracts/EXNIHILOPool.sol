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
 *   All AMM modes:    swapFeeBps (1 % default) applied to SWAP-1, SWAP-2, and
 *                     SWAP-3 via _cpAmountOut. Fee is computed on the SPOT VALUE
 *                     of the input: fee = amountIn * reserveOut/reserveIn * feeBps.
 *                     This gives a true percentage-of-notional fee regardless of
 *                     trade size. Fee stays in pool as passive LP yield.
 *   Position open:    5 % flat on USDC notional + quadratic impact fee.
 *                       3 % → accrues to lpFeesAccumulated
 *                       2 % → accrues to protocolFeesAccumulated
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
    uint256 private constant LP_FEE_BPS       = 300;   // 3 % of notional → LP
    uint256 private constant PROTOCOL_FEE_BPS = 200;   // 2 % of notional → protocol
    /// @dev Minimum position open fee in USDC (6 dec). Applies when 5 % of notional
    ///      would be less than this floor. Split 2/5 protocol, 3/5 LP.
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
    /// @dev Minimum swap fee in basis points. A permissionless factory would
    ///      otherwise allow `swapFeeBps = 0`, which removes the economic
    ///      friction that makes atomic flash-loan manipulation (open →
    ///      manipulate price → close) unprofitable. 100 bps (1 %) puts the
    ///      default and the floor at the same value.
    uint256 private constant MIN_SWAP_FEE_BPS = 100;   // 1 %
    /// @dev Flat USDC bounty (6 dec) paid to whoever calls settleExpired().
    ///      A flat constant rather than gas-derived: the pool is oracle-free,
    ///      so it cannot convert gas (native units) to USDC on-chain. 0.05 USDC
    ///      comfortably exceeds the L2 gas cost of the call, keeping expired
    ///      positions profitable to clean up or auto-renew permissionlessly.
    uint256 private constant KEEPER_BOUNTY    = 50_000; // 0.05 USDC

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

    /// @notice Receives the 2 % protocol fee on every position open.
    address public immutable protocolTreasury;

    /// @notice Hard cap per position in USDC (6 dec). 0 = disabled.
    ///         LP NFT holder may freely raise, lower, or clear this cap.
    uint256 public maxPositionUsd;

    /// @notice Soft cap per position as a fraction of backedAirUsd in bps
    ///         (valid range 10–9900). 0 = disabled.
    ///         LP NFT holder may freely raise, lower, or clear this cap.
    uint256 public maxPositionBps;

    /// @notice Swap fee in bps applied to all AMM modes (e.g. 100 = 1 %). Applied in SWAP-1, SWAP-2, and SWAP-3.
    uint256 public immutable swapFeeBps;

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
    uint256 public immutable positionDuration;

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
    error InvalidMaxPositionBps();
    error InvalidSwapFeeBps();
    error ZeroAddress();
    error InsufficientBackedReserves();
    error ReserveInvariantViolated();
    error ZeroLiquidity();
    error RatioMismatch();
    error FeeOnTransferNotSupported();
    error InvalidPositionDuration();
    error PositionNotExpired();
    error PoolClosing();
    error PoolAlreadyClosed();
    error RenewalExceedsCloseDate();
    error OnlyLpHolderOrDeployer();
    error OnlyTreasury();
    error RenewalFeeExceedsMax();
    error AutoRenewActive();

    // ── Events ────────────────────────────────────────────────────────────────




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

    // ── Admin functions ───────────────────────────────────────────────────────

    /**
     * @notice Update position size caps. LP NFT holder only.
     *         Either cap may be freely raised, lowered, or toggled on/off (0 = disabled).
     *
     * @param newUsd  New hard cap in USDC (6 dec). 0 = disabled.
     * @param newBps  New % cap in bps (10–9900). 0 = disabled.
     */
    function setPositionCaps(uint256 newUsd, uint256 newBps) external onlyLpHolder {
        if (newBps != 0 && (newBps < 10 || newBps > 9900)) revert InvalidMaxPositionBps();
        maxPositionUsd = newUsd;
        maxPositionBps = newBps;
    }

    /**
     * @notice Initiate pool closure. Sets closeDate = now + positionDuration.
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

        closeDate = block.timestamp + positionDuration;

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
     * @param protocolTreasury_ Receives 2 % on every position open.
     * @param maxPositionUsd_   Hard cap per position in USDC. 0 = disabled.
     * @param maxPositionBps_   % cap on backedAirUsd in bps (10–9900). 0 = disabled.
     * @param swapFeeBps_       Swap fee in bps for all AMM modes (e.g. 100 = 1 %).
     * @param positionDuration_ Position lifetime in seconds (1 hour – 1 year).
     *                          Pass 0 for the default of 7 days.
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
        uint256 maxPositionUsd_,
        uint256 maxPositionBps_,
        uint256 swapFeeBps_,
        uint256 positionDuration_,
        address factory_
    ) {
        if (underlyingToken_   == address(0)) revert ZeroAddress();
        if (underlyingUsdc_   == address(0)) revert ZeroAddress();
        if (positionNFT_      == address(0)) revert ZeroAddress();
        if (lpNftContract_    == address(0)) revert ZeroAddress();
        if (protocolTreasury_ == address(0)) revert ZeroAddress();
        if (factory_          == address(0)) revert ZeroAddress();
        if (maxPositionBps_ != 0 && (maxPositionBps_ < 10 || maxPositionBps_ > 9900)) {
            revert InvalidMaxPositionBps();
        }
        if (swapFeeBps_ < MIN_SWAP_FEE_BPS || swapFeeBps_ >= BPS_DENOM) revert InvalidSwapFeeBps();

        tokenDecimals    = tokenDecimals_;
        underlyingToken   = IERC20(underlyingToken_);
        underlyingUsdc   = IERC20(underlyingUsdc_);
        positionNFT      = IPositionNFT(positionNFT_);
        lpNftContract    = ILpNFT(lpNftContract_);
        lpNftId          = lpNftId_;
        protocolTreasury = protocolTreasury_;
        maxPositionUsd   = maxPositionUsd_;
        maxPositionBps   = maxPositionBps_;
        swapFeeBps       = swapFeeBps_;
        factory          = IEXNIHILOFactory(factory_);

        if (positionDuration_ == 0) {
            positionDuration = 7 days;
        } else {
            if (positionDuration_ < 1 hours || positionDuration_ > 365 days) revert InvalidPositionDuration();
            positionDuration = positionDuration_;
        }

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

        if (tokenToUsdc) {
            _swapTokenToUsdc(amountIn, minAmountOut, recipient);
        } else {
            _swapUsdcToToken(amountIn, minAmountOut, recipient);
        }
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
    ) external nonReentrant {
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
            block.timestamp + positionDuration
        );

        _assertReserveInvariant();

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

        _settle(nftId, pos, holder, minUsdcOut, false, 0);
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
    ) external nonReentrant {
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
            block.timestamp + positionDuration
        );

        _assertReserveInvariant();

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

        _settle(nftId, pos, holder, minUsdcOut, false, 0);
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
    function addLiquidity(uint256 tokenAmount, uint256 usdcAmount) external nonReentrant onlyLpHolder {
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

        _assertReserveInvariant();

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
     *         deadline by one positionDuration from the current deadline (or
     *         from now if the position has already expired).
     *         Only the position holder may renew — this prevents third parties
     *         from indefinitely extending positions to grief the LP's exit.
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

        // Extend from current deadline (or from now if already expired).
        uint256 base = pos.deadline > block.timestamp ? pos.deadline : block.timestamp;
        uint256 newDeadline = base + positionDuration;

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
     * @notice Settle an expired position. Callable by anyone; pays the caller
     *         a flat KEEPER_BOUNTY so cleanup is always economically viable.
     *
     *         If the holder opted into auto-renewal (PositionNFT.setAutoRenew)
     *         and the position's own equity covers the dynamic renewal fee plus
     *         the bounty — and the fee is within the holder's cap and the new
     *         deadline within closeDate — the position is renewed instead of
     *         closed, with the fee charged against its equity:
     *
     *           Long  — synthetic debt (airUsdMinted) grows by fee + bounty.
     *                   The USDC leaves backedAirUsd now and is recouped at
     *                   close through the equally-reduced surplus.
     *           Short — locked airUsd collateral shrinks by fee + bounty.
     *
     *         A winning position therefore sustains itself; a position that
     *         cannot pay is settled exactly like closePositionAfterDeadline
     *         (profit credited as pull payment, or collateral returned to LP),
     *         with the bounty carved from the settlement flow.
     *
     * @param nftId      Position NFT to settle.
     * @param minPayout  Slippage guard on the holder's credited payout when the
     *                   close path runs (0 = accept any outcome).
     */
    function settleExpired(uint256 nftId, uint256 minPayout) external nonReentrant {
        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();
        if (block.timestamp < pos.deadline) revert PositionNotExpired();

        if (_tryAutoRenew(nftId, pos)) return;

        address holder = positionNFT.ownerOf(nftId);
        _settle(nftId, pos, holder, minPayout, true, KEEPER_BOUNTY);
    }

    /**
     * @dev Checks whether the keeper-driven auto-renewal can execute for an
     *      expired position: holder opted in, dynamic fee within the holder's
     *      cap, equity covers fee + bounty, new deadline within closeDate.
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
        if (surplus < totalFee + KEEPER_BOUNTY) return (false, 0, 0, 0);

        // Expired ⇒ the new deadline extends from now.
        if (closeDate != 0 && block.timestamp + positionDuration > closeDate) {
            return (false, 0, 0, 0);
        }
        ok = true;
    }

    /**
     * @dev Execute the auto-renewal if possible. Returns false (no state
     *      change) when any condition fails, letting the caller fall through
     *      to the close path.
     */
    function _tryAutoRenew(uint256 nftId, Position memory pos) internal returns (bool) {
        (bool ok, uint256 totalFee, uint256 protocolFee, uint256 lpFee) =
            _autoRenewQuote(nftId, pos);
        if (!ok) return false;

        uint256 cost = totalFee + KEEPER_BOUNTY;
        uint256 newDeadline = block.timestamp + positionDuration;

        // ── EFFECTS — charge the position's own equity ───────────────────────
        if (pos.isLong) {
            // Fee + bounty leave the backed reserves now; the position's debt
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
            // Fee + bounty come out of the locked airUsd collateral, which
            // leaves pool accounting (it was counted in airUsdSupply only).
            airUsdSupply         -= cost;
            totalShortCollateral -= cost; // lockedAmount shrinks by the same cost
            positionNFT.applyRenewal(
                nftId, pos.lockedAmount - cost, pos.airUsdMinted, totalFee, newDeadline
            );
        }
        _accrueProtocolFee(protocolFee);
        _accrueLpFee(lpFee);

        // ── INTERACTIONS ─────────────────────────────────────────────────────
        underlyingUsdc.safeTransfer(msg.sender, KEEPER_BOUNTY);

        _assertReserveInvariant();
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

        // A position whose holder opted into auto-renewal (and whose equity can
        // fund it) must not be closeable through this path — otherwise anyone
        // could bypass the opt-in and kill the position. settleExpired() will
        // renew it instead.
        (bool renewable,,,) = _autoRenewQuote(nftId, pos);
        if (renewable) revert AutoRenewActive();

        address holder = positionNFT.ownerOf(nftId);

        _settle(nftId, pos, holder, minPayout, true, 0);
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
     * @notice Effective per-position leverage cap in USDC (6 dec).
     *         Returns min(maxPositionUsd, maxPositionBps % of backedAirUsd).
     *         Returns type(uint256).max if both caps are disabled.
     */
    function effectiveLeverageCap() external view returns (uint256) {
        uint256 cap = type(uint256).max;
        if (maxPositionUsd > 0) cap = maxPositionUsd;
        if (maxPositionBps > 0) {
            uint256 bpsCap = (backedAirUsd * maxPositionBps) / BPS_DENOM;
            if (bpsCap < cap) cap = bpsCap;
        }
        return cap;
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
    function quoteClose(uint256 nftId) external view returns (bool ready, int256 pnl) {
        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();

        (bool priceable, uint256 surplus, uint256 deficit,) = _priceClose(pos);
        if (!priceable) return (false, 0);
        if (deficit > 0) return (true, -int256(deficit));
        return (true, int256(surplus - (surplus * CLOSE_FEE_BPS) / BPS_DENOM));
    }

    // =========================================================================
    // INTERNAL — swap helpers
    // =========================================================================

    /**
     * @dev Execute a token → USDC SWAP-1.
     *      Extracted to a dedicated function to keep swap()'s stack frame lean.
     */
    function _swapTokenToUsdc(uint256 amountIn, uint256 minAmountOut, address recipient) internal {
        // ── CHECK (against pre-swap reserves) ─────────────────────────────────
        uint256 netOut = _cpAmountOut(amountIn, backedAirToken, backedAirUsd);
        // A trade large enough that the fee exceeds the raw output yields zero;
        // without this, a caller passing minAmountOut == 0 pays amountIn for nothing.
        if (netOut == 0) revert InsufficientOutput();
        if (netOut < minAmountOut) revert InsufficientOutput();

        // ── EFFECTS ───────────────────────────────────────────────────────────
        // Wrap the inbound token (supply grows), unwrap the outbound airUsd
        // (supply shrinks by the USDC leaving the pool).
        airTokenSupply += amountIn;
        airUsdSupply   -= netOut;
        backedAirToken += amountIn;
        backedAirUsd  -= netOut;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        _transferIn(underlyingToken, msg.sender, amountIn);
        underlyingUsdc.safeTransfer(recipient, netOut);

        _assertReserveInvariant();

    }

    /**
     * @dev Execute a USDC → token SWAP-1.
     */
    function _swapUsdcToToken(uint256 amountIn, uint256 minAmountOut, address recipient) internal {
        // ── CHECK (against pre-swap reserves) ─────────────────────────────────
        uint256 netOut = _cpAmountOut(amountIn, backedAirUsd, backedAirToken);
        // A trade large enough that the fee exceeds the raw output yields zero;
        // without this, a caller passing minAmountOut == 0 pays amountIn for nothing.
        if (netOut == 0) revert InsufficientOutput();
        if (netOut < minAmountOut) revert InsufficientOutput();

        // ── EFFECTS ───────────────────────────────────────────────────────────
        // Wrap the inbound USDC (supply grows), unwrap the outbound airToken
        // (supply shrinks by the token leaving the pool).
        airUsdSupply   += amountIn;
        airTokenSupply -= netOut;
        backedAirUsd  += amountIn;
        backedAirToken -= netOut;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        _transferIn(underlyingUsdc, msg.sender, amountIn);
        underlyingToken.safeTransfer(recipient, netOut);

        _assertReserveInvariant();

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
        if (pos.isLong) {
            if (airTokenSupply <= pos.lockedAmount) return (false, 0, 0, 0);
            uint256 airUsdOut = _cpAmountOut(
                pos.lockedAmount,
                airTokenSupply - pos.lockedAmount,
                backedAirUsd
            );
            if (airUsdOut >= pos.airUsdMinted) {
                return (true, airUsdOut - pos.airUsdMinted, 0, 0);
            }
            return (true, 0, pos.airUsdMinted - airUsdOut, 0);
        }

        // Short: locked airUsd is out of circulation — subtract it from the
        // SWAP-2 reserve, mirroring the long side's supply subtraction.
        if (airUsdSupply < pos.lockedAmount) return (false, 0, 0, 0);
        uint256 totalBuyable = _cpAmountOut(
            pos.lockedAmount,
            airUsdSupply - pos.lockedAmount,
            backedAirToken
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
        bool viaExpiry,
        uint256 bounty
    ) internal {
        (bool priceable, uint256 surplus, uint256 deficit, uint256 restore) = _priceClose(pos);
        bool underwater = !priceable || deficit > 0;

        if (!viaExpiry && underwater) revert PositionUnderwater();

        // ── EFFECTS ───────────────────────────────────────────────────────────
        openPositionCount--;
        if (pos.isLong) {
            longOpenInterest -= pos.airUsdMinted;
        } else {
            shortOpenInterest -= pos.usdcIn;
        }

        uint256 bountyPaid;

        if (underwater) {
            // Expiry only: return collateral to LP, cancel synthetic debt.
            // The keeper bounty is carved from the LP side — the LP is the
            // beneficiary of the cleanup — capped by what is available.
            if (pos.isLong) {
                backedAirToken += pos.lockedAmount;
                airUsdSupply   -= pos.airUsdMinted;
                bountyPaid = bounty > backedAirUsd ? backedAirUsd : bounty;
                backedAirUsd -= bountyPaid;
                airUsdSupply -= bountyPaid;
            } else {
                bountyPaid = bounty > pos.lockedAmount ? pos.lockedAmount : bounty;
                backedAirUsd   += pos.lockedAmount - bountyPaid;
                airUsdSupply   -= bountyPaid;
                airTokenSupply -= pos.airTokenMinted;
                // Whole collateral leaves short custody: part to the keeper,
                // the remainder back into backedAirUsd above.
                totalShortCollateral -= pos.lockedAmount;
            }

            // ── INTERACTIONS ──────────────────────────────────────────────────
            positionNFT.release(nftId);
            if (bountyPaid > 0) underlyingUsdc.safeTransfer(msg.sender, bountyPaid);
            emit PositionClosedAfterDeadline(nftId, msg.sender, 0);
        } else {
            uint256 closeFee = (surplus * CLOSE_FEE_BPS) / BPS_DENOM;
            bountyPaid = bounty > surplus - closeFee ? surplus - closeFee : bounty;
            uint256 netSurplus = surplus - closeFee - bountyPaid;
            if (netSurplus < minPayout) revert InsufficientOutput();

            if (pos.isLong) {
                backedAirToken += pos.lockedAmount;
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
            if (bountyPaid > 0) underlyingUsdc.safeTransfer(msg.sender, bountyPaid);
            if (viaExpiry) {
                _creditPayout(holder, netSurplus);
                emit PositionClosedAfterDeadline(nftId, msg.sender, netSurplus);
            } else {
                underlyingUsdc.safeTransfer(holder, netSurplus);
                emit PositionClosed(nftId, holder, netSurplus);
            }
        }

        _assertReserveInvariant();
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
     *      fee     = amountIn * reserveOut * swapFeeBps / (reserveIn * BPS_DENOM)
     *      netOut  = rawOut - fee   (returns 0 if rawOut <= fee)
     *
     *      Maximum amountIn before fee >= rawOut:
     *        reserveIn * (BPS_DENOM - swapFeeBps) / swapFeeBps
     *      e.g. for 1% fee: 99 × reserveIn
     */
    function _cpAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) internal view returns (uint256) {
        if (reserveIn == 0 || reserveOut == 0) return 0;
        uint256 rawOut = (amountIn * reserveOut) / (reserveIn + amountIn);
        uint256 fee    = (amountIn * reserveOut * swapFeeBps) / (reserveIn * BPS_DENOM);
        if (rawOut <= fee) return 0;
        return rawOut - fee;
    }



    // =========================================================================
    // INTERNAL — fee computation (single source of truth for position fees)
    // =========================================================================

    /**
     * @dev Base position fee: 5 % of notional (3 % LP + 2 % protocol) with a
     *      MIN_POSITION_FEE floor split in the same 3:2 ratio.
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
     *        baseFee   = _baseFees(mark)   (5 % of mark, 3/2 LP/protocol split)
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
        uint256 cap = type(uint256).max;
        if (maxPositionUsd > 0) cap = maxPositionUsd;
        if (maxPositionBps > 0) {
            uint256 bpsCap = (backedAirUsd * maxPositionBps) / BPS_DENOM;
            if (bpsCap < cap) cap = bpsCap;
        }
        if (cap != type(uint256).max && usdcNotional > cap) {
            revert LeverageCapExceeded();
        }
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
        if (underlyingToken.balanceOf(address(this)) < backedAirToken) {
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
