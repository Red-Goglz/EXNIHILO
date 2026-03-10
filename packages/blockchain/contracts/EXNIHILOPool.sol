// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @dev AirToken interface: an ERC-20 whose mint/burn are restricted to the
 *      pool that owns it. The pool uses mint to wrap raw deposits and burn to
 *      unwrap withdrawals. Synthetic (unbacked) mint/burn is also possible and
 *      is how leveraged positions inflate or deflate the virtual supply.
 */
interface IAirToken is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

/**
 * @dev Position data structure shared between PositionNFT and the pool.
 *      Declared at file level so both the interface and the pool can reference
 *      it without import gymnastics.
 *
 *      Fields used per side:
 *        Long  — lockedToken = airToken, lockedAmount = airTokenLocked,
 *                usdcIn, airUsdMinted, feesPaid
 *        Short — lockedToken = airUsd,  lockedAmount = airUsdLocked,
 *                airTokenMinted, feesPaid
 */
struct Position {
    bool    isLong;
    address pool;
    address lockedToken;
    uint256 lockedAmount;
    uint256 usdcIn;
    uint256 airUsdMinted;
    uint256 airTokenMinted;
    uint256 feesPaid;
    uint256 openedAt;
}

/**
 * @dev Minimal interface to PositionNFT — only what EXNIHILOPool calls.
 */
interface IPositionNFT {
    function mintLong(
        address to,
        address pool,
        address airToken,
        uint256 usdcIn,
        uint256 airUsdMinted,
        uint256 airTokenLocked,
        uint256 feesPaid
    ) external returns (uint256 tokenId);

