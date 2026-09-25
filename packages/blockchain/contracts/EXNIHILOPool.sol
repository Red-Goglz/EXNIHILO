// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev Position record shared with PositionNFT. Every amount is AS AT OPEN:
///      funding scales collateral, debt and notional by
///      fundingIndex / fundingIndexAtOpen, so read live figures through
///      EXNIHILOPool.liveAmountsOf() or effectiveLocked().
///        Long:  lockedAmountAtOpen = airToken, debt = airUsdMinted
///        Short: lockedAmountAtOpen = airUsd,   debt = airTokenMinted
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

interface ILpNFT {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/**
 * @title  EXNIHILOPool
 * @notice One token/USDC market: a spot AMM plus fee-only leveraged longs and
 *         shorts, charged continuous funding.
 * @dev    airToken / airUsd are accounting units, not ERC-20s. Three
 *         constant-product curves share the reserves:
 *           SWAP-1  spot                     x = backedAirToken  y = backedAirUsd
 *           SWAP-2  long open / short close  x = backedAirToken  y = airUsdSupply
 *           SWAP-3  short open / long close  x = airTokenSupply  y = backedAirUsd
 *         Backed reserves are LP-owned; supply counters also carry position
 *         collateral and synthetic debt.
 */
contract EXNIHILOPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Constants ─────────────────────────────────────────────────────────────

    uint256 private constant BPS_DENOM        = 10_000;
    uint256 private constant LP_FEE_BPS       = 400;   // 4 % of notional → LP
    uint256 private constant PROTOCOL_FEE_BPS = 100;   // 1 % of notional → protocol
    uint256 private constant MIN_POSITION_FEE = 50_000; // 0.05 USDC open-fee floor, split 4:1
    uint256 private constant CLOSE_FEE_BPS    = 100;   // 1 % of surplus → protocol
    // impactFee = IMPACT_FEE_BPS × N × (2·OI + N) / (2 × backedAirUsd × BPS_DENOM),
    // all to the LP. Integrating over OI makes it split-proof.
    uint256 private constant IMPACT_FEE_BPS   = 1500;

    /// @notice Swap fee in bps, on every AMM mode.
    uint256 public constant swapFeeBps = 100;   // 1 %

    // Per-position cap as a share of backedAirUsd, ramping linearly over the first day.
    uint256 private constant CAP_START_BPS     = 100;    // 1 % of backedAirUsd
    uint256 private constant CAP_MAX_BPS       = 2_000;  // 20 % of backedAirUsd
    uint256 private constant CAP_RAMP_DURATION = 24 hours;

    // Funding: every second a side shrinks by a fraction — collateral, debt and
    // notional together. Released collateral goes to the backed reserve and the
    // matching debt is burned. A fraction of what exists cannot create bad debt, so
    // there are no liquidations, and one index per side prices every position.
    //   ratePerWindow = FUNDING_BASE_BPS + FUNDING_UTIL_BPS × min(OI / backedAirUsd, cap)
    //   window        = min(FUNDING_WINDOW_MIN + age, FUNDING_WINDOW_MAX)
    uint256 private constant RAY = 1e27;
    uint256 private constant FUNDING_BASE_BPS = 1_000; // 10 % of the position / window
    uint256 private constant FUNDING_UTIL_BPS = 2_000; // + 20 % x utilization / window
    // Keeps the per-second rate far below RAY, so RAY - rate stays positive.
    uint256 private constant FUNDING_UTIL_CAP_BPS = 4 * BPS_DENOM; // 4x utilization
    uint256 private constant FUNDING_WINDOW_MIN = 1 hours;
    uint256 private constant FUNDING_WINDOW_MAX = 30 days;

    // Wind-down: closePool blocks opens; past closeDate the funding rate doubles
    // every WIND_DOWN_DOUBLING until positions are closed or decay to sweepable dust.
    uint256 private constant WIND_DOWN_GRACE     = 7 days;
    uint256 private constant WIND_DOWN_DOUBLING  = 1 days;
    uint256 private constant WIND_DOWN_MAX_SHIFT = 16; // overflow bound

    // Opens are refused below this, where index truncation stops being a rounding
    // error. RAY / 1e9: about seventeen years of base-rate decay without a rebase.
    uint256 private constant MIN_FUNDING_INDEX = 1e18;

    // sweepDust threshold, measured on collateral, which only funding moves.
    uint256 private constant SWEEP_DUST_BPS = 10; // 0.1 % of opening collateral

    // Close payouts are clamped to the worst of this many recent block opens.
    uint256 private constant CLAMP_BLOCKS = 5;

    // ── Immutables ────────────────────────────────────────────────────────────

    uint8 public immutable tokenDecimals;
    IERC20 public immutable underlyingToken;
    IERC20 public immutable underlyingUsdc;
    IPositionNFT public immutable positionNFT;
    ILpNFT public immutable lpNftContract;
    /// @notice LP NFT whose owner controls this pool.
    uint256 public immutable lpNftId;
    address public immutable protocolTreasury;
    /// @notice Creation time; anchors the position-cap ramp and the funding window.
    uint256 public immutable createdAt;
    /// @notice The factory that created this pool. It holds no authority over it.
    address public immutable factory;

    // ── State ─────────────────────────────────────────────────────────────────

    /// @notice All airToken: backed + long collateral + short debt. SWAP-3 reserve.
    uint256 public airTokenSupply;
    /// @notice All airUsd: backed + short collateral + long debt. SWAP-2 reserve.
    uint256 public airUsdSupply;
    /// @notice LP-owned airToken, backed 1:1 by underlying tokens.
    uint256 public backedAirToken;
    /// @notice LP-owned airUsd, backed 1:1 by USDC.
    uint256 public backedAirUsd;

    /// @notice Unclaimed LP fees (USDC), pulled via claimFees.
    uint256 public lpFeesAccumulated;
    /// @notice Unclaimed protocol fees (USDC), pulled via claimProtocolFees.
    uint256 public protocolFeesAccumulated;
    uint256 public lpFeesPaidTotal;
    uint256 public protocolFeesPaidTotal;

    /// @notice USDC credited by sweepDust, pulled via claimPayout.
    mapping(address => uint256) public claimable;
    uint256 public totalClaimable;

    uint256 public openPositionCount;

