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
 *        Long  — lockedToken = airMeme, lockedAmount = airMemeLocked,
 *                usdcIn, airUsdMinted, feesPaid
 *        Short — lockedToken = airUsd,  lockedAmount = airUsdLocked,
 *                airMemeMinted, feesPaid
 */
struct Position {
    bool    isLong;
    address pool;
    address lockedToken;
    uint256 lockedAmount;
    uint256 usdcIn;
    uint256 airUsdMinted;
    uint256 airMemeMinted;
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
        address airMemeToken,
        uint256 usdcIn,
        uint256 airUsdMinted,
        uint256 airMemeLocked,
        uint256 feesPaid
    ) external returns (uint256 tokenId);

    function mintShort(
        address to,
        address pool,
        address airUsdToken,
        uint256 airMemeMinted,
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
 *         platform. One pool is created per meme/USDC market by the factory.
 *
 * ── AMM Modes ────────────────────────────────────────────────────────────────
 *
 *   x and y denote the two pool RESERVES (not trade direction — either side
 *   can be input or output depending on the operation).
 *
 *   SWAP-1  Normal swap          x = backedAirMeme,          y = backedAirUsd
 *   SWAP-2  Long-open/Short-close x = backedAirMeme,         y = airUsd.totalSupply()
 *   SWAP-3  Short-open/Long-close x = airMeme.totalSupply(), y = backedAirUsd
 *
 *   All three modes use the standard constant-product formula:
 *     amountOut = amountIn * reserveOut / (reserveIn + amountIn)
 *
 * ── Reserve Accounting ───────────────────────────────────────────────────────
 *
 *   backedAirMeme  Tracks the amount of airMeme that has real underlying meme
 *                  collateral behind it.  Increases on LP deposits and on meme
 *                  token swaps-in; decreases on meme swaps-out and on openLong
 *                  (collateral leaves to PositionNFT custody).
 *
 *   backedAirUsd   Same for the airUsd / USDC side.  Increases on LP deposits
 *                  and USDC swaps-in; decreases on USDC swaps-out and on
 *                  openShort (collateral leaves to PositionNFT custody).
 *
 *   Synthetic mints (openLong mints airUsd, openShort mints airMeme) do NOT
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
 *   - Reserve invariant: backedAirMeme ≤ airMeme.totalSupply() and vice versa,
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

    /// @notice AirToken wrapping the meme asset (typically 18 decimals).
    IAirToken public immutable airMemeToken;

    /// @notice AirToken wrapping USDC (6 decimals).
    IAirToken public immutable airUsdToken;

    /// @notice Raw meme ERC-20 held as collateral by this pool.
    IERC20 public immutable underlyingMeme;

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

    /// @notice airMeme backed 1 : 1 by deposited underlying meme tokens.
    uint256 public backedAirMeme;

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
        uint256 memeAmount,
        uint256 usdcAmount,
        uint256 backedAirMeme,
        uint256 backedAirUsd
    );

    event LiquidityRemoved(
        address indexed provider,
        uint256 memeAmount,
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
        uint256 airMemeLocked,
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
        uint256 airMemeMinted,
        uint256 airUsdLocked,
        uint256 feesPaid
    );

    event ShortClosed(
        uint256 indexed nftId,
        address indexed holder,
        uint256 profit,
        uint256 airMemeBurned
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
        uint256 memeDelivered
    );

    event ShortRealized(
        uint256 indexed nftId,
        address indexed holder,
        uint256 memePaid,     // == airMemeMinted (synthetic debt settled at par)
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
     * @param airMemeToken_     AirToken wrapper for the meme asset.
     * @param airUsdToken_      AirToken wrapper for USDC.
     * @param underlyingMeme_   Raw meme ERC-20 deposited by LP.
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
        address airMemeToken_,
        address airUsdToken_,
        address underlyingMeme_,
        address underlyingUsdc_,
        address positionNFT_,
        address lpNftContract_,
        uint256 lpNftId_,
        address protocolTreasury_,
        uint256 maxPositionUsd_,
        uint256 maxPositionBps_,
        uint256 swapFeeBps_
    ) {
        if (airMemeToken_     == address(0)) revert ZeroAddress();
        if (airUsdToken_      == address(0)) revert ZeroAddress();
        if (underlyingMeme_   == address(0)) revert ZeroAddress();
        if (underlyingUsdc_   == address(0)) revert ZeroAddress();
        if (positionNFT_      == address(0)) revert ZeroAddress();
        if (lpNftContract_    == address(0)) revert ZeroAddress();
        if (protocolTreasury_ == address(0)) revert ZeroAddress();
        if (maxPositionBps_ != 0 && (maxPositionBps_ < 10 || maxPositionBps_ > 9900)) {
            revert InvalidMaxPositionBps();
        }
        if (swapFeeBps_ >= BPS_DENOM) revert InvalidSwapFeeBps();

        airMemeToken     = IAirToken(airMemeToken_);
        airUsdToken      = IAirToken(airUsdToken_);
        underlyingMeme   = IERC20(underlyingMeme_);
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
    // SWAP  (SWAP-1: x = backedAirMeme, y = backedAirUsd)
    // =========================================================================

    /**
     * @notice Swap raw meme tokens for USDC or vice versa.
     *
     *         The pool auto-wraps the inbound raw token into the matching
     *         airToken (increasing that side's backed reserve) and auto-unwraps
     *         the outbound airToken back to raw (decreasing that side's backed
     *         reserve). The swap fee (swapFeeBps) is kept in the pool by *not*
     *         reducing the output-side backed reserve by the fee amount, which
     *         passively grows LP value over time.
     *
     * @param amountIn     Raw token amount in (meme decimals or USDC 6 dec).
     * @param minAmountOut Slippage guard on the raw output amount.
     * @param memeToUsdc   true = meme → USDC, false = USDC → meme.
     */
    function swap(
        uint256 amountIn,
        uint256 minAmountOut,
        bool memeToUsdc
    ) external nonReentrant {
        if (amountIn == 0) revert ZeroAmount();
        if (backedAirMeme == 0 || backedAirUsd == 0) revert InsufficientBackedReserves();

        if (memeToUsdc) {
            _swapMemeToUsdc(amountIn, minAmountOut);
        } else {
            _swapUsdcToMeme(amountIn, minAmountOut);
        }
    }

    // =========================================================================
    // LONG POSITIONS
    // =========================================================================

    /**
     * @notice Open a leveraged long on the meme token.
     *
     *   How leverage works
     *   ──────────────────
     *   The pool mints `usdcAmount` of synthetic airUsd without adding any USDC
     *   backing (totalSupply grows, backedAirUsd stays flat). SWAP-2 then prices
     *   airMeme against this inflated airUsd supply, so the trader receives more
     *   airMeme per USDC than the backed ratio would give — that is the leverage.
     *   The minted airMeme leaves the pool's backed reserves and is locked in the
     *   PositionNFT. The synthetic airUsd remains as an outstanding debt in
     *   totalSupply until the position is closed or realized.
     *
     *   State changes
     *   ─────────────
     *     backedAirMeme  −= airMemeOut  (collateral locked away)
     *     airUsd supply  += usdcAmount  (synthetic debt created; NOT backed)
     *
     * @param usdcAmount    USDC notional (6 dec). A 5 % fee is charged on top.
     * @param minAirMemeOut Slippage guard on the airMeme locked in the NFT.
     */
    function openLong(
        uint256 usdcAmount,
        uint256 minAirMemeOut
    ) external nonReentrant {
        if (usdcAmount == 0) revert ZeroAmount();
        if (backedAirMeme == 0 || backedAirUsd == 0) revert InsufficientBackedReserves();

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

        // SWAP-2: compute airMeme output before any state changes.
        // reserveIn  = airUsd.totalSupply() before the synthetic mint below.
        // reserveOut = backedAirMeme
        uint256 airMemeOut = _cpAmountOut(
            usdcAmount,
            airUsdToken.totalSupply(),
            backedAirMeme
        );

        if (airMemeOut == 0) revert ZeroAmount();
        if (airMemeOut < minAirMemeOut) revert InsufficientOutput(airMemeOut, minAirMemeOut);
        if (airMemeOut > backedAirMeme) revert InsufficientBackedReserves();

        // ── EFFECTS ───────────────────────────────────────────────────────────
        openPositionCount++;
        longOpenInterest += usdcAmount;
        lpFeesAccumulated += lpFee;

        // Mint synthetic airUsd: inflates totalSupply, no new backing.
        // The full usdcAmount becomes the synthetic debt regardless of fees
        // because the trader's notional position size is usdcAmount.
        airUsdToken.mint(address(this), usdcAmount);

        // Collateral leaves the pool's backed reserves into PositionNFT custody.
        backedAirMeme -= airMemeOut;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        // The notional is NOT pulled — it is represented synthetically by the
        // airUsd minted above.  Only the 5 % fee is collected from the trader.
        _transferIn(underlyingUsdc, msg.sender, totalFee);
        underlyingUsdc.safeTransfer(protocolTreasury, protocolFee);

        airMemeToken.forceApprove(address(positionNFT), airMemeOut);

        uint256 nftId = positionNFT.mintLong(
            msg.sender,
            address(this),
            address(airMemeToken),
            usdcAmount,   // usdcIn
            usdcAmount,   // airUsdMinted — synthetic debt owed
            airMemeOut,   // airMemeLocked
            totalFee
        );

        // Clear any residual approval.
        airMemeToken.forceApprove(address(positionNFT), 0);

        _assertReserveInvariant();

        emit LongOpened(nftId, msg.sender, usdcAmount, usdcAmount, airMemeOut, totalFee);
    }

    /**
     * @notice Close a profitable long position.
     *
     *   Settlement
     *   ──────────
     *   The locked airMeme returns from PositionNFT. SWAP-3 prices it against
     *   (airMeme.totalSupply() − lockedAmount, backedAirUsd). If the resulting
     *   airUsd ≥ the synthetic debt (airUsdMinted), the surplus is unwrapped and
     *   sent to the holder as USDC. The synthetic debt is burned; the returned
     *   airMeme stays in the pool as fully-backed LP collateral.
     *
     *   State changes
     *   ─────────────
     *     backedAirMeme  += lockedAmount  (airMeme collateral returns to LP reserves)
     *     backedAirUsd   −= surplus       (only the profit USDC exits the pool's backing)
     *     airUsd supply  −= airUsdMinted  (synthetic debt cancelled)
     *     airUsd supply  −= surplus       (backed wrappers burned for USDC paid to holder)
     *
     *   Note: airMeme wrappers are NOT burned. The underlying meme never left the
     *   pool, so the returned airMeme wrappers correctly represent LP's restored
     *   claim on that meme. Burning them would orphan the underlying tokens.
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
        // release() only transfers airMeme; it does not mint or burn, so
        // totalSupply() is identical before and after — safe to compute here.
        uint256 airMemeSupply = airMemeToken.totalSupply();
        if (airMemeSupply < pos.lockedAmount) revert PositionUnderwater();
        uint256 airUsdOut = _cpAmountOut(
            pos.lockedAmount,
            airMemeSupply - pos.lockedAmount,
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
        // The meme collateral returns to LP's backed reserves. The underlying
        // meme never left the pool, so restoring backedAirMeme correctly
        // reconciles the returned airMeme wrappers with their real backing.
        backedAirMeme += pos.lockedAmount;
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
     *         and receives the locked meme tokens at whatever price they were
     *         acquired, regardless of market movements.
     *
     *   This is a non-speculative exit path: no profit or loss on meme price,
     *   the trader simply converts their synthetic debt into real USDC and
     *   receives the raw meme tokens.
     *
     *   State changes
     *   ─────────────
     *     backedAirUsd  += usdcPaid   (synthetic airUsd from openLong now has real backing)
     *     airUsd supply  unchanged    (minted at openLong; stays — now fully backed)
     *     backedAirMeme  unchanged    (was reduced at open; meme delivered to holder)
     *     airMeme supply −= locked    (burned on unwrap)
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

        // Release NFT: returns lockedAmount of airMeme to pool.
        positionNFT.release(nftId);

        // Burn airMeme wrapper and deliver raw meme to holder.
        // backedAirMeme was reduced at open; no adjustment needed here because
        // the delivered meme comes from the LP's original collateral pool.
        airMemeToken.burn(address(this), pos.lockedAmount);
        underlyingMeme.safeTransfer(holder, pos.lockedAmount);

        _assertReserveInvariant();

        emit LongRealized(nftId, holder, pos.airUsdMinted, pos.lockedAmount);
    }

    // =========================================================================
    // SHORT POSITIONS
    // =========================================================================

    /**
     * @notice Open a leveraged short on the meme token.
     *
     *   How leverage works
     *   ──────────────────
     *   The pool mints synthetic airMeme proportional to the USDC notional at
     *   the current backed rate. This inflates airMeme totalSupply.
     *   The resulting airUsd (real, from backedAirUsd) is locked in
     *   the PositionNFT. The synthetic airMeme remains as outstanding debt in
     *   totalSupply until the position is closed or realized.
     *
     *   State changes
     *   ─────────────
     *     airMeme supply += airMemeMinted  (synthetic debt; NOT backed)
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
        if (backedAirMeme == 0 || backedAirUsd == 0) revert InsufficientBackedReserves();

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

        // Compute synthetic airMeme to mint using the current SWAP-1 reference rate:
        //   airMemeMinted = usdcNotional * airMeme.totalSupply() / backedAirUsd
        // This gives the airMeme amount that is worth usdcNotional at backed prices.
        uint256 airMemeSupplyBefore = airMemeToken.totalSupply();
        if (airMemeSupplyBefore == 0) revert InsufficientBackedReserves();

        uint256 airMemeMinted = (usdcNotional * airMemeSupplyBefore) / backedAirUsd;
        if (airMemeMinted == 0) revert ZeroAmount();

        // SWAP-3: compute airUsd output before any state changes.
        // reserveIn  = airMeme.totalSupply() before the synthetic mint below.
        // reserveOut = backedAirUsd
        uint256 airUsdOut = _cpAmountOut(airMemeMinted, airMemeSupplyBefore, backedAirUsd);

        if (airUsdOut == 0) revert ZeroAmount();
        if (airUsdOut < minAirUsdOut) revert InsufficientOutput(airUsdOut, minAirUsdOut);
        if (airUsdOut > backedAirUsd) revert InsufficientBackedReserves();

        // ── EFFECTS ──────────────────────────────────────────────────────────
        openPositionCount++;
        shortOpenInterest += airUsdOut;
        lpFeesAccumulated += lpFee;

        // Mint synthetic airMeme: inflates totalSupply, no new meme backing.
        airMemeToken.mint(address(this), airMemeMinted);

        // Real airUsd leaves the pool's backed reserves into PositionNFT custody.
        backedAirUsd -= airUsdOut;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        // The notional is NOT pulled — it is represented synthetically by the
        // airMeme minted above.  Only the 5 % fee is collected from the trader.
        _transferIn(underlyingUsdc, msg.sender, totalFee);
        underlyingUsdc.safeTransfer(protocolTreasury, protocolFee);

        airUsdToken.forceApprove(address(positionNFT), airUsdOut);

        uint256 nftId = positionNFT.mintShort(
            msg.sender,
            address(this),
            address(airUsdToken),
            airMemeMinted,
            airUsdOut,
            totalFee
        );

        airUsdToken.forceApprove(address(positionNFT), 0);

        _assertReserveInvariant();

        emit ShortOpened(nftId, msg.sender, airMemeMinted, airUsdOut, totalFee);
    }

    /**
     * @notice Close a profitable short position.
     *
     *   Settlement
     *   ──────────
     *   The locked airUsd returns from PositionNFT. SWAP-2 (inverse formula)
     *   computes how much airUsd it costs to buy back exactly airMemeMinted
     *   airMeme. If the locked airUsd covers that cost, the surplus airUsd is
     *   unwrapped and sent to the holder as USDC.
     *
     *   State changes
     *   ─────────────
     *     airMeme supply −= airMemeMinted   (synthetic debt cancelled)
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
            backedAirMeme
        );
        if (totalBuyable == 0 || totalBuyable < pos.airMemeMinted) revert PositionUnderwater();
        uint256 airUsdCostForDebt =
            (pos.lockedAmount * pos.airMemeMinted + totalBuyable - 1) / totalBuyable;
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
        airMemeToken.burn(address(this), pos.airMemeMinted);
        // Burn the surplus airUsd. The airUsdCostForDebt portion stays as backed
        // airUsd in the pool (reflected in backedAirUsd += above). The surplus
        // is split between the holder (netSurplus) and protocol (closeFee).
        airUsdToken.burn(address(this), surplus);
        underlyingUsdc.safeTransfer(holder, netSurplus);
        underlyingUsdc.safeTransfer(protocolTreasury, closeFee);

        _assertReserveInvariant();

        emit ShortClosed(nftId, holder, netSurplus, pos.airMemeMinted);
    }

    /**
     * @notice Realize a short position at par — the holder delivers the meme
     *         tokens to cover the synthetic airMeme debt and receives the locked
     *         USDC (unwrapped from airUsd) regardless of current meme price.
     *
     *   State changes
     *   ─────────────
     *     backedAirMeme  += memePaid  (synthetic airMeme from openShort now has real backing)
     *     airMeme supply  unchanged   (minted at openShort; stays — now fully backed)
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

        // The incoming MEME will back what was previously synthetic airMeme.
        backedAirMeme += pos.airMemeMinted;

        // Pull raw meme from caller (== holder, verified above).
        _transferIn(underlyingMeme, msg.sender, pos.airMemeMinted);

        // Release NFT: returns lockedAmount of airUsd to pool.
        positionNFT.release(nftId);

        // Burn airUsd wrapper and deliver USDC to holder.
        // backedAirUsd was reduced at open (the USDC backing left with the collateral);
        // sending it back out now correctly zeroes that position's footprint.
        airUsdToken.burn(address(this), pos.lockedAmount);
        underlyingUsdc.safeTransfer(holder, pos.lockedAmount);

        _assertReserveInvariant();

        emit ShortRealized(nftId, holder, pos.airMemeMinted, pos.lockedAmount);
    }

    // =========================================================================
    // LIQUIDITY MANAGEMENT
    // =========================================================================

    /**
     * @notice Deposit liquidity on both sides of the pool.
     *
     *         For non-empty pools the deposit must match the current
     *         backedAirMeme : backedAirUsd ratio (within 0.01 % rounding
     *         tolerance) to avoid shifting the AMM price.
     *
     *         Only the direct owner of the LP NFT may call this — not approved
     *         operators. This is intentional: ownership is the gate.
     *
     * @param memeAmount  Raw meme tokens to deposit.
     * @param usdcAmount  USDC to deposit (6 dec).
     */
    function addLiquidity(uint256 memeAmount, uint256 usdcAmount) external nonReentrant onlyLpHolder {
        if (memeAmount == 0 || usdcAmount == 0) revert ZeroAmount();

        // Ratio check for non-empty pools (cross-multiplication avoids precision loss).
        if (backedAirMeme != 0 && backedAirUsd != 0) {
            uint256 lhs       = memeAmount * backedAirUsd;
            uint256 rhs       = usdcAmount * backedAirMeme;
            uint256 tolerance = (lhs > rhs ? lhs : rhs) / 10_000 + 1;
            if (lhs > rhs + tolerance || rhs > lhs + tolerance) revert RatioMismatch();
        }

        // ── EFFECTS ───────────────────────────────────────────────────────────
        backedAirMeme += memeAmount;
        backedAirUsd  += usdcAmount;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        _transferIn(underlyingMeme, msg.sender, memeAmount);
        _transferIn(underlyingUsdc, msg.sender, usdcAmount);

        airMemeToken.mint(address(this), memeAmount);
        airUsdToken.mint(address(this), usdcAmount);

        _assertReserveInvariant();

        emit LiquidityAdded(msg.sender, memeAmount, usdcAmount, backedAirMeme, backedAirUsd);
    }

    /**
     * @notice Withdraw 100 % of both backed reserves.
     *         Requires openPositionCount == 0 so that no synthetic debt is
     *         outstanding — otherwise the pool's airToken supply accounting
     *         would be corrupted.
     */
    function removeLiquidity() external nonReentrant onlyLpHolder {
        if (openPositionCount != 0) revert OpenPositionsExist(openPositionCount);
        if (backedAirMeme == 0 && backedAirUsd == 0) revert ZeroLiquidity();

        uint256 memeOut = backedAirMeme;
        uint256 usdcOut = backedAirUsd;

        // EFFECTS before interactions.
        backedAirMeme = 0;
        backedAirUsd  = 0;

        if (memeOut > 0) {
            airMemeToken.burn(address(this), memeOut);
            underlyingMeme.safeTransfer(msg.sender, memeOut);
        }

        if (usdcOut > 0) {
            airUsdToken.burn(address(this), usdcOut);
            underlyingUsdc.safeTransfer(msg.sender, usdcOut);
        }

        emit LiquidityRemoved(msg.sender, memeOut, usdcOut);
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
     *           Long  — SWAP-3 on lockedAirMeme would produce < airUsdMinted.
     *           Short — SWAP-2 cost to buy back airMemeMinted > lockedAirUsd.
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
     *         Returns raw USDC units per whole meme token — i.e. the human-readable
     *         USD price multiplied by 1e6 (USDC's decimal factor).
     *         Divide the result by 1e6 to obtain the price in USD.
     *         Uses SWAP-1 backed reserves. Returns 0 when reserves are empty.
     */
    function spotPrice() external view returns (uint256) {
        if (backedAirMeme == 0) return 0;
        return (backedAirUsd * 1e18) / backedAirMeme;
    }

    /**
     * @notice Quote a SWAP-1 swap for UI display (no state changes).
     * @return grossOut Output before fee.
     * @return fee      Swap fee retained by pool.
     * @return netOut   Amount caller would receive.
     */
    function quoteSwap(
        uint256 amountIn,
        bool memeToUsdc
    ) external view returns (uint256 grossOut, uint256 fee, uint256 netOut) {
        if (amountIn == 0 || backedAirMeme == 0 || backedAirUsd == 0) return (0, 0, 0);

        if (memeToUsdc) {
            grossOut = (amountIn * backedAirUsd) / (backedAirMeme + amountIn);
            fee      = (amountIn * backedAirUsd * swapFeeBps) / (backedAirMeme * BPS_DENOM);
        } else {
            grossOut = (amountIn * backedAirMeme) / (backedAirUsd + amountIn);
            fee      = (amountIn * backedAirMeme * swapFeeBps) / (backedAirUsd * BPS_DENOM);
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
     *         Uses SWAP-2 cpOut(lockedAmount, airUsd.totalSupply(), backedAirMeme) < airMemeMinted.
     */
    function isShortUnderwater(uint256 nftId) external view returns (bool) {
        return _shortIsUnderwater(positionNFT.getPosition(nftId));
    }

    // =========================================================================
    // INTERNAL — swap helpers
    // =========================================================================

    /**
     * @dev Execute a meme → USDC SWAP-1.
     *      Extracted to a dedicated function to keep swap()'s stack frame lean.
     */
    function _swapMemeToUsdc(uint256 amountIn, uint256 minAmountOut) internal {
        // ── CHECK (against pre-swap reserves) ─────────────────────────────────
        uint256 netOut = _cpAmountOut(amountIn, backedAirMeme, backedAirUsd);
        if (netOut < minAmountOut) revert InsufficientOutput(netOut, minAmountOut);

        // ── EFFECTS ───────────────────────────────────────────────────────────
        backedAirMeme += amountIn;
        backedAirUsd  -= netOut;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        // Pull raw meme from caller; wrap to airMeme; unwrap output airUsd → USDC; deliver.
        _transferIn(underlyingMeme, msg.sender, amountIn);
        airMemeToken.mint(address(this), amountIn);
        airUsdToken.burn(address(this), netOut);
        underlyingUsdc.safeTransfer(msg.sender, netOut);

        _assertReserveInvariant();

        emit Swap(msg.sender, address(underlyingMeme), amountIn, address(underlyingUsdc), netOut);
    }

    /**
     * @dev Execute a USDC → meme SWAP-1.
     */
    function _swapUsdcToMeme(uint256 amountIn, uint256 minAmountOut) internal {
        // ── CHECK (against pre-swap reserves) ─────────────────────────────────
        uint256 netOut = _cpAmountOut(amountIn, backedAirUsd, backedAirMeme);
        if (netOut < minAmountOut) revert InsufficientOutput(netOut, minAmountOut);

        // ── EFFECTS ───────────────────────────────────────────────────────────
        backedAirUsd  += amountIn;
        backedAirMeme -= netOut;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        // Pull USDC from caller; wrap to airUsd; unwrap output airMeme → raw meme; deliver.
        _transferIn(underlyingUsdc, msg.sender, amountIn);
        airUsdToken.mint(address(this), amountIn);
        airMemeToken.burn(address(this), netOut);
        underlyingMeme.safeTransfer(msg.sender, netOut);

        _assertReserveInvariant();

        emit Swap(msg.sender, address(underlyingUsdc), amountIn, address(underlyingMeme), netOut);
    }

    // =========================================================================
    // INTERNAL — forced realization helpers
    // =========================================================================

    /**
     * @dev Force-realize an underwater long position.
     *      LP pays airUsdMinted in USDC; original holder receives locked meme.
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

        // Release NFT: locked airMeme returns to pool.
        positionNFT.release(nftId);

        // Deliver the underlying meme to the original holder (at a loss).
        // Burn the airMeme wrapper first; underlying meme is already in contract.
        airMemeToken.burn(address(this), pos.lockedAmount);
        underlyingMeme.safeTransfer(originalHolder, pos.lockedAmount);

        _assertReserveInvariant();

        emit PositionForceRealized(nftId, msg.sender, pos.airUsdMinted);
    }

    /**
     * @dev Force-realize an underwater short position.
     *      LP pays airMemeMinted in raw meme; original holder receives locked USDC.
     */
    function _forceRealizeShort(uint256 nftId, Position memory pos, address originalHolder) internal {
        // Verify position is genuinely underwater via SWAP-2 inverse.
        if (!_shortIsUnderwater(pos)) revert PositionAlreadyProfitable();

        // EFFECTS.
        openPositionCount--;
        shortOpenInterest -= pos.lockedAmount;

        // LP pays the synthetic airMeme debt with raw meme tokens.
        // The real meme converts the previously synthetic airMeme to backed airMeme,
        // mirroring _forceRealizeLong's backedAirUsd += pos.airUsdMinted.
        backedAirMeme += pos.airMemeMinted;

        _transferIn(underlyingMeme, msg.sender, pos.airMemeMinted);

        // Release NFT: locked airUsd returns to pool.
        positionNFT.release(nftId);

        // Deliver USDC to original holder (at a loss).
        airUsdToken.burn(address(this), pos.lockedAmount);
        underlyingUsdc.safeTransfer(originalHolder, pos.lockedAmount);

        _assertReserveInvariant();

        emit PositionForceRealized(nftId, msg.sender, pos.airMemeMinted);
    }

    // =========================================================================
    // INTERNAL — underwater checks
    // =========================================================================

    function _longIsUnderwater(Position memory pos) internal view returns (bool) {
        uint256 airMemeSupply = airMemeToken.totalSupply();
        if (airMemeSupply < pos.lockedAmount) return true;
        uint256 airUsdOut = _cpAmountOut(
            pos.lockedAmount,
            airMemeSupply - pos.lockedAmount,
            backedAirUsd
        );
        return airUsdOut < pos.airUsdMinted;
    }

    function _shortIsUnderwater(Position memory pos) internal view returns (bool) {
        // A short is underwater when the locked USDC can no longer buy back the synthetic airMeme debt.
        return _cpAmountOut(
            pos.lockedAmount,
            airUsdToken.totalSupply(),
            backedAirMeme
        ) < pos.airMemeMinted;
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
        if (backedAirMeme > airMemeToken.totalSupply()) revert ReserveInvariantViolated();
        if (backedAirUsd  > airUsdToken.totalSupply())  revert ReserveInvariantViolated();
    }
}