    function mintShort(
        address to,
        address pool,
        address airUsdToken,
        uint256 airTokenMinted,
        uint256 airUsdLocked,
        uint256 feesPaid
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
 *   SWAP-1  Normal swap          x = backedAirToken,          y = backedAirUsd
 *   SWAP-2  Long-open/Short-close x = backedAirToken,         y = airUsd.totalSupply()
 *   SWAP-3  Short-open/Long-close x = airToken.totalSupply(), y = backedAirUsd
 *
 *   All three modes use the standard constant-product formula:
 *     amountOut = amountIn * reserveOut / (reserveIn + amountIn)
 *
 * ── Reserve Accounting ───────────────────────────────────────────────────────
 *
 *   backedAirToken  Tracks the amount of airToken that has real underlying token
 *                  collateral behind it.  Increases on LP deposits and on token
 *                  swaps-in; decreases on token swaps-out and on openLong
 *                  (collateral leaves to PositionNFT custody).
 *
 *   backedAirUsd   Same for the airUsd / USDC side.  Increases on LP deposits
 *                  and USDC swaps-in; decreases on USDC swaps-out and on
 *                  openShort (collateral leaves to PositionNFT custody).
 *
 *   Synthetic mints (openLong mints airUsd, openShort mints airToken) do NOT
 *   touch the backed reserves — they inflate totalSupply only.
 *
 * ── Fee Structure ────────────────────────────────────────────────────────────
 *
 *   All AMM modes:    swapFeeBps (1 % default) applied to SWAP-1, SWAP-2, and
 *                     SWAP-3 via _cpAmountOut. Fee is computed on the SPOT VALUE
 *                     of the input: fee = amountIn * reserveOut/reserveIn * feeBps.
 *                     This gives a true percentage-of-notional fee regardless of
 *                     trade size. Fee stays in pool as passive LP yield.
 *   Position open:    5 % flat on USDC notional.
 *                       3 % → lpFeesAccumulated (claimable via claimFees)
 *                       2 % → protocolTreasury  (transferred immediately)
 *
 * ── Security ─────────────────────────────────────────────────────────────────
 *
 *   - ReentrancyGuard  on every state-changing external function.
 *   - CEI pattern      throughout: state written before any external call.
 *   - Reserve invariant: backedAirToken ≤ airToken.totalSupply() and vice versa,
 *                        checked after every operation that touches backed reserves.
 *   - Slippage guards  (minAmountOut) on swap, openLong, openShort.
 */
contract EXNIHILOPool is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeERC20 for IAirToken;

    // ── Constants ─────────────────────────────────────────────────────────────

    uint256 private constant BPS_DENOM        = 10_000;
    uint256 private constant LP_FEE_BPS       = 300;   // 3 % of notional → LP
    uint256 private constant PROTOCOL_FEE_BPS = 200;   // 2 % of notional → protocol
    /// @dev Minimum position open fee in USDC (6 dec). Applies when 5 % of notional
    ///      would be less than this floor. Split 2/5 protocol, 3/5 LP.
    uint256 private constant MIN_POSITION_FEE = 50_000; // 0.05 USDC
    /// @dev 1 % of profit taken by the protocol on closeLong / closeShort.
    uint256 private constant CLOSE_FEE_BPS    = 100;   // 1 % of surplus → protocol

    // ── Immutables ────────────────────────────────────────────────────────────

    /// @notice AirToken wrapping the underlying asset (typically 18 decimals).
    IAirToken public immutable airToken;

    /// @notice AirToken wrapping USDC (6 decimals).
    IAirToken public immutable airUsdToken;

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

    // ── Mutable state ─────────────────────────────────────────────────────────

    /// @notice airToken backed 1 : 1 by deposited underlying tokens.
    uint256 public backedAirToken;

    /// @notice airUsd backed 1 : 1 by deposited underlying USDC.
    uint256 public backedAirUsd;

    /// @notice Accumulated LP fees in USDC (6 dec). Claimed via claimFees().
    uint256 public lpFeesAccumulated;

    /// @notice Total number of open long + short positions.
    uint256 public openPositionCount;

    /// @notice Sum of USDC notional for all open long positions (6 dec).
    uint256 public longOpenInterest;

    /// @notice Sum of USDC value locked in all open short positions (6 dec).
    uint256 public shortOpenInterest;

    // ── Custom errors ─────────────────────────────────────────────────────────

    error OnlyLpHolder();
    error OnlyPositionHolder();
    error PositionNotFromThisPool();
    error PositionNotLong();
    error PositionNotShort();
    error ZeroAmount();
    error InsufficientOutput(uint256 got, uint256 minimum);
    error LeverageCapExceeded(uint256 requested, uint256 cap);
    error PositionUnderwater();
    error OpenPositionsExist(uint256 count);
    error InvalidMaxPositionBps();
    error InvalidSwapFeeBps();
    error ZeroAddress();
    error InsufficientBackedReserves();
    error ReserveInvariantViolated();
    error PositionAlreadyProfitable();
    error ZeroLiquidity();
    error RatioMismatch();
    error FeeOnTransferNotSupported();

    // ── Events ────────────────────────────────────────────────────────────────

    event LiquidityAdded(
        address indexed provider,
        uint256 tokenAmount,
        uint256 usdcAmount,
        uint256 backedAirToken,
        uint256 backedAirUsd
    );

    event LiquidityRemoved(
        address indexed provider,
        uint256 tokenAmount,
        uint256 usdcAmount
    );

    event Swap(
        address indexed caller,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOut
    );

    event LongOpened(
        uint256 indexed nftId,
        address indexed holder,
        uint256 usdcIn,
        uint256 airUsdMinted,
        uint256 airTokenLocked,
        uint256 feesPaid
    );

    event LongClosed(
        uint256 indexed nftId,
        address indexed holder,
        uint256 profit,
        uint256 airUsdBurned
    );

    event ShortOpened(
        uint256 indexed nftId,
        address indexed holder,
        uint256 airTokenMinted,
        uint256 airUsdLocked,
        uint256 feesPaid
    );

    event ShortClosed(
        uint256 indexed nftId,
        address indexed holder,
        uint256 profit,
        uint256 airTokenBurned
    );

    event PositionForceRealized(
        uint256 indexed nftId,
        address indexed lpOwner,
        uint256 collateralPaid
    );

    event FeesClaimed(address indexed lpOwner, uint256 amount);

    event PositionCapsUpdated(uint256 newMaxPositionUsd, uint256 newMaxPositionBps, address indexed by);

    event LongRealized(
        uint256 indexed nftId,
        address indexed holder,
        uint256 usdcPaid,     // == airUsdMinted (synthetic debt settled at par)
        uint256 tokenDelivered
    );

    event ShortRealized(
        uint256 indexed nftId,
        address indexed holder,
        uint256 tokenPaid,     // == airTokenMinted (synthetic debt settled at par)
        uint256 usdcDelivered
    );

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
        emit PositionCapsUpdated(newUsd, newBps, msg.sender);
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param airToken_     AirToken wrapper for the underlying asset.
     * @param airUsdToken_      AirToken wrapper for USDC.
     * @param underlyingToken_   Raw underlying ERC-20 deposited by LP.
     * @param underlyingUsdc_   USDC ERC-20 (6 dec) deposited by LP.
     * @param positionNFT_      Shared PositionNFT contract.
     * @param lpNftContract_    Shared LpNFT contract.
     * @param lpNftId_          Which LP NFT token governs this pool.
     * @param protocolTreasury_ Receives 2 % on every position open.
     * @param maxPositionUsd_   Hard cap per position in USDC. 0 = disabled.
     * @param maxPositionBps_   % cap on backedAirUsd in bps (10–9900). 0 = disabled.
     * @param swapFeeBps_       Swap fee in bps for all AMM modes (e.g. 100 = 1 %).
     */
    constructor(
        address airToken_,
        address airUsdToken_,
        address underlyingToken_,
        address underlyingUsdc_,
        address positionNFT_,
        address lpNftContract_,
        uint256 lpNftId_,
        address protocolTreasury_,
        uint256 maxPositionUsd_,
        uint256 maxPositionBps_,
        uint256 swapFeeBps_
    ) {
        if (airToken_     == address(0)) revert ZeroAddress();
        if (airUsdToken_      == address(0)) revert ZeroAddress();
        if (underlyingToken_   == address(0)) revert ZeroAddress();
        if (underlyingUsdc_   == address(0)) revert ZeroAddress();
        if (positionNFT_      == address(0)) revert ZeroAddress();
        if (lpNftContract_    == address(0)) revert ZeroAddress();
        if (protocolTreasury_ == address(0)) revert ZeroAddress();
        if (maxPositionBps_ != 0 && (maxPositionBps_ < 10 || maxPositionBps_ > 9900)) {
            revert InvalidMaxPositionBps();
        }
        if (swapFeeBps_ >= BPS_DENOM) revert InvalidSwapFeeBps();

        airToken     = IAirToken(airToken_);
        airUsdToken      = IAirToken(airUsdToken_);
        underlyingToken   = IERC20(underlyingToken_);
        underlyingUsdc   = IERC20(underlyingUsdc_);
        positionNFT      = IPositionNFT(positionNFT_);
        lpNftContract    = ILpNFT(lpNftContract_);
        lpNftId          = lpNftId_;
        protocolTreasury = protocolTreasury_;
        maxPositionUsd   = maxPositionUsd_;
        maxPositionBps   = maxPositionBps_;
        swapFeeBps       = swapFeeBps_;
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
        bool tokenToUsdc
    ) external nonReentrant {
        if (amountIn == 0) revert ZeroAmount();
        if (backedAirToken == 0 || backedAirUsd == 0) revert InsufficientBackedReserves();

        if (tokenToUsdc) {
            _swapTokenToUsdc(amountIn, minAmountOut);
        } else {
            _swapUsdcToToken(amountIn, minAmountOut);
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
     *   totalSupply until the position is closed or realized.
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
        uint256 minAirTokenOut
    ) external nonReentrant {
        if (usdcAmount == 0) revert ZeroAmount();
        if (backedAirToken == 0 || backedAirUsd == 0) revert InsufficientBackedReserves();

        _checkLeverageCap(usdcAmount);

        // ── Fee split (5 % total on notional, minimum 0.05 USDC) ─────────────
        uint256 protocolFee = (usdcAmount * PROTOCOL_FEE_BPS) / BPS_DENOM;
        uint256 lpFee       = (usdcAmount * LP_FEE_BPS)       / BPS_DENOM;
        uint256 totalFee    = protocolFee + lpFee;
        if (totalFee < MIN_POSITION_FEE) {
            totalFee    = MIN_POSITION_FEE;
            protocolFee = (MIN_POSITION_FEE * PROTOCOL_FEE_BPS) / (PROTOCOL_FEE_BPS + LP_FEE_BPS);
            lpFee       = MIN_POSITION_FEE - protocolFee;
        }

        // SWAP-2: compute airToken output before any state changes.
        // reserveIn  = airUsd.totalSupply() before the synthetic mint below.
        // reserveOut = backedAirToken
        uint256 airTokenOut = _cpAmountOut(
            usdcAmount,
            airUsdToken.totalSupply(),
            backedAirToken
        );

        if (airTokenOut == 0) revert ZeroAmount();
        if (airTokenOut < minAirTokenOut) revert InsufficientOutput(airTokenOut, minAirTokenOut);
        if (airTokenOut > backedAirToken) revert InsufficientBackedReserves();

        // ── EFFECTS ───────────────────────────────────────────────────────────
        openPositionCount++;
        longOpenInterest += usdcAmount;
        lpFeesAccumulated += lpFee;

        // Mint synthetic airUsd: inflates totalSupply, no new backing.
        // The full usdcAmount becomes the synthetic debt regardless of fees
        // because the trader's notional position size is usdcAmount.
        airUsdToken.mint(address(this), usdcAmount);

        // Collateral leaves the pool's backed reserves into PositionNFT custody.
        backedAirToken -= airTokenOut;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        // The notional is NOT pulled — it is represented synthetically by the
        // airUsd minted above.  Only the 5 % fee is collected from the trader.
        _transferIn(underlyingUsdc, msg.sender, totalFee);
        underlyingUsdc.safeTransfer(protocolTreasury, protocolFee);

        airToken.forceApprove(address(positionNFT), airTokenOut);

        uint256 nftId = positionNFT.mintLong(
            msg.sender,
            address(this),
            address(airToken),
            usdcAmount,   // usdcIn
            usdcAmount,   // airUsdMinted — synthetic debt owed
            airTokenOut,   // airTokenLocked
            totalFee
        );

        // Clear any residual approval.
        airToken.forceApprove(address(positionNFT), 0);

        _assertReserveInvariant();

        emit LongOpened(nftId, msg.sender, usdcAmount, usdcAmount, airTokenOut, totalFee);
    }

    /**
     * @notice Close a profitable long position.
     *
     *   Settlement
     *   ──────────
     *   The locked airToken returns from PositionNFT. SWAP-3 prices it against
     *   (airToken.totalSupply() − lockedAmount, backedAirUsd). If the resulting
     *   airUsd ≥ the synthetic debt (airUsdMinted), the surplus is unwrapped and
     *   sent to the holder as USDC. The synthetic debt is burned; the returned
     *   airToken stays in the pool as fully-backed LP collateral.
     *
     *   State changes
     *   ─────────────
     *     backedAirToken  += lockedAmount  (airToken collateral returns to LP reserves)
     *     backedAirUsd   −= surplus       (only the profit USDC exits the pool's backing)
     *     airUsd supply  −= airUsdMinted  (synthetic debt cancelled)
     *     airUsd supply  −= surplus       (backed wrappers burned for USDC paid to holder)
     *
     *   Note: airToken wrappers are NOT burned. The underlying token never left the
     *   pool, so the returned airToken wrappers correctly represent LP's restored
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

        // ── CHECKS (before any interaction) ──────────────────────────────────
        // release() only transfers airToken; it does not mint or burn, so
        // totalSupply() is identical before and after — safe to compute here.
        uint256 airTokenSupply = airToken.totalSupply();
        if (airTokenSupply < pos.lockedAmount) revert PositionUnderwater();
        uint256 airUsdOut = _cpAmountOut(
            pos.lockedAmount,
            airTokenSupply - pos.lockedAmount,
            backedAirUsd
        );
        if (airUsdOut < pos.airUsdMinted) revert PositionUnderwater();
        uint256 surplus    = airUsdOut - pos.airUsdMinted;
        uint256 closeFee   = (surplus * CLOSE_FEE_BPS) / BPS_DENOM;
        uint256 netSurplus = surplus - closeFee;
        if (netSurplus < minUsdcOut) revert InsufficientOutput(netSurplus, minUsdcOut);

        // ── EFFECTS ───────────────────────────────────────────────────────────
        openPositionCount--;
        longOpenInterest -= pos.airUsdMinted;
        // The token collateral returns to LP's backed reserves. The underlying
        // token never left the pool, so restoring backedAirToken correctly
        // reconciles the returned airToken wrappers with their real backing.
        backedAirToken += pos.lockedAmount;
        // The full surplus exits the pool's backed reserve; it is split between
        // the holder (netSurplus) and the protocol treasury (closeFee).
        backedAirUsd  -= surplus;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        positionNFT.release(nftId);
        // Burn the synthetic airUsd debt that was created at openLong.
        airUsdToken.burn(address(this), pos.airUsdMinted);
        // Burn backed airUsd wrappers for the full surplus USDC being paid out.
        airUsdToken.burn(address(this), surplus);
        underlyingUsdc.safeTransfer(holder, netSurplus);
        underlyingUsdc.safeTransfer(protocolTreasury, closeFee);

        _assertReserveInvariant();

        emit LongClosed(nftId, holder, netSurplus, pos.airUsdMinted);
    }

    /**
     * @notice Realize a long position at par — the holder pays the USDC debt
     *         and receives the locked underlying tokens at whatever price they were
     *         acquired, regardless of market movements.
     *
     *   This is a non-speculative exit path: no profit or loss on token price,
     *   the trader simply converts their synthetic debt into real USDC and
     *   receives the raw underlying tokens.
     *
     *   State changes
     *   ─────────────
     *     backedAirUsd  += usdcPaid   (synthetic airUsd from openLong now has real backing)
     *     airUsd supply  unchanged    (minted at openLong; stays — now fully backed)
     *     backedAirToken  unchanged    (was reduced at open; token delivered to holder)
     *     airToken supply −= locked    (burned on unwrap)
     *
     * @param nftId  Position NFT token ID.
     */
    function realizeLong(uint256 nftId) external nonReentrant {
        address holder = positionNFT.ownerOf(nftId);
        if (holder != msg.sender) revert OnlyPositionHolder();

        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();
        if (!pos.isLong) revert PositionNotLong();

        // EFFECTS — only counters that do not depend on the USDC having arrived.
        openPositionCount--;
        longOpenInterest -= pos.airUsdMinted;

        // Pull USDC from caller (== holder, verified above) before updating the
        // backed reserve — USDC must be in the contract before backedAirUsd reflects it.
        _transferIn(underlyingUsdc, msg.sender, pos.airUsdMinted);

        // EFFECT — safe to write now that the USDC is confirmed received.
        backedAirUsd += pos.airUsdMinted;

        // Release NFT: returns lockedAmount of airToken to pool.
        positionNFT.release(nftId);

        // Burn airToken wrapper and deliver raw underlying token to holder.
        // backedAirToken was reduced at open; no adjustment needed here because
        // the delivered token comes from the LP's original collateral pool.
        airToken.burn(address(this), pos.lockedAmount);
        underlyingToken.safeTransfer(holder, pos.lockedAmount);

        _assertReserveInvariant();

        emit LongRealized(nftId, holder, pos.airUsdMinted, pos.lockedAmount);
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
     *   the current backed rate. This inflates airToken totalSupply.
     *   The resulting airUsd (real, from backedAirUsd) is locked in
     *   the PositionNFT. The synthetic airToken remains as outstanding debt in
     *   totalSupply until the position is closed or realized.
     *
     *   State changes
     *   ─────────────
     *     airToken supply += airTokenMinted  (synthetic debt; NOT backed)
     *     backedAirUsd   -= airUsdOut      (real airUsd locked)
     *
     * @param usdcNotional  Notional size in USDC terms (6 dec). A 5 % fee is charged on top.
     * @param minAirUsdOut  Slippage guard on airUsd locked in PositionNFT.
     */
    function openShort(
        uint256 usdcNotional,
        uint256 minAirUsdOut
    ) external nonReentrant {
        if (usdcNotional == 0) revert ZeroAmount();
        if (backedAirToken == 0 || backedAirUsd == 0) revert InsufficientBackedReserves();

        _checkLeverageCap(usdcNotional);

        // ── Fee split (5 % total on notional, minimum 0.05 USDC) ─────────────
        uint256 protocolFee = (usdcNotional * PROTOCOL_FEE_BPS) / BPS_DENOM;
        uint256 lpFee       = (usdcNotional * LP_FEE_BPS)       / BPS_DENOM;
        uint256 totalFee    = protocolFee + lpFee;
        if (totalFee < MIN_POSITION_FEE) {
            totalFee    = MIN_POSITION_FEE;
            protocolFee = (MIN_POSITION_FEE * PROTOCOL_FEE_BPS) / (PROTOCOL_FEE_BPS + LP_FEE_BPS);
            lpFee       = MIN_POSITION_FEE - protocolFee;
        }

        // Compute synthetic airToken to mint using the current SWAP-1 reference rate:
        //   airTokenMinted = usdcNotional * airToken.totalSupply() / backedAirUsd
        // This gives the airToken amount that is worth usdcNotional at backed prices.
        uint256 airTokenSupplyBefore = airToken.totalSupply();
        if (airTokenSupplyBefore == 0) revert InsufficientBackedReserves();

        uint256 airTokenMinted = (usdcNotional * airTokenSupplyBefore) / backedAirUsd;
        if (airTokenMinted == 0) revert ZeroAmount();

        // SWAP-3: compute airUsd output before any state changes.
        // reserveIn  = airToken.totalSupply() before the synthetic mint below.
        // reserveOut = backedAirUsd
        uint256 airUsdOut = _cpAmountOut(airTokenMinted, airTokenSupplyBefore, backedAirUsd);

        if (airUsdOut == 0) revert ZeroAmount();
        if (airUsdOut < minAirUsdOut) revert InsufficientOutput(airUsdOut, minAirUsdOut);
        if (airUsdOut > backedAirUsd) revert InsufficientBackedReserves();

        // ── EFFECTS ──────────────────────────────────────────────────────────
        openPositionCount++;
        shortOpenInterest += airUsdOut;
        lpFeesAccumulated += lpFee;

        // Mint synthetic airToken: inflates totalSupply, no new token backing.
        airToken.mint(address(this), airTokenMinted);

        // Real airUsd leaves the pool's backed reserves into PositionNFT custody.
        backedAirUsd -= airUsdOut;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        // The notional is NOT pulled — it is represented synthetically by the
        // airToken minted above.  Only the 5 % fee is collected from the trader.
        _transferIn(underlyingUsdc, msg.sender, totalFee);
        underlyingUsdc.safeTransfer(protocolTreasury, protocolFee);

        airUsdToken.forceApprove(address(positionNFT), airUsdOut);

        uint256 nftId = positionNFT.mintShort(
            msg.sender,
            address(this),
            address(airUsdToken),
            airTokenMinted,
            airUsdOut,
            totalFee
        );

        airUsdToken.forceApprove(address(positionNFT), 0);

        _assertReserveInvariant();

        emit ShortOpened(nftId, msg.sender, airTokenMinted, airUsdOut, totalFee);
    }

    /**
     * @notice Close a profitable short position.
     *
     *   Settlement
     *   ──────────
     *   The locked airUsd returns from PositionNFT. SWAP-2 (inverse formula)
     *   computes how much airUsd it costs to buy back exactly airTokenMinted
     *   airToken. If the locked airUsd covers that cost, the surplus airUsd is
     *   unwrapped and sent to the holder as USDC.
     *
     *   State changes
     *   ─────────────
     *     airToken supply −= airTokenMinted   (synthetic debt cancelled)
     *     backedAirUsd   += airUsdCostForDebt (cost of buyback restores backing)
     *     airUsd supply  −= lockedAmount    (locked airUsd burned in full)
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

        // ── CHECKS (before any interaction) ──────────────────────────────────
        // Proportion-based cost: how much of lockedAmount is needed to buy back
        // the debt?  We first compute what ALL of lockedAmount would buy, then
        // scale proportionally.  Because cpAmountOut is concave, the proportional
        // estimate overestimates the true cost (conservative; pool never overpays).
        // Ceil-divide so integer truncation never undercuts the real cost.
        uint256 totalBuyable = _cpAmountOut(
            pos.lockedAmount,
            airUsdToken.totalSupply(),
            backedAirToken
        );
        if (totalBuyable == 0 || totalBuyable < pos.airTokenMinted) revert PositionUnderwater();
        uint256 airUsdCostForDebt =
            (pos.lockedAmount * pos.airTokenMinted + totalBuyable - 1) / totalBuyable;
        uint256 surplus    = pos.lockedAmount - airUsdCostForDebt;
        uint256 closeFee   = (surplus * CLOSE_FEE_BPS) / BPS_DENOM;
        uint256 netSurplus = surplus - closeFee;
        if (netSurplus < minUsdcOut) revert InsufficientOutput(netSurplus, minUsdcOut);

        // ── EFFECTS ───────────────────────────────────────────────────────────
        openPositionCount--;
        shortOpenInterest -= pos.lockedAmount;
        backedAirUsd += airUsdCostForDebt;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        positionNFT.release(nftId);
        airToken.burn(address(this), pos.airTokenMinted);
        // Burn the surplus airUsd. The airUsdCostForDebt portion stays as backed
        // airUsd in the pool (reflected in backedAirUsd += above). The surplus
        // is split between the holder (netSurplus) and protocol (closeFee).
        airUsdToken.burn(address(this), surplus);
        underlyingUsdc.safeTransfer(holder, netSurplus);
        underlyingUsdc.safeTransfer(protocolTreasury, closeFee);

        _assertReserveInvariant();

        emit ShortClosed(nftId, holder, netSurplus, pos.airTokenMinted);
    }

    /**
     * @notice Realize a short position at par — the holder delivers the underlying
     *         tokens to cover the synthetic airToken debt and receives the locked
     *         USDC (unwrapped from airUsd) regardless of current token price.
     *
     *   State changes
     *   ─────────────
     *     backedAirToken  += tokenPaid  (synthetic airToken from openShort now has real backing)
     *     airToken supply  unchanged   (minted at openShort; stays — now fully backed)
     *     backedAirUsd    unchanged   (was reduced at open; USDC delivered to holder)
     *     airUsd supply  −= locked    (burned on unwrap)
     *
     * @param nftId  Position NFT token ID.
     */
    function realizeShort(uint256 nftId) external nonReentrant {
        address holder = positionNFT.ownerOf(nftId);
        if (holder != msg.sender) revert OnlyPositionHolder();

        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();
        if (pos.isLong) revert PositionNotShort();

        // EFFECTS.
        openPositionCount--;
        shortOpenInterest -= pos.lockedAmount;

        // The incoming tokens will back what was previously synthetic airToken.
        backedAirToken += pos.airTokenMinted;

        // Pull raw token from caller (== holder, verified above).
        _transferIn(underlyingToken, msg.sender, pos.airTokenMinted);

        // Release NFT: returns lockedAmount of airUsd to pool.
        positionNFT.release(nftId);

        // Burn airUsd wrapper and deliver USDC to holder.
        // backedAirUsd was reduced at open (the USDC backing left with the collateral);
        // sending it back out now correctly zeroes that position's footprint.
        airUsdToken.burn(address(this), pos.lockedAmount);
        underlyingUsdc.safeTransfer(holder, pos.lockedAmount);

        _assertReserveInvariant();

        emit ShortRealized(nftId, holder, pos.airTokenMinted, pos.lockedAmount);
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
        backedAirToken += tokenAmount;
        backedAirUsd  += usdcAmount;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        _transferIn(underlyingToken, msg.sender, tokenAmount);
        _transferIn(underlyingUsdc, msg.sender, usdcAmount);

        airToken.mint(address(this), tokenAmount);
        airUsdToken.mint(address(this), usdcAmount);

        _assertReserveInvariant();

        emit LiquidityAdded(msg.sender, tokenAmount, usdcAmount, backedAirToken, backedAirUsd);
    }

    /**
     * @notice Withdraw 100 % of both backed reserves.
     *         Requires openPositionCount == 0 so that no synthetic debt is
     *         outstanding — otherwise the pool's airToken supply accounting
     *         would be corrupted.
     */
    function removeLiquidity() external nonReentrant onlyLpHolder {
        if (openPositionCount != 0) revert OpenPositionsExist(openPositionCount);
        if (backedAirToken == 0 && backedAirUsd == 0) revert ZeroLiquidity();

        uint256 tokenOut = backedAirToken;
        uint256 usdcOut = backedAirUsd;

        // EFFECTS before interactions.
        backedAirToken = 0;
        backedAirUsd  = 0;

        if (tokenOut > 0) {
            airToken.burn(address(this), tokenOut);
            underlyingToken.safeTransfer(msg.sender, tokenOut);
        }

        if (usdcOut > 0) {
            airUsdToken.burn(address(this), usdcOut);
            underlyingUsdc.safeTransfer(msg.sender, usdcOut);
        }

        emit LiquidityRemoved(msg.sender, tokenOut, usdcOut);
    }

    /**
     * @notice Claim accumulated LP fees in USDC.
     */
    function claimFees() external nonReentrant onlyLpHolder {
        uint256 amount = lpFeesAccumulated;
        if (amount == 0) revert ZeroAmount();

        lpFeesAccumulated = 0;

        underlyingUsdc.safeTransfer(msg.sender, amount);

        emit FeesClaimed(msg.sender, amount);
    }

    // =========================================================================
    // FORCED REALIZATION
    // =========================================================================

    /**
     * @notice Force-realize an underwater position on behalf of the pool.
     *
     *         The LP pays the outstanding synthetic debt so the pool's supply
     *         accounting stays balanced, and the original position holder
     *         receives whatever locked collateral remains (at a loss).
     *
     *         The position must genuinely be underwater:
     *           Long  — SWAP-3 on lockedAirToken would produce < airUsdMinted.
     *           Short — SWAP-2 cost to buy back airTokenMinted > lockedAirUsd.
     *
     * @param nftId  Position NFT to force-realize.
     */
    function forceRealize(uint256 nftId) external nonReentrant onlyLpHolder {
        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();

        address originalHolder = positionNFT.ownerOf(nftId);

        if (pos.isLong) {
            _forceRealizeLong(nftId, pos, originalHolder);
        } else {
            _forceRealizeShort(nftId, pos, originalHolder);
        }
    }

    // =========================================================================
    // VIEWS
    // =========================================================================

    /**
     * @notice Current AMM spot price.
     *         Returns raw USDC units per whole underlying token — i.e. the human-readable
     *         USD price multiplied by 1e6 (USDC's decimal factor).
     *         Divide the result by 1e6 to obtain the price in USD.
     *         Uses SWAP-1 backed reserves. Returns 0 when reserves are empty.
     */
    function spotPrice() external view returns (uint256) {
        if (backedAirToken == 0) return 0;
        return (backedAirUsd * 1e18) / backedAirToken;
    }

    /**
     * @notice Quote a SWAP-1 swap for UI display (no state changes).
     * @return grossOut Output before fee.
     * @return fee      Swap fee retained by pool.
     * @return netOut   Amount caller would receive.
     */
    function quoteSwap(
        uint256 amountIn,
        bool tokenToUsdc
    ) external view returns (uint256 grossOut, uint256 fee, uint256 netOut) {
        if (amountIn == 0 || backedAirToken == 0 || backedAirUsd == 0) return (0, 0, 0);

        if (tokenToUsdc) {
            grossOut = (amountIn * backedAirUsd) / (backedAirToken + amountIn);
            fee      = (amountIn * backedAirUsd * swapFeeBps) / (backedAirToken * BPS_DENOM);
        } else {
            grossOut = (amountIn * backedAirToken) / (backedAirUsd + amountIn);
            fee      = (amountIn * backedAirToken * swapFeeBps) / (backedAirUsd * BPS_DENOM);
        }
        netOut = grossOut > fee ? grossOut - fee : 0;
    }

    /**
     * @notice Compute the effective leverage cap in USDC for a new position.
     *         Returns type(uint256).max when both caps are disabled.
     */
    function effectiveLeverageCap() external view returns (uint256) {
        return _computeLeverageCap();
    }

    /**
     * @notice Returns true if a long position is currently underwater (not profitable to close).
     *         Uses the same SWAP-3 formula as closeLong and forceRealize.
     */
    function isLongUnderwater(uint256 nftId) external view returns (bool) {
        return _longIsUnderwater(positionNFT.getPosition(nftId));
    }

    /**
     * @notice Returns true if a short position is currently underwater (not profitable to close).
     *         Uses SWAP-2 cpOut(lockedAmount, airUsd.totalSupply(), backedAirToken) < airTokenMinted.
     */
    function isShortUnderwater(uint256 nftId) external view returns (bool) {
        return _shortIsUnderwater(positionNFT.getPosition(nftId));
    }

    // =========================================================================
    // INTERNAL — swap helpers
    // =========================================================================

    /**
     * @dev Execute a token → USDC SWAP-1.
     *      Extracted to a dedicated function to keep swap()'s stack frame lean.
     */
    function _swapTokenToUsdc(uint256 amountIn, uint256 minAmountOut) internal {
        // ── CHECK (against pre-swap reserves) ─────────────────────────────────
        uint256 netOut = _cpAmountOut(amountIn, backedAirToken, backedAirUsd);
        if (netOut < minAmountOut) revert InsufficientOutput(netOut, minAmountOut);

        // ── EFFECTS ───────────────────────────────────────────────────────────
        backedAirToken += amountIn;
        backedAirUsd  -= netOut;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        // Pull raw token from caller; wrap to airToken; unwrap output airUsd → USDC; deliver.
        _transferIn(underlyingToken, msg.sender, amountIn);
        airToken.mint(address(this), amountIn);
        airUsdToken.burn(address(this), netOut);
        underlyingUsdc.safeTransfer(msg.sender, netOut);

        _assertReserveInvariant();

        emit Swap(msg.sender, address(underlyingToken), amountIn, address(underlyingUsdc), netOut);
    }

    /**
     * @dev Execute a USDC → token SWAP-1.
     */
    function _swapUsdcToToken(uint256 amountIn, uint256 minAmountOut) internal {
        // ── CHECK (against pre-swap reserves) ─────────────────────────────────
        uint256 netOut = _cpAmountOut(amountIn, backedAirUsd, backedAirToken);
        if (netOut < minAmountOut) revert InsufficientOutput(netOut, minAmountOut);

        // ── EFFECTS ───────────────────────────────────────────────────────────
        backedAirUsd  += amountIn;
        backedAirToken -= netOut;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        // Pull USDC from caller; wrap to airUsd; unwrap output airToken → raw token; deliver.
        _transferIn(underlyingUsdc, msg.sender, amountIn);
        airUsdToken.mint(address(this), amountIn);
        airToken.burn(address(this), netOut);
        underlyingToken.safeTransfer(msg.sender, netOut);

        _assertReserveInvariant();

        emit Swap(msg.sender, address(underlyingUsdc), amountIn, address(underlyingToken), netOut);
    }

    // =========================================================================
    // INTERNAL — forced realization helpers
    // =========================================================================

    /**
     * @dev Force-realize an underwater long position.
     *      LP pays airUsdMinted in USDC; original holder receives locked token.
     */
    function _forceRealizeLong(uint256 nftId, Position memory pos, address originalHolder) internal {
        // Verify position is genuinely underwater via SWAP-3.
        if (!_longIsUnderwater(pos)) revert PositionAlreadyProfitable();

        // EFFECTS.
        openPositionCount--;
        longOpenInterest -= pos.airUsdMinted;

        // LP pays the full synthetic debt in USDC, converting it from synthetic
        // to real backing. The airUsd minted at openLong is NOT burned here —
        // it remains in supply but is now fully backed by the LP's USDC payment.
        // net effect on backedAirUsd: +airUsdMinted (pool gains real USDC backing).
        backedAirUsd += pos.airUsdMinted;
        _transferIn(underlyingUsdc, msg.sender, pos.airUsdMinted);

        // Release NFT: locked airToken returns to pool.
        positionNFT.release(nftId);

        // Deliver the underlying token to the original holder (at a loss).
        // Burn the airToken wrapper first; underlying token is already in contract.
        airToken.burn(address(this), pos.lockedAmount);
        underlyingToken.safeTransfer(originalHolder, pos.lockedAmount);

        _assertReserveInvariant();

        emit PositionForceRealized(nftId, msg.sender, pos.airUsdMinted);
    }

    /**
     * @dev Force-realize an underwater short position.
     *      LP pays airTokenMinted in raw token; original holder receives locked USDC.
     */
    function _forceRealizeShort(uint256 nftId, Position memory pos, address originalHolder) internal {
        // Verify position is genuinely underwater via SWAP-2 inverse.
        if (!_shortIsUnderwater(pos)) revert PositionAlreadyProfitable();

        // EFFECTS.
        openPositionCount--;
        shortOpenInterest -= pos.lockedAmount;

        // LP pays the synthetic airToken debt with raw underlying tokens.
        // The real token converts the previously synthetic airToken to backed airToken,
        // mirroring _forceRealizeLong's backedAirUsd += pos.airUsdMinted.
        backedAirToken += pos.airTokenMinted;

        _transferIn(underlyingToken, msg.sender, pos.airTokenMinted);

        // Release NFT: locked airUsd returns to pool.
        positionNFT.release(nftId);

        // Deliver USDC to original holder (at a loss).
        airUsdToken.burn(address(this), pos.lockedAmount);
        underlyingUsdc.safeTransfer(originalHolder, pos.lockedAmount);

        _assertReserveInvariant();

        emit PositionForceRealized(nftId, msg.sender, pos.airTokenMinted);
    }

    // =========================================================================
    // INTERNAL — underwater checks
    // =========================================================================

    function _longIsUnderwater(Position memory pos) internal view returns (bool) {
        uint256 airTokenSupply = airToken.totalSupply();
        if (airTokenSupply < pos.lockedAmount) return true;
        uint256 airUsdOut = _cpAmountOut(
            pos.lockedAmount,
            airTokenSupply - pos.lockedAmount,
            backedAirUsd
        );
        return airUsdOut < pos.airUsdMinted;
    }

    function _shortIsUnderwater(Position memory pos) internal view returns (bool) {
        // A short is underwater when the locked USDC can no longer buy back the synthetic airToken debt.
        return _cpAmountOut(
            pos.lockedAmount,
            airUsdToken.totalSupply(),
            backedAirToken
        ) < pos.airTokenMinted;
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
    // INTERNAL — leverage cap
    // =========================================================================

    function _checkLeverageCap(uint256 usdcNotional) internal view {
        uint256 cap = _computeLeverageCap();
        if (cap != type(uint256).max && usdcNotional > cap) {
            revert LeverageCapExceeded(usdcNotional, cap);
        }
    }

    function _computeLeverageCap() internal view returns (uint256) {
        bool usdEnabled = maxPositionUsd > 0;
        bool bpsEnabled = maxPositionBps > 0;

        if (!usdEnabled && !bpsEnabled) return type(uint256).max;

        uint256 usdCap = usdEnabled ? maxPositionUsd : type(uint256).max;
        uint256 bpsCap = bpsEnabled ? (backedAirUsd * maxPositionBps) / BPS_DENOM : type(uint256).max;

        return usdCap < bpsCap ? usdCap : bpsCap;
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
    // INTERNAL — invariant assertion
    // =========================================================================

    /**
     * @dev Backed reserves must never exceed the corresponding airToken's total
     *      supply. Violation would mean the pool claims to hold more airToken
     *      than exists, which is impossible and signals an accounting bug.
     */
    function _assertReserveInvariant() internal view {
        if (backedAirToken > airToken.totalSupply()) revert ReserveInvariantViolated();
        if (backedAirUsd  > airUsdToken.totalSupply())  revert ReserveInvariantViolated();
    }
}