    /// @notice Live USDC notional of all longs, which is also their airUsd debt.
    ///         As of the last accrual.
    uint256 public longOpenInterest;
    /// @notice Live USDC notional of all shorts. As of the last accrual.
    uint256 public shortOpenInterest;

    /// @notice 0 while open; otherwise the end of the wind-down grace period.
    uint256 public closeDate;

    /// @notice USDC locked against open shorts (outside backedAirUsd).
    uint256 public totalShortCollateral;
    /// @notice Underlying locked against open longs (outside backedAirToken).
    uint256 public totalLongCollateral;

    /// @notice Long funding index in RAY; starts at RAY and only falls.
    ///         Live amount = atOpen × index / fundingIndexAtOpen.
    uint256 public fundingIndexLong = RAY;
    uint256 public fundingIndexShort = RAY;

    /// @notice Time long funding is charged through. Not advanced when a release
    ///         rounds to zero, so that time is carried rather than forgiven; an
    ///         open on the side resets it.
    uint256 public lastFundingLong;
    uint256 public lastFundingShort;

    /// @dev Reserves and funding indices as a block opened. `timestamp` lets the
    ///      clamp skip snapshots older than a position; the indices size the
    ///      position as of the snapshot.
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

    /// @dev Opens of the last CLAMP_BLOCKS mutated blocks; head is the newest.
    PriceSnapshot[CLAMP_BLOCKS] private priceRing;
    uint256 private priceRingHead;

    /// @notice Live airToken debt of all open shorts.
    uint256 public totalShortDebt;

    // ── Errors ────────────────────────────────────────────────────────────────

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
    error OnlyTreasury();
    error PositionNotDust();
    error FundingIndexExhausted();

    // ── Events ────────────────────────────────────────────────────────────────

    /// @notice Spot swap (SWAP-1) with the backed reserves after it. Leveraged
    ///         opens and closes do not emit this.
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
    event PositionSwept(uint256 indexed nftId, address indexed caller, uint256 payout);

    /// @notice Funding charged to one side. Funding lands in reserves, not fees,
    ///         so this is the only record separating it from trading growth.
    /// @param released      Collateral moved to the backed reserve (airToken long / airUsd short).
    /// @param debtCancelled Synthetic debt burned (airUsd long / airToken short).
    /// @param newIndex      The side's funding index after accrual, in RAY.
    /// @param elapsed       Seconds covered.
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

    /// @dev Direct owner only; approved operators are excluded.
    modifier onlyLpHolder() {
        if (lpNftContract.ownerOf(lpNftId) != msg.sender) revert OnlyLpHolder();
        _;
    }

    /// @dev Wraps every backed-reserve mutation: accrue funding, snapshot the
    ///      block open, run, then assert solvency.
    modifier reserveMutation() {
        _accrueFunding();
        _priceRingSnapshot();
        _;
        _assertReserveInvariant();
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    /// @notice Start the irreversible wind-down: blocks new opens and sets
    ///         closeDate = now + WIND_DOWN_GRACE. LP holder only, so a pool whose
    ///         LP NFT is locked in a LockedLpVault can never be closed.
    function closePool() external nonReentrant onlyLpHolder {
        if (closeDate != 0) revert PoolAlreadyClosed();

        // Charge time already elapsed before closeDate exists.
        _accrueFunding();

        closeDate = block.timestamp + WIND_DOWN_GRACE;

        emit PoolClosed(msg.sender, closeDate);
    }

    // ── Constructor ───────────────────────────────────────────────────────────

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
        factory          = factory_;

        lastFundingLong  = block.timestamp;
        lastFundingShort = block.timestamp;
    }

    // ── Swap ──────────────────────────────────────────────────────────────────

    /// @notice Spot swap (SWAP-1). The fee stays in the backed reserves.
    /// @param tokenToUsdc true = token → USDC, false = USDC → token.
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

