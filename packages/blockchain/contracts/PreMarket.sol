// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "./LockedLpVault.sol";

interface IEXNIHILOMarketFactory {
    function createMarket(
        address tokenAddress,
        uint256 usdcAmount,
        uint256 tokenAmount
    ) external returns (address pool, uint256 lpNftId);

    function lpNftContract() external view returns (address);

    function usdc() external view returns (address);
}

/**
 * @title  PreMarket
 * @notice Launches an EXNIHILO token/USDC market from a token paired with any
 *         ERC-20 quote, with no oracle. A token/quote AMM keeps the ratio current
 *         while a Dutch auction sells the whole quote reserve for USDC. The buyout
 *         seeds the real market with the token reserve and the USDC paid, and locks
 *         the LP NFT in a LockedLpVault. Seeding is irreversible.
 *         A USDC quote has nothing to auction and launches at seed time.
 */
contract PreMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Constants ─────────────────────────────────────────────────────────────

    uint256 private constant BPS_DENOM = 10_000;

    /// @notice AMM swap fee in bps, retained in the reserves.
    uint256 public constant swapFeeBps = 100;   // 1 %

    uint256 private constant INTEGRATOR_SHARE_BPS = 5_000; // integrator's half of LP fees

    // The auction price stops at startPrice × (1 − MAX_DISCOUNT). Flooring the price,
    // not the total, keeps the buyout cost strictly increasing in quoteReserve.
    uint256 private constant MAX_DISCOUNT_BPS = 1_000; // 10 %

    uint256 private constant MIN_SEED_USDC = 100_000_000; // 100 USDC

    // ── Types ─────────────────────────────────────────────────────────────────

    struct Config {
        address token;
        address quote;             // bonded asset; USDC launches directly
        address usdc;              // must equal the factory's usdc
        address factory;           // EXNIHILOFactory
        address creator;           // attribution only
        address lpOwner;           // claims the LP fee share
        address integrator;        // claims the integrator share; zero = none
        uint8   quoteDecimals;
        uint256 startPrice;        // USDC (6 dec) per whole quote unit; ignored for USDC
        uint256 decayBpsPerMinute; // bps of startPrice per minute; ignored for USDC
    }

    // ── Immutables ────────────────────────────────────────────────────────────

    IERC20  public immutable token;
    IERC20  public immutable quote;
    IERC20  public immutable usdc;
    IEXNIHILOMarketFactory public immutable factory;

    address public immutable creator;
    address public immutable lpOwner;
    address public immutable integrator;

    /// @notice Deployer (PreMarketFactory); sole caller of confirmFunded and launchDirect.
    address public immutable seeder;

    /// @notice True when quote is USDC: no auction, launched at seed time.
    bool public immutable directLaunch;

    /// @notice Set once the seeder has transferred both legs and balances are verified.
    bool public funded;

    /// @notice LockedLpVault holding the LP NFT. Zero until launched.
    address public lpVault;

    /// @notice 10 ** quoteDecimals.
    uint256 public immutable quoteUnit;

    uint256 public immutable startPrice;
    uint256 public immutable decayBpsPerMinute;
    uint256 public immutable startTime;

    // ── State ─────────────────────────────────────────────────────────────────

    uint256 public tokenReserve;
    uint256 public quoteReserve;

    /// @notice One-way; the AMM closes once the market has launched.
    bool public launched;

    address public launchedPool;

    /// @notice USDC that seeded the real market.
    uint256 public launchUsdc;

    // ── Errors ────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error AlreadyLaunched();
    error InvalidPriceRange();
    error InvalidDecayRate();
    error UsdcMismatch();
    error FeeOnTransferNotSupported();
    error SlippageExceeded();
    error ZeroOutput();
    error CostExceedsMax();
    error QuoteBelowMin();
    error BuyoutNotPriceable();
    error TokenIsUsdc();
    error TokenIsQuote();
    error SeedBelowMinimum();
    error NotFunded();
    error NoAuction();
    error NotDirectLaunch();
    error OnlySeeder();

    // ── Events ────────────────────────────────────────────────────────────────

    event Seeded(uint256 tokenAmount, uint256 quoteAmount, uint256 startPrice);

    event Swapped(
        address indexed sender,
        address indexed to,
        bool    tokenToQuote,
        uint256 amountIn,
        uint256 amountOut,
        uint256 tokenReserve,
        uint256 quoteReserve
    );

    /// @notice `usdcPaid` is authoritative; `price` is USDC per whole quote unit at fill.
    event BoughtOut(
        address indexed buyer,
        uint256 usdcPaid,
        uint256 quoteReceived,
        uint256 price
    );

    event Launched(
        address indexed pool,
        address indexed lpVault,
        uint256 lpNftId,
        uint256 tokenAmount,
        uint256 usdcAmount
    );

    // ── Constructor ───────────────────────────────────────────────────────────

    /// @dev Deployed, funded and confirmed in one transaction by PreMarketFactory.
    constructor(Config memory c, uint256 tokenAmount, uint256 quoteAmount) {
        if (c.token   == address(0)) revert ZeroAddress();
        if (c.quote   == address(0)) revert ZeroAddress();
        if (c.usdc    == address(0)) revert ZeroAddress();
        if (c.factory == address(0)) revert ZeroAddress();
        if (c.creator == address(0)) revert ZeroAddress();
        if (c.lpOwner == address(0)) revert ZeroAddress();

        if (tokenAmount == 0 || quoteAmount == 0) revert ZeroAmount();

        if (c.usdc != IEXNIHILOMarketFactory(c.factory).usdc()) revert UsdcMismatch();

        // Checked here because createMarket would otherwise revert every buyout,
        // and there is no refund path.
        if (c.token == c.usdc)  revert TokenIsUsdc();
        if (c.token == c.quote) revert TokenIsQuote();

        bool direct = c.quote == c.usdc;

        uint256 startPrice_;
        uint256 decay_;

        if (direct) {
            // Auction params are ignored and recorded as zero.
            if (quoteAmount < MIN_SEED_USDC) revert SeedBelowMinimum();
        } else {
            if (c.startPrice == 0) revert InvalidPriceRange();
            if (c.decayBpsPerMinute == 0 || c.decayBpsPerMinute > BPS_DENOM) revert InvalidDecayRate();

            // Seed value floor on the reserve itself, so it holds for any decimals.
            uint256 seededCost = (quoteAmount * c.startPrice) / (10 ** c.quoteDecimals);
            if (seededCost < MIN_SEED_USDC) revert InvalidPriceRange();

            startPrice_ = c.startPrice;
            decay_      = c.decayBpsPerMinute;
        }

        seeder       = msg.sender;
        directLaunch = direct;

        token       = IERC20(c.token);
        quote       = IERC20(c.quote);
        usdc        = IERC20(c.usdc);
        factory     = IEXNIHILOMarketFactory(c.factory);
        creator     = c.creator;
        lpOwner     = c.lpOwner;
        integrator  = c.integrator;

        quoteUnit         = 10 ** c.quoteDecimals;
        startPrice        = startPrice_;
        decayBpsPerMinute = decay_;
        startTime         = block.timestamp;

        tokenReserve = tokenAmount;
        quoteReserve = quoteAmount;

        emit Seeded(tokenAmount, quoteAmount, startPrice_);
    }

    // ── Auction ───────────────────────────────────────────────────────────────

    /// @notice Dutch price in USDC (6 dec) per whole quote unit: falls linearly by
    ///         decayBpsPerMinute per minute to MAX_DISCOUNT_BPS below startPrice, then
    ///         holds. 0 for a direct launch.
    function currentPrice() public view returns (uint256) {
        if (directLaunch) return 0;

        uint256 floorPrice = (startPrice * (BPS_DENOM - MAX_DISCOUNT_BPS)) / BPS_DENOM;

        // Past the floor the result is fixed; capping elapsed keeps the multiply
        // bounded on a premarket nobody buys.
        uint256 elapsedMax = (MAX_DISCOUNT_BPS * 60) / decayBpsPerMinute + 1;
        uint256 elapsed = block.timestamp - startTime;
        if (elapsed > elapsedMax) elapsed = elapsedMax;

        uint256 drop = (startPrice * decayBpsPerMinute * elapsed) / (BPS_DENOM * 60);
        uint256 price = drop >= startPrice ? 0 : startPrice - drop;

        return price < floorPrice ? floorPrice : price;
    }

    /// @notice USDC to buy the whole quote reserve now. Zero when the reserve prices
    ///         to nothing, where buyout reverts until quote is swapped in.
    function buyoutCost() external view returns (uint256 usdcCost, uint256 quoteOut) {
        quoteOut = quoteReserve;
        usdcCost = _buyoutCost(quoteOut, currentPrice());
    }

    function _buyoutCost(uint256 quoteOut, uint256 price) internal view returns (uint256) {
        return (quoteOut * price) / quoteUnit;
    }

    /// @notice Seeder only: verify both legs arrived and open the AMM.
    function confirmFunded() external {
        if (msg.sender != seeder) revert OnlySeeder();
        if (token.balanceOf(address(this)) < tokenReserve) revert NotFunded();
        if (quote.balanceOf(address(this)) < quoteReserve) revert NotFunded();
        funded = true;
    }

    // ── AMM ───────────────────────────────────────────────────────────────────

    /// @notice Uniswap V2-style constant product with the fee taken off the input.
    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) public pure returns (uint256) {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0) return 0;
        uint256 amountInWithFee = amountIn * (BPS_DENOM - swapFeeBps);
        return (amountInWithFee * reserveOut) / (reserveIn * BPS_DENOM + amountInWithFee);
    }

    /// @notice Swap against the premarket reserves until launch.
    /// @param tokenToQuote true = token in / quote out, false = the reverse.
    function swap(
        uint256 amountIn,
        uint256 minAmountOut,
        bool tokenToQuote,
        address to
    ) external nonReentrant returns (uint256 amountOut) {
        if (launched) revert AlreadyLaunched();
        if (directLaunch) revert NoAuction();
        if (!funded) revert NotFunded();
        if (amountIn == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        uint256 reserveIn  = tokenToQuote ? tokenReserve : quoteReserve;
        uint256 reserveOut = tokenToQuote ? quoteReserve : tokenReserve;

        amountOut = getAmountOut(amountIn, reserveIn, reserveOut);
        if (amountOut == 0) revert ZeroOutput();
        if (amountOut < minAmountOut) revert SlippageExceeded();

        if (tokenToQuote) {
            tokenReserve = reserveIn + amountIn;
            quoteReserve = reserveOut - amountOut;
        } else {
            quoteReserve = reserveIn + amountIn;
            tokenReserve = reserveOut - amountOut;
        }

        IERC20 assetIn  = tokenToQuote ? token : quote;
        IERC20 assetOut = tokenToQuote ? quote : token;

        _pullExact(assetIn, msg.sender, amountIn);
        assetOut.safeTransfer(to, amountOut);

        emit Swapped(
            msg.sender, to, tokenToQuote, amountIn, amountOut, tokenReserve, quoteReserve
        );
    }

    // ── Launch ────────────────────────────────────────────────────────────────

    /// @notice Pay currentPrice() × quoteReserve USDC for the whole quote reserve and
    ///         launch the market with that USDC and the token reserve.
    /// @param maxUsdc     Cost guard; quote swapped in raises the cost.
    /// @param minQuoteOut Guard against the reserve shrinking before execution.
    function buyout(
        uint256 maxUsdc,
        uint256 minQuoteOut
    ) external nonReentrant returns (address pool, uint256 lpNftId) {
        if (launched) revert AlreadyLaunched();
        if (directLaunch) revert NoAuction();
        if (!funded) revert NotFunded();

        uint256 quoteOut = quoteReserve;
        uint256 tokenOut = tokenReserve;

        uint256 price   = currentPrice();
        uint256 usdcIn  = _buyoutCost(quoteOut, price);

        // A drawn-down reserve can price to zero; any quote-in swap clears it.
        if (usdcIn == 0) revert BuyoutNotPriceable();

        if (usdcIn > maxUsdc) revert CostExceedsMax();
        if (quoteOut < minQuoteOut) revert QuoteBelowMin();

        launched     = true;
        tokenReserve = 0;
        quoteReserve = 0;
        launchUsdc   = usdcIn;

        _pullExact(usdc, msg.sender, usdcIn);
        quote.safeTransfer(msg.sender, quoteOut);

        emit BoughtOut(msg.sender, usdcIn, quoteOut, price);

        (pool, lpNftId) = _launch(tokenOut, usdcIn);
    }

    /// @notice Seeder only: launch a USDC-quoted premarket from its seeded reserves.
    function launchDirect() external nonReentrant returns (address pool, uint256 lpNftId) {
        if (!directLaunch) revert NotDirectLaunch();
        if (msg.sender != seeder) revert OnlySeeder();
        if (!funded) revert NotFunded();
        if (launched) revert AlreadyLaunched();

        uint256 usdcIn   = quoteReserve;
        uint256 tokenOut = tokenReserve;

        launched     = true;
        tokenReserve = 0;
        quoteReserve = 0;
        launchUsdc   = usdcIn;

        // quote is USDC, so the reserve already held is the market's USDC leg.
        (pool, lpNftId) = _launch(tokenOut, usdcIn);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    /// @dev Create the market and lock its LP NFT in a new LockedLpVault.
    ///      Callers must write all effects first.
    function _launch(
        uint256 tokenOut,
        uint256 usdcIn
    ) internal returns (address pool, uint256 lpNftId) {
        token.forceApprove(address(factory), tokenOut);
        usdc.forceApprove(address(factory), usdcIn);

        (pool, lpNftId) = factory.createMarket(
            address(token),
            usdcIn,
            tokenOut
        );

        token.forceApprove(address(factory), 0);
        usdc.forceApprove(address(factory), 0);

        launchedPool = pool;

        address lpNftAddr = factory.lpNftContract();
        LockedLpVault vault = new LockedLpVault(
            pool,
            lpNftAddr,
            lpNftId,
            lpOwner,
            integrator,
            integrator == address(0) ? 0 : INTEGRATOR_SHARE_BPS
        );
        lpVault = address(vault);

        // Plain transferFrom: no receiver hook needed.
        IERC721(lpNftAddr).transferFrom(address(this), lpVault, lpNftId);

        emit Launched(pool, lpVault, lpNftId, tokenOut, usdcIn);
    }

    /// @dev Pull exactly `amount`; rejects fee-on-transfer tokens.
    function _pullExact(IERC20 asset, address from, uint256 amount) internal {
        uint256 balanceBefore = asset.balanceOf(address(this));
        asset.safeTransferFrom(from, address(this), amount);
        if (asset.balanceOf(address(this)) - balanceBefore != amount) {
            revert FeeOnTransferNotSupported();
        }
    }
}