        emit Swap(
            msg.sender, recipient, tokenToUsdc, amountIn, amountOut, backedAirToken, backedAirUsd
        );
    }

    // ── Longs ─────────────────────────────────────────────────────────────────

    /// @notice Open a long of `usdcAmount` notional. Only the fee is pulled: the
    ///         notional is minted as airUsd debt and buys locked airToken via SWAP-2.
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

        // Impact fee is priced on open interest before this position.
        (uint256 totalFee, uint256 protocolFee, uint256 lpFee) =
            _openFees(usdcAmount, longOpenInterest);

        // SWAP-2 against airUsdSupply before the synthetic mint, clamped.
        uint256 airTokenOut = _openLongOut(usdcAmount, block.number);

        if (airTokenOut == 0) revert ZeroAmount();
        if (airTokenOut < minAirTokenOut) revert InsufficientOutput();
        if (airTokenOut > backedAirToken) revert InsufficientBackedReserves();

        uint256 openIndex = _settleCarriedFunding(true);
        // Too little resolution left to size this position as it decays.
        if (openIndex < MIN_FUNDING_INDEX) revert FundingIndexExhausted();

        openPositionCount++;
        longOpenInterest += usdcAmount;
        airUsdSupply += usdcAmount;
        backedAirToken -= airTokenOut;
        totalLongCollateral += airTokenOut;

        _transferIn(underlyingUsdc, msg.sender, totalFee);
        _accrueProtocolFee(protocolFee);
        _accrueLpFee(lpFee);

        uint256 nftId = positionNFT.mintLong(
            recipient,
            address(this),
            usdcAmount,   // usdcIn
            usdcAmount,   // airUsdMinted
            airTokenOut,   // airTokenLocked
            totalFee,
            openIndex
        );

        emit PositionOpened(nftId, recipient, true);
    }

    /// @notice Close a long in profit; the net surplus goes to `to`.
    function closeLong(uint256 nftId, uint256 minUsdcOut, address to) external nonReentrant {
        address holder = positionNFT.ownerOf(nftId);
        if (holder != msg.sender) revert OnlyPositionHolder();
        if (to == address(0)) revert ZeroAddress();

        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();
        if (!pos.isLong) revert PositionNotLong();

        _settle(nftId, pos, holder, to, minUsdcOut, false);
    }

    // ── Shorts ────────────────────────────────────────────────────────────────

    /// @notice Open a short of `usdcNotional`. Only the fee is pulled: airToken
    ///         worth the notional is minted as debt and sold for locked airUsd via SWAP-3.
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

        // Impact fee is priced on open interest before this position.
        (uint256 totalFee, uint256 protocolFee, uint256 lpFee) =
            _openFees(usdcNotional, shortOpenInterest);

        if (airTokenSupply == 0) revert InsufficientBackedReserves();

        // Debt worth usdcNotional at shortPrice, sold via SWAP-3 before the mint; clamped.
        (uint256 airTokenMinted, uint256 airUsdOut) = _openShortTerms(usdcNotional, block.number);
        if (airTokenMinted == 0) revert ZeroAmount();

        if (airUsdOut == 0) revert ZeroAmount();
        if (airUsdOut < minAirUsdOut) revert InsufficientOutput();
        if (airUsdOut > backedAirUsd) revert InsufficientBackedReserves();

        uint256 openIndex = _settleCarriedFunding(false);
        // Too little resolution left to size this position as it decays.
        if (openIndex < MIN_FUNDING_INDEX) revert FundingIndexExhausted();

        openPositionCount++;
        shortOpenInterest += usdcNotional;
        airTokenSupply += airTokenMinted;
        totalShortDebt += airTokenMinted;
        backedAirUsd -= airUsdOut;
        totalShortCollateral += airUsdOut;

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
            openIndex
        );

        emit PositionOpened(nftId, recipient, false);
    }

    /// @notice Close a short in profit; the net surplus goes to `to`.
    function closeShort(uint256 nftId, uint256 minUsdcOut, address to) external nonReentrant {
        address holder = positionNFT.ownerOf(nftId);
        if (holder != msg.sender) revert OnlyPositionHolder();
        if (to == address(0)) revert ZeroAddress();

        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();
        if (pos.isLong) revert PositionNotShort();

        _settle(nftId, pos, holder, to, minUsdcOut, false);
    }

    // ── Liquidity ─────────────────────────────────────────────────────────────

    /// @notice Add liquidity at the current reserve ratio (±0.01 %). LP NFT owner only.
    function addLiquidity(uint256 tokenAmount, uint256 usdcAmount) external nonReentrant onlyLpHolder reserveMutation {
        if (tokenAmount == 0 || usdcAmount == 0) revert ZeroAmount();

        if (backedAirToken != 0 && backedAirUsd != 0) {
            uint256 lhs       = tokenAmount * backedAirUsd;
            uint256 rhs       = usdcAmount * backedAirToken;
            uint256 tolerance = (lhs > rhs ? lhs : rhs) / 10_000 + 1;
            if (lhs > rhs + tolerance || rhs > lhs + tolerance) revert RatioMismatch();
        }

        airTokenSupply += tokenAmount;
        airUsdSupply   += usdcAmount;
        backedAirToken += tokenAmount;
        backedAirUsd  += usdcAmount;

        _transferIn(underlyingToken, msg.sender, tokenAmount);
        _transferIn(underlyingUsdc, msg.sender, usdcAmount);
    }

    /// @notice Withdraw all backed reserves. Requires no open positions.
    function removeLiquidity() external nonReentrant onlyLpHolder reserveMutation {
        if (openPositionCount != 0) revert OpenPositionsExist();
        if (backedAirToken == 0 && backedAirUsd == 0) revert ZeroLiquidity();

        uint256 tokenOut = backedAirToken;
        uint256 usdcOut = backedAirUsd;

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

    /// @notice Send all accrued LP fees to `to`.
    function claimFees(address to) external nonReentrant onlyLpHolder {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = lpFeesAccumulated;
        if (amount == 0) revert ZeroAmount();

        lpFeesAccumulated = 0;
        lpFeesPaidTotal += amount;

        underlyingUsdc.safeTransfer(to, amount);
        // USDC only: fails here rather than freezing the next reserve mutation.
        _assertUsdcCovered();
        emit LpFeesPaid(to, amount);
    }

    /// @notice Send all accrued protocol fees to `to`. Treasury only.
    function claimProtocolFees(address to) external nonReentrant {
        if (msg.sender != protocolTreasury) revert OnlyTreasury();
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = protocolFeesAccumulated;
        if (amount == 0) revert ZeroAmount();

        protocolFeesAccumulated = 0;
        protocolFeesPaidTotal += amount;

        underlyingUsdc.safeTransfer(to, amount);
        // USDC only: fails here rather than freezing the next reserve mutation.
        _assertUsdcCovered();
        emit ProtocolFeesPaid(to, amount);
    }

    /// @notice Send the caller's sweep-credited payouts to `to`.
    function claimPayout(address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert ZeroAmount();

        claimable[msg.sender] = 0;
        totalClaimable -= amount;

        underlyingUsdc.safeTransfer(to, amount);
        // USDC only: fails here rather than freezing the next reserve mutation.
        _assertUsdcCovered();
        emit PayoutClaimed(msg.sender, to, amount);
    }

    // ── Dust sweep ────────────────────────────────────────────────────────────

    /// @notice Release a position whose collateral has decayed to SWEEP_DUST_BPS
    ///         of its opening amount. Anyone may call; any residual payout is
    ///         credited to the holder.
    function sweepDust(uint256 nftId) external nonReentrant {
        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();

        // Accrue first, so a position that only just became dust is sweepable.
        _accrueFunding();

        // Collateral, not claim: only funding moves it, so no price push can fake dust.
        uint256 live = effectiveLocked(pos);
        if (live * BPS_DENOM > pos.lockedAmountAtOpen * SWEEP_DUST_BPS) {
            revert PositionNotDust();
        }

        address holder = positionNFT.ownerOf(nftId);
        _settle(nftId, pos, holder, holder, 0, true);
    }

    /// @notice sweepDust over a list. Entries that are gone, from another pool or
    ///         not yet dust are skipped, not reverted, so a race does not cost the batch.
    /// @return swept How many positions were released.
    function sweepDustBatch(uint256[] calldata nftIds)
        external
        nonReentrant
        returns (uint256 swept)
    {
        // Once, not per entry; _settle accrues again through reserveMutation.
        _accrueFunding();

        for (uint256 i = 0; i < nftIds.length; i++) {
            uint256 nftId = nftIds[i];

            Position memory pos;
            try positionNFT.getPosition(nftId) returns (Position memory p) {
                pos = p;
            } catch {
                continue; // already released, or never existed
            }
            if (pos.pool != address(this)) continue;
            if (effectiveLocked(pos) * BPS_DENOM > pos.lockedAmountAtOpen * SWEEP_DUST_BPS) {
                continue;
            }

            address holder = positionNFT.ownerOf(nftId);
            _settle(nftId, pos, holder, holder, 0, true);
            swept++;
        }
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /// @notice USDC (6 dec) per whole token, from the backed reserves.
    function spotPrice() external view returns (uint256) {
        if (backedAirToken == 0) return 0;
        return (backedAirUsd * (10 ** uint256(tokenDecimals))) / backedAirToken;
    }

    /// @notice Long entry price (SWAP-2 marginal): airUsdSupply / backedAirToken.
    function longPrice() external view returns (uint256) {
        return _longPrice();
    }

    function _longPrice() internal view returns (uint256) {
        if (backedAirToken == 0) return 0;
        return (airUsdSupply * (10 ** uint256(tokenDecimals))) / backedAirToken;
    }

    /// @notice Short entry price (SWAP-3 marginal): backedAirUsd / airTokenSupply.
    function shortPrice() external view returns (uint256) {
        return _shortPrice();
    }

    function _shortPrice() internal view returns (uint256) {
        if (airTokenSupply == 0) return 0;
        return (backedAirUsd * (10 ** uint256(tokenDecimals))) / airTokenSupply;
    }

    /// @notice Indexer state in one call. Fees are lifetime totals (accrued + paid,
    ///         so monotonic); funding indices and rates are projected to now.
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

        (fundingIndexLong_,,,)  = _projectFunding(true);
        (fundingIndexShort_,,,) = _projectFunding(false);
        fundingRateLong_  = _liveRatePerSecond(true);
        fundingRateShort_ = _liveRatePerSecond(false);
    }

    /// @notice Per-position cap in bps of backedAirUsd: 1 % at creation, 20 % after 24 h.
    function currentMaxPositionBps() public view returns (uint256) {
        uint256 elapsed = block.timestamp - createdAt;
        if (elapsed >= CAP_RAMP_DURATION) return CAP_MAX_BPS;
        return CAP_START_BPS
             + ((CAP_MAX_BPS - CAP_START_BPS) * elapsed) / CAP_RAMP_DURATION;
    }

    /// @notice Per-position notional cap in USDC (6 dec) right now.
    function effectiveLeverageCap() external view returns (uint256) {
        return (backedAirUsd * currentMaxPositionBps()) / BPS_DENOM;
    }

    function isClosing() external view returns (bool) {
        return closeDate != 0;
    }

    /// @notice Total USDC fee to open `notional` now. Router and UIs quote here.
    function quoteOpenFee(uint256 notional, bool isLong) external view returns (uint256 totalFee) {
        // Projected: the open accrues funding before pricing its impact fee.
        (totalFee,,) = _openFees(notional, _projectedOpenInterest(isLong));
    }

    /// @notice What an open of `notional` sent now locks, priced for the next block as
    ///         the entry clamp will price it: airToken for a long, airUsd for a short.
    ///         Unaccrued funding only improves an open, so this is a floor.
    /// @return locked Collateral the position would hold.
    /// @return debt   airUsd (long) or airToken (short) it would owe.
    function quoteOpen(uint256 notional, bool isLong)
        external
        view
        returns (uint256 locked, uint256 debt)
    {
        if (notional == 0 || backedAirToken == 0 || backedAirUsd == 0) return (0, 0);
        if (isLong) return (_openLongOut(notional, block.number + 1), notional);
        if (airTokenSupply == 0) return (0, 0);
        (debt, locked) = _openShortTerms(notional, block.number + 1);
    }

    /// @notice Close quote for display, clamped as a close sent now would be.
    /// @return ready False when the settlement math cannot price the position.
    /// @return pnl   Net payout when non-negative; otherwise the (estimated) shortfall.
    function quoteClose(uint256 nftId) external view returns (bool ready, int256 pnl) {
        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();

        // Priced for the next block: the earliest a close sent now can be mined,
        // and the clamp window it will face.
        (bool priceable, uint256 surplus, uint256 deficit,) =
            _priceCloseClamped(pos, block.number + 1);
        return _closeQuote(pos, priceable, surplus, deficit);
    }

    /// @notice quoteClose at live reserves, without the clamp. Where this is in
    ///         profit and quoteClose is not, a recent price move is holding the
    ///         close back and it clears within CLAMP_BLOCKS. Not what a close pays now.
    function quoteCloseUnclamped(uint256 nftId) external view returns (bool ready, int256 pnl) {
        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();

        (bool priceable, uint256 surplus, uint256 deficit,) = _priceClose(pos);
        return _closeQuote(pos, priceable, surplus, deficit);
    }

    function _closeQuote(Position memory pos, bool priceable, uint256 surplus, uint256 deficit)
        internal
        view
        returns (bool, int256)
    {
        if (!priceable) return (false, -int256(_quoteShortfall(pos)));
        if (deficit > 0) return (true, -int256(deficit));
        return (true, int256(surplus - (surplus * CLOSE_FEE_BPS) / BPS_DENOM));
    }

    /// @dev Display-only shortfall estimate for a position _priceClose cannot
    ///      price. Must never feed settlement.
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

    // ── Close-price ring ──────────────────────────────────────────────────────

    /// @dev Record this block's opening reserves and indices, once per block.
    ///      Runs after _accrueFunding so both describe the same instant.
    function _priceRingSnapshot() internal {
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

    /// @dev Whether a ring entry is a block open still within CLAMP_BLOCKS of
    ///      `asOfBlock` and taken while the pool had reserves.
    function _inWindow(PriceSnapshot storage e, uint256 asOfBlock) internal view returns (bool) {
        uint256 at = e.blockNumber;
        return at != 0 && at + CLAMP_BLOCKS > asOfBlock && e.backedUsd != 0;
    }

    /// @dev airToken a long of `notional` locks: the least of live reserves and every
    ///      block open in the window, so an open cannot be priced against a move made
    ///      in the same transaction. Mirrors the close clamp.
    function _openLongOut(uint256 notional, uint256 asOfBlock) internal view returns (uint256 out) {
        out = _cpAmountOut(notional, airUsdSupply, backedAirToken);
        for (uint256 i = 0; i < CLAMP_BLOCKS; i++) {
            PriceSnapshot storage e = priceRing[i];
            if (!_inWindow(e, asOfBlock)) continue;
            uint256 o = _cpAmountOut(notional, e.usdSupply, e.backedToken);
            if (o < out) out = o;
        }
    }

    /// @dev Debt and collateral of a short of `notional`: the most debt and the least
    ///      collateral across live reserves and every block open in the window.
    ///      Requires airTokenSupply and backedAirUsd non-zero.
    function _openShortTerms(uint256 notional, uint256 asOfBlock)
        internal
        view
        returns (uint256 debt, uint256 collateral)
    {
        debt = (notional * airTokenSupply) / backedAirUsd;
        collateral = _cpAmountOut(debt, airTokenSupply, backedAirUsd);
        for (uint256 i = 0; i < CLAMP_BLOCKS; i++) {
            PriceSnapshot storage e = priceRing[i];
            if (!_inWindow(e, asOfBlock)) continue;
            uint256 d = (notional * e.tokenSupply) / e.backedUsd;
            uint256 c = _cpAmountOut(d, e.tokenSupply, e.backedUsd);
            if (d > debt) debt = d;
            if (c < collateral) collateral = c;
        }
    }

    // ── Swap helpers ──────────────────────────────────────────────────────────

    /// @dev Token → USDC SWAP-1.
    function _swapTokenToUsdc(uint256 amountIn, uint256 minAmountOut, address recipient)
        internal
        reserveMutation
        returns (uint256 netOut)
    {
        netOut = _cpAmountOut(amountIn, backedAirToken, backedAirUsd);
        if (netOut == 0) revert InsufficientOutput();
        if (netOut < minAmountOut) revert InsufficientOutput();

        airTokenSupply += amountIn;
        airUsdSupply   -= netOut;
        backedAirToken += amountIn;
        backedAirUsd  -= netOut;

        _transferIn(underlyingToken, msg.sender, amountIn);
        underlyingUsdc.safeTransfer(recipient, netOut);
    }

    /// @dev USDC → token SWAP-1.
    function _swapUsdcToToken(uint256 amountIn, uint256 minAmountOut, address recipient)
        internal
        reserveMutation
        returns (uint256 netOut)
    {
        netOut = _cpAmountOut(amountIn, backedAirUsd, backedAirToken);
        if (netOut == 0) revert InsufficientOutput();
        if (netOut < minAmountOut) revert InsufficientOutput();

        airUsdSupply   += amountIn;
        airTokenSupply -= netOut;
        backedAirUsd  += amountIn;
        backedAirToken -= netOut;

        _transferIn(underlyingUsdc, msg.sender, amountIn);
        underlyingToken.safeTransfer(recipient, netOut);
    }

    // ── Settlement ────────────────────────────────────────────────────────────

    /// @dev Live close valuation.
    ///      Long:  sell the locked airToken via SWAP-3, compare with the airUsd debt.
    ///      Short: airUsd cost (rounded up) to buy back the airToken debt via SWAP-2;
    ///             `restore` is that cost.
    ///      Not priceable ⇒ underwater.
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

    /// @dev _priceClose against arbitrary reserves. `locked` and `debt` must be at
    ///      the same funding index.
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

        // Locked airUsd is out of circulation, like the long's locked airToken.
        if (usdSupply < locked) return (false, 0, 0, 0);
        uint256 totalBuyable = _cpAmountOut(
            locked,
            usdSupply - locked,
            backedToken
        );
        if (totalBuyable == 0 || totalBuyable < debt) return (false, 0, 0, 0);
        // `locked` is a valid upper bound: it buys totalBuyable, which covers debt.
        uint256 cost = _buybackCost(debt, usdSupply - locked, backedToken, locked);
        if (locked >= cost) {
            return (true, locked - cost, 0, cost);
        }
        return (true, 0, cost - locked, cost);
    }

    /// @dev Live valuation clamped to the worst valuation at any block open still
    ///      within CLAMP_BLOCKS of `asOfBlock`, so a holder cannot close against a
    ///      price they just moved. One-way: a reference above live would pay out
    ///      more than the curve supports. Entries age out by block number, so an
    ///      idle pool prices live.
    /// @param asOfBlock block.number for settlement; block.number + 1 for quotes.
    function _priceCloseClamped(Position memory pos, uint256 asOfBlock)
        internal
        view
        returns (bool priceable, uint256 surplus, uint256 deficit, uint256 restore)
    {
        (priceable, surplus, deficit, restore) = _priceClose(pos);

        for (uint256 i = 0; i < CLAMP_BLOCKS; i++) {
            PriceSnapshot storage e = priceRing[i];
            if (!_inWindow(e, asOfBlock)) continue;

            // Older than the position's own block. The open block's snapshot is kept:
            // without it a position opened in this transaction has no reference at all.
            if (e.timestamp < pos.openedAt) continue;

            // Sized at the snapshot's index; one from the open block at opening size,
            // since a flush earlier in that block may have rebased the index.
            (uint256 lockedThen, uint256 debtThen,) = _liveAt(
                pos,
                e.timestamp == pos.openedAt
                    ? pos.fundingIndexAtOpen
                    : (pos.isLong ? e.fundingLong : e.fundingShort)
            );
            (bool p, uint256 s, uint256 d, uint256 r) = _priceCloseAt(
                pos.isLong,
                lockedThen,
                debtThen,
                e.tokenSupply,
                e.backedUsd,
                e.usdSupply,
                e.backedToken
            );

            // Underwater at any open in the window wins outright.
            if (!p || d > 0) return (p, 0, d, r);

            // Keep surplus and restore from the same valuation.
            if (s < surplus) {
                surplus = s;
                restore = r;
            }
        }
    }

    /// @dev Clamped pricing for a close in this block.
    function _priceCloseSettlement(Position memory pos)
        internal
        view
        returns (bool priceable, uint256 surplus, uint256 deficit, uint256 restore)
    {
        return _priceCloseClamped(pos, block.number);
    }

    /// @dev Shared close path.
    ///      Voluntary: reverts if underwater; pushes the net surplus to `payTo`.
    ///      Sweep: underwater returns collateral to the LP and cancels the debt;
    ///      a surplus is credited to the holder as a pull payment.
    function _settle(
        uint256 nftId,
        Position memory pos,
        address holder,
        address payTo,
        uint256 minPayout,
        bool isSweep
    ) internal reserveMutation {
        (bool priceable, uint256 surplus, uint256 deficit,) =
            _priceCloseSettlement(pos);
        bool underwater = !priceable || deficit > 0;

        if (!isSweep && underwater) revert PositionUnderwater();

        // Final, not projected: reserveMutation has already accrued.
        (uint256 locked, uint256 debt, uint256 notional) = _live(pos);

        openPositionCount--;
        if (pos.isLong) {
            longOpenInterest -= debt; // a long's notional IS its debt
        } else {
            shortOpenInterest -= notional;
            totalShortDebt    -= debt;
        }

        if (underwater) {
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
                // From today's `locked`, not the valuation's restore: a clamped
                // valuation may be sized at an older, larger collateral.
                backedAirUsd   += locked - surplus;
                airTokenSupply -= debt;
                airUsdSupply   -= surplus;
                totalShortCollateral -= locked;
            }
            _flushResidue();
            _accrueProtocolFee(closeFee);

            positionNFT.release(nftId);
            if (isSweep) {
                _creditPayout(holder, netSurplus);
                emit PositionSwept(nftId, msg.sender, netSurplus);
            } else {
                underlyingUsdc.safeTransfer(payTo, netSurplus);
                emit PositionClosed(nftId, holder, netSurplus);
            }
        }
    }

    // ── Funding ───────────────────────────────────────────────────────────────

    /// @notice Accrue funding to now without trading. Permissionless.
    function pokeFunding() external nonReentrant reserveMutation {}

    /// @dev Charge both sides: released collateral moves to the backed reserve and
    ///      the matching debt and open interest are burned. A release that rounds
    ///      to zero leaves the clock alone, carrying the time to the next accrual.
    function _accrueFunding() internal {
        (uint256 idxL, uint256 factorL, uint256 elapsedL,) = _projectFunding(true);
        if (factorL != RAY) {
            uint256 relColl = _released(totalLongCollateral, factorL);
            // A long's notional is its airUsd debt: one release covers both.
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

        (uint256 idxS, uint256 factorS, uint256 elapsedS,) = _projectFunding(false);
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

    /// @dev Before a position joins a side, charge any carried interval to the
    ///      side's index and restart the clock, so the joiner is not billed for it
    ///      and the side is not let off it. _flushResidue hands the LP the residue.
    /// @return The index the opening position should carry.
    function _settleCarriedFunding(bool isLong) internal returns (uint256) {
        (,,, uint256 openIndex) = _projectFunding(isLong);
        if (isLong) {
            fundingIndexLong = openIndex;
            lastFundingLong  = block.timestamp;
        } else {
            fundingIndexShort = openIndex;
            lastFundingShort  = block.timestamp;
        }
        return openIndex;
    }

    /// @dev What _accrueFunding would do to one side now. Shared by execution and views.
    /// @return newIndex The side's index after accrual (unchanged if nothing is charged).
    /// @return factor   Fraction kept, in RAY; exactly RAY when nothing is charged.
    /// @return elapsed  Seconds since the side was last charged.
    /// @return openIndex Index a position opening now carries: decayed by the whole
    ///                   unaccrued interval even when the aggregate has yet to move.
    function _projectFunding(bool isLong)
        internal
        view
        returns (uint256 newIndex, uint256 factor, uint256 elapsed, uint256 openIndex)
    {
        uint256 last   = isLong ? lastFundingLong     : lastFundingShort;
        uint256 locked = isLong ? totalLongCollateral : totalShortCollateral;
        newIndex       = isLong ? fundingIndexLong    : fundingIndexShort;
        factor         = RAY;
        openIndex      = newIndex;

        if (block.timestamp <= last) return (newIndex, RAY, 0, openIndex);
        elapsed = block.timestamp - last;

        // No collateral to charge, or no depth to measure utilization against.
        if (locked == 0 || backedAirUsd == 0) return (newIndex, RAY, elapsed, openIndex);

        // Rate at the midpoint window; _weightedElapsed integrates the window and
        // wind-down across the interval.
        uint256 midpoint = last + elapsed / 2;
        uint256 window   = _fundingWindowAt(midpoint);
        uint256 oi       = isLong ? longOpenInterest : shortOpenInterest;
        uint256 rate     = _ratePerSecond(oi, midpoint);
        if (rate == 0) return (newIndex, RAY, elapsed, openIndex);

        uint256 f = _decayFactor(
            rate, oi, window, _weightedElapsed(last, block.timestamp, window)
        );

        // What the interval is worth, whoever ends up charged for it.
        openIndex = Math.mulDiv(newIndex, f, RAY);

        // Move the shared index only if the aggregate moves, or holders pay what
        // the LP never receives. The clock keeps the interval either way.
        if (_released(locked, f) == 0) return (newIndex, RAY, elapsed, openIndex);
        newIndex = openIndex;
        factor   = f;
    }

    /// @dev Fraction of a side kept over `weighted` seconds, in RAY. Utilization
    ///      falls as funding shrinks its own open interest; with base rate a and
    ///      utilization term b, the closed form is
    ///        q = (1 − a)^t,  kept = a·q / (a + b·(1 − q))
    ///      which composes across accruals for longs. Short funding deepens
    ///      backedAirUsd, which this holds fixed, so one accrual over a long
    ///      interval overcharges shorts slightly. At or above the utilization cap
    ///      the full rate is held.
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

    /// @dev Amount released by decaying `amount` by `factor`. Rounds the kept amount
    ///      UP, opposite to _liveAt, so aggregates stay ahead of the positions that
    ///      settlement subtracts from them. mulDiv cannot overflow at any reserve size.
    function _released(uint256 amount, uint256 factor) internal pure returns (uint256) {
        uint256 kept = Math.mulDiv(amount, factor, RAY, Math.Rounding.Ceil);
        if (kept > amount) kept = amount; // rounding only
        return amount - kept;
    }

    /// @dev A side's open interest net of unaccrued funding.
    function _projectedOpenInterest(bool isLong) internal view returns (uint256) {
        (, uint256 factor,,) = _projectFunding(isLong);
        uint256 oi = isLong ? longOpenInterest : shortOpenInterest;
        return oi - _released(oi, factor);
    }

    /// @notice Current funding rate for a side in RAY per second, wind-down included.
    ///         × 86400 / 1e25 = % per day.
    function fundingRatePerSecond(bool isLong) external view returns (uint256) {
        return _liveRatePerSecond(isLong);
    }

    /// @dev The rate charged now: projected open interest, wind-down shift applied,
    ///      capped. Every public rate read goes through this.
    function _liveRatePerSecond(bool isLong) internal view returns (uint256) {
        if (backedAirUsd == 0) return 0;
        uint256 rate = _ratePerSecond(_projectedOpenInterest(isLong), block.timestamp);
        uint256 shift = _windDownShift(block.timestamp);
        if (shift != 0) rate <<= shift;
        uint256 ceiling = RAY / 2;
        return rate > ceiling ? ceiling : rate;
    }

    /// @dev Per-second rate in RAY for `oi` at `atTs`, without the wind-down
    ///      multiplier (_weightedElapsed applies it). Requires backedAirUsd != 0.
    function _ratePerSecond(uint256 oi, uint256 atTs) internal view returns (uint256) {
        uint256 util = (oi * BPS_DENOM) / backedAirUsd;
        if (util > FUNDING_UTIL_CAP_BPS) util = FUNDING_UTIL_CAP_BPS;

        uint256 perWindow = FUNDING_BASE_BPS + (FUNDING_UTIL_BPS * util) / BPS_DENOM;

        // Worst case is ~2.5e-4 per second; the ceiling keeps RAY - rate positive regardless.
        uint256 rate    = (perWindow * RAY) / (BPS_DENOM * _fundingWindowAt(atTs));
        uint256 ceiling = RAY / 2;
        return rate > ceiling ? ceiling : rate;
    }

    // Bound on _weightedElapsed pieces: ~10 window doublings plus wind-down steps.
    uint256 private constant _MAX_INTEGRATION_STEPS = 32;

    /// @dev Seconds in [from, to], each weighted by windowRef / window(t) and the
    ///      wind-down 2^shift, so (RAY − rate)^weighted is the compounded charge.
    ///      Split at every window doubling and wind-down step; Simpson's rule
    ///      within each piece.
    /// @param windowRef The window the caller's rate was evaluated at.
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

        // Unreachable in practice; charge any remainder rather than drop it.
        if (t < to) {
            weighted += _simpson(t, to, windowRef) << _windDownShift(t);
        }
    }

    /// @dev Next wind-down step or window doubling after `t`, capped at `to`.
    function _nextIntegrationBoundary(uint256 t, uint256 to) internal view returns (uint256) {
        uint256 next = to;

        if (closeDate != 0 && t >= closeDate) {
            uint256 shift = (t - closeDate) / WIND_DOWN_DOUBLING;
            if (shift < WIND_DOWN_MAX_SHIFT) {
                uint256 stepEnd = closeDate + (shift + 1) * WIND_DOWN_DOUBLING;
                if (stepEnd < next) next = stepEnd;
            }
        } else if (closeDate != 0 && closeDate < next) {
            next = closeDate;
        }

        uint256 w = _fundingWindowAt(t);
        if (w < FUNDING_WINDOW_MAX) {
            uint256 target = 2 * w;
            if (target > FUNDING_WINDOW_MAX) target = FUNDING_WINDOW_MAX;
            // window(t) = FUNDING_WINDOW_MIN + (t - createdAt)
            uint256 at = createdAt + target - FUNDING_WINDOW_MIN;
            if (at > t && at < next) next = at;
        }

        return next;
    }

    /// @dev Simpson's rule for ∫ windowRef / window(t) dt over [a, b]:
    ///        (b - a) / 6 · windowRef · (1/w(a) + 4/w(mid) + 1/w(b))
    ///      as one fraction, so no reciprocal truncates to zero.
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

    /// @notice Current funding window in seconds: 1 hour at creation, growing one
    ///         second per second, capped at 30 days.
    function fundingWindow() external view returns (uint256) {
        return _fundingWindowAt(block.timestamp);
    }

    function _fundingWindowAt(uint256 atTs) internal view returns (uint256) {
        uint256 age = atTs > createdAt ? atTs - createdAt : 0;
        uint256 w   = FUNDING_WINDOW_MIN + age;
        return w > FUNDING_WINDOW_MAX ? FUNDING_WINDOW_MAX : w;
    }

    /// @notice How many times the wind-down currently doubles the funding rate.
    function windDownShift() external view returns (uint256) {
        return _windDownShift(block.timestamp);
    }

    function _windDownShift(uint256 atTs) internal view returns (uint256) {
        if (closeDate == 0 || atTs <= closeDate) return 0;
        uint256 shift = (atTs - closeDate) / WIND_DOWN_DOUBLING;
        return shift > WIND_DOWN_MAX_SHIFT ? WIND_DOWN_MAX_SHIFT : shift;
    }

    /// @notice Live collateral of `nftId`, net of all funding including unaccrued.
    function effectiveLockedOf(uint256 nftId) external view returns (uint256) {
        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();
        return effectiveLocked(pos);
    }

    /// @notice Share of its opening size `nftId` still has, in bps (10000 = untouched).
    function remainingSizeBps(uint256 nftId) external view returns (uint256) {
        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();
        if (pos.lockedAmountAtOpen == 0) return 0;
        return (effectiveLocked(pos) * BPS_DENOM) / pos.lockedAmountAtOpen;
    }

    /// @notice Live collateral, debt (airUsd long / airToken short) and USDC notional
    ///         of `nftId`, net of all funding including unaccrued.
    function liveAmountsOf(uint256 nftId)
        external
        view
        returns (uint256 locked, uint256 debt, uint256 notional)
    {
        Position memory pos = positionNFT.getPosition(nftId);
        if (pos.pool != address(this)) revert PositionNotFromThisPool();
        return _live(pos);
    }

    /// @notice Live collateral of `pos`, net of all funding including unaccrued.
    function effectiveLocked(Position memory pos) public view returns (uint256 locked) {
        (locked,,) = _live(pos);
    }

    /// @dev `pos`'s live amounts at its side's projected funding index.
    function _live(Position memory pos) internal view returns (uint256, uint256, uint256) {
        (uint256 idx,,,) = _projectFunding(pos.isLong);
        return _liveAt(pos, idx);
    }

    /// @dev `pos`'s amounts at funding index `idx`, rounded down (see _released).
    ///      Nothing left to settle reads as spent, never as untouched, so sweepDust
    ///      can always clear the position.
    function _liveAt(Position memory pos, uint256 idx)
        internal
        pure
        returns (uint256 locked, uint256 debt, uint256 notional)
    {
        uint256 debtAtOpen = pos.isLong ? pos.airUsdMinted : pos.airTokenMinted;
        uint256 opened = pos.fundingIndexAtOpen;
        // Malformed: an index that reached zero before the mint.
        if (opened == 0) return (0, 0, 0);
        // Indices only fall.
        if (idx >= opened) {
            return (pos.lockedAmountAtOpen, debtAtOpen, pos.usdcIn);
        }
        debt = Math.mulDiv(debtAtOpen, idx, opened);
        // Collateral outlives the debt only by rounding, and a zero debt prices
        // the buyback at zero, so the holder would take the remainder untaxed.
        if (debt == 0) return (0, 0, 0);
        locked   = Math.mulDiv(pos.lockedAmountAtOpen, idx, opened);
        notional = Math.mulDiv(pos.usdcIn, idx, opened);
    }

    /// @dev x^n in RAY by binary exponentiation. x ≤ RAY, so x·x cannot overflow.
    function _rpow(uint256 x, uint256 n) internal pure returns (uint256 z) {
        z = n % 2 != 0 ? x : RAY;
        for (n /= 2; n != 0; n /= 2) {
            x = (x * x) / RAY;
            if (n % 2 != 0) z = (z * x) / RAY;
        }
    }

    /// @dev Once the last position is gone, clear rounding residue: collateral to
    ///      the LP reserves, debt and open interest burned, and the indices rebased
    ///      so a long-lived pool never decays them into the ground.
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

        // No position references the indices now, so the ratio they carry is dead.
        fundingIndexLong  = RAY;
        fundingIndexShort = RAY;
    }

    // ── AMM math ──────────────────────────────────────────────────────────────

    /// @dev Constant-product output minus a fee on the input's spot value:
    ///        rawOut = amountIn·Ro / (Ri + amountIn)
    ///        fee    = ⌈amountIn·Ro·swapFeeBps / (Ri·BPS_DENOM)⌉
    ///      Returns 0 when rawOut ≤ fee. The fee rounds up so dust swaps are never
    ///      free and settlement surpluses round against the holder.
    function _cpAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) internal pure returns (uint256) {
        if (reserveIn == 0 || reserveOut == 0) return 0;
        uint256 rawOut = (amountIn * reserveOut) / (reserveIn + amountIn);

        uint256 feeNum = amountIn * reserveOut * swapFeeBps;
        uint256 feeDen = reserveIn * BPS_DENOM;
        uint256 fee = feeNum == 0 ? 0 : (feeNum + feeDen - 1) / feeDen;

        if (rawOut <= fee) return 0;
        return rawOut - fee;
    }

    /// @dev Smallest input whose _cpAmountOut covers `debt`, by bisection. `hi` must
    ///      already cover `debt`; the search is sound because _cpAmountOut is monotonic.
    function _buybackCost(
        uint256 debt,
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 hi
    ) internal pure returns (uint256) {
        if (debt == 0) return 0;

        // Fee-free inverse of the curve: x·Ro/(Ri+x) = debt ⇒ x = debt·Ri/(Ro−debt).
        // The fee only raises the true cost, so this never overshoots it.
        uint256 lo = reserveOut > debt
            ? Math.mulDiv(debt, reserveIn, reserveOut - debt, Math.Rounding.Ceil)
            : 0;
        if (lo > hi) lo = 0;

        while (lo < hi) {
            uint256 mid = lo + (hi - lo) / 2;
            if (_cpAmountOut(mid, reserveIn, reserveOut) >= debt) hi = mid;
            else lo = mid + 1;
        }
        return lo;
    }

    // ── Fees ──────────────────────────────────────────────────────────────────

    /// @dev 5 % of notional (4 % LP, 1 % protocol), floored at MIN_POSITION_FEE.
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

    /// @dev Base fee plus the impact fee (all LP). Base only when backedAirUsd == 0.
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

    function _checkLeverageCap(uint256 usdcNotional) internal view {
        uint256 cap = (backedAirUsd * currentMaxPositionBps()) / BPS_DENOM;
        if (usdcNotional > cap) revert LeverageCapExceeded();
    }

    // ── Transfers and accrual ─────────────────────────────────────────────────

    /// @dev Pull exactly `amount`; reverts if less arrives. A balance that moves
    ///      later (rebase, seizure) is not caught, so such tokens are unsupported.
    function _transferIn(IERC20 token, address from, uint256 amount) internal {
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        if (token.balanceOf(address(this)) - balanceBefore != amount) {
            revert FeeOnTransferNotSupported();
        }
    }

    function _accrueLpFee(uint256 amount) internal {
        if (amount == 0) return;
        lpFeesAccumulated += amount;
    }

    function _accrueProtocolFee(uint256 amount) internal {
        if (amount == 0) return;
        protocolFeesAccumulated += amount;
    }

    /// @dev Pull-payment credit: a state write, so no recipient can block a sweep.
    function _creditPayout(address recipient, uint256 amount) internal {
        if (amount == 0) return;
        claimable[recipient] += amount;
        totalClaimable += amount;
        emit PayoutCredited(recipient, amount);
    }

    // ── Invariant ─────────────────────────────────────────────────────────────

    /// @dev Backed ≤ supply on each side, and real balances cover every liability:
    ///      backed reserves, locked collateral, unclaimed fees and credited payouts.
    function _assertReserveInvariant() internal view {
        if (backedAirToken > airTokenSupply) revert ReserveInvariantViolated();
        if (backedAirUsd  > airUsdSupply)  revert ReserveInvariantViolated();
        if (underlyingToken.balanceOf(address(this))
            < backedAirToken + totalLongCollateral) {
            revert ReserveInvariantViolated();
        }
        _assertUsdcCovered();
    }

    /// @dev The USDC balance covers every USDC liability. All a claim needs: it moves
    ///      nothing else, so a token-side shortfall must not lock USDC in.
    function _assertUsdcCovered() internal view {
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
