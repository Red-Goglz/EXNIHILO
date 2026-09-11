// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "./LockedLpVault.sol";

/**
 * @dev Minimal interface to EXNIHILOFactory — only what PreMarket calls.
 */
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
 * @author EXNIHILO
 * @notice Bootstraps an EXNIHILO market from a token paired with an *arbitrary*
 *         ERC-20 quote asset, without ever needing a price oracle.
 *
 *         EXNIHILO markets are token/USDC only — `usdc` is a factory immutable
 *         and the pool's fee constants assume a 6-decimal stablecoin. Launchpads
 *         however bond in whatever their curve quotes in (AVAX, their own token,
 *         …). PreMarket is the periphery that bridges the two, leaving both the
 *         factory and the pool completely untouched.
 *
 * ── How it works ─────────────────────────────────────────────────────────────
 *
 *   1. SEED    The launchpad supplies `token` + `quote` and a starting price for
 *              the quote asset in USDC. PreMarket becomes a plain constant-product
 *              AMM over token/quote.
 *
 *   2. TRADE   The AMM is open for the whole auction. This is the point: arbitrage
 *              against the launchpad's own DEX pool keeps token/quote honest, so a
 *              slow auction costs time but never accuracy. There is no stale-price
 *              window to design around.
 *
 *   3. BUYOUT  A descending-price (Dutch) auction runs in parallel on the *entire*
 *              quote reserve. Anyone may buy it out for
 *                  currentPrice() x quoteReserve
 *              USDC. The auction discovers USDC-per-quote by being filled rather
 *              than by consulting anything.
 *
 *              The intended calibration is a start price of roughly spot + 1 %
 *              decaying at 2 %/minute, which crosses breakeven in about 30
 *              seconds and is a clear 1 % below it inside a minute — fast enough
 *              that a bidder with a few dollars of edge takes it promptly.
 *              Each 1 % of error in the seeded quote costs about 30 seconds.
 *
 *              There is no deadline. The price decays to MAX_DISCOUNT_BPS below
 *              the seeded price and stops there — a reserve price, not a slide
 *              to zero. If nobody takes it that is a fine resting state: the
 *              premarket carries on being a spot AMM for the token.
 *
 *              A buyout is executable whenever the reserve prices above zero,
 *              which is every state reachable by ordinary trading. It is NOT
 *              unconditional: a quote reserve drawn down hard enough to truncate
 *              to nothing reverts BuyoutNotPriceable. That is temporary and
 *              self-correcting — any quote-in swap clears it, and a reserve that
 *              cheap is exactly what arbitrage exists to buy — so it is not a
 *              stranding risk, which is why it is a revert rather than a clamp.
 *
 *   4. LAUNCH  The buyout atomically hands the reserves to EXNIHILOFactory:
 *              the token reserve and the USDC just paid become the real market's
 *              opening liquidity. A LockedLpVault is deployed and the LP NFT
 *              handed to it, so the liquidity is locked the moment the market
 *              exists — there is no window in which anyone could withdraw it.
 *
 * ── When the quote asset is already USDC ─────────────────────────────────────
 *
 *   The auction exists for exactly one reason: to discover what the bonded quote
 *   leg is worth in USDC. A launchpad that bonded in USDC has already answered
 *   that, so `PreMarketFactory` seeds the premarket and calls `launchDirect()`
 *   in the same transaction. Steps 2 and 3 are skipped entirely — the token
 *   reserve and the USDC reserve become the real market's opening liquidity as
 *   seeded, and the LP NFT goes straight into a LockedLpVault exactly as it
 *   would after a buyout.
 *
 *   Running the auction anyway would be worse than pointless. It would sell USDC
 *   for USDC at a price that decays to 10 % below par, so a bidder who simply
 *   waits five minutes takes a tenth of the reserve for nothing and the market
 *   opens that much thinner. `startPrice` and `decayBpsPerMinute` are therefore
 *   ignored on this path and recorded as zero, and `swap`/`buyout` are closed:
 *   a direct-launch premarket is a launch, not a venue.
 *
 * ── One-way commitment ───────────────────────────────────────────────────────
 *
 *   Seeding is irreversible. There is no withdrawal, refund or expiry path: the
 *   only way assets leave a premarket is a buyout — or, when the quote asset is
 *   USDC, the direct launch that replaces it — and either hands the LP NFT
 *   straight into a LockedLpVault. A launchpad can verify from the bytecode that
 *   its liquidity cannot be pulled back out, by anyone, ever — while the fee
 *   stream stays claimable by the project and the integrator.
 *
 * ── Why the opening price is correct ─────────────────────────────────────────
 *
 *   The premarket's implied price is quoteReserve/tokenReserve (quote per token).
 *   A buyout at price P leaves tokenReserve tokens against P x quoteReserve USDC,
 *   so the real market opens at
 *
 *       P x quoteReserve / tokenReserve  =  P x (premarket price)
 *
 *   The AMM discovers token/quote, the auction discovers quote/USDC, and the
 *   product is token/USDC. No oracle is consulted at any point.
 *
 * ── Why manipulation does not pay ────────────────────────────────────────────
 *
 *   The real market inherits the premarket's reserves *continuously* — it is the
 *   same curve with the quote leg swapped for USDC. Dumping token to push the
 *   ratio down means buying back along that same curve, paying slippage on both
 *   legs and gaining nothing. This is unlike oracle manipulation, where a price
 *   is moved and value is then extracted from an independent pot. No TWAP is
 *   therefore required.
 *
 * ── Security ─────────────────────────────────────────────────────────────────
 *
 *   - ReentrancyGuard on every state-changing external function.
 *   - CEI: reserves and the launched flag are written before any token movement.
 *   - Fee-on-transfer tokens are rejected on every inbound pull (_pullExact),
 *     mirroring EXNIHILOPool._transferIn.
 *   - Market parameters are validated at seed time, not at buyout. With no
 *     expiry path, a pool constructor revert during buyout would strand the
 *     premarket's liquidity permanently rather than merely delaying it.
 *   - `launched` is one-way. Once set, the AMM is closed for good, because its
 *     reserves now live in the pool.
 */
contract PreMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Constants ─────────────────────────────────────────────────────────────

    uint256 private constant BPS_DENOM = 10_000;

    /// @notice The premarket AMM's swap fee, in bps. Retained in the reserves, so
    ///         it ends up as extra liquidity in the real market.
    ///
    /// @dev    Fixed at the same 1 % EXNIHILOPool charges, and for the same
    ///         reason: it is the economic friction that makes a manipulate →
    ///         extract round trip lossy. It was a caller-supplied parameter with
    ///         only an upper bound, which on a permissionless factory meant
    ///         anyone could seed a premarket at 0 % and trade its curve for
    ///         free. Matching the pool also means the ratio the real market
    ///         inherits was discovered under the same friction it will trade
    ///         under.
    uint256 public constant swapFeeBps = 100;   // 1 %

    /// @dev Integrator's share of the pool's LP fee stream, set on the vault at
    ///      buyout. The pool routes 4 % of notional to the LP side, so half of
    ///      that is 2 % of notional to the integrator and 2 % to the LP owner.
    uint256 private constant INTEGRATOR_SHARE_BPS = 5_000;

    /// @dev Most the auction may discount the seeded price, in bps. The price
    ///      decays to `startPrice x (1 - MAX_DISCOUNT_BPS)` and stops there.
    ///
    ///      The auction used to decay to 1 unit — effectively giving the quote
    ///      reserve away — with only a flat $1 total as a backstop.
    ///      Because that total was CONSTANT in quoteReserve, adding quote to the
    ///      reserve cost nothing while `buyout` handed the whole reserve back to
    ///      the payer, so a swap-then-buyout round trip recovered its own deposit
    ///      and took the token reserve for the floor price. Flooring the PRICE
    ///      instead keeps the cost strictly increasing in quoteReserve at every
    ///      point of the decay, which is the property that closes it.
    ///
    ///      10 % is far wider than the auction is calibrated to need: at the
    ///      documented 2 %/minute it is reached after five minutes, where the
    ///      intended fill is inside one. An auction that runs past it is
    ///      mispriced, and the right outcome for a mispriced auction is to sit
    ///      unfilled — which the header already describes as a fine resting
    ///      state — rather than to keep discounting toward zero.
    uint256 private constant MAX_DISCOUNT_BPS = 1_000; // 10 %

    /// @dev Minimum USDC value of the quote reserve a premarket may be seeded
    ///      with, so a market that does launch opens with real backing.
    ///
    uint256 private constant MIN_SEED_USDC = 100_000_000; // 100 USDC

    // ── Types ─────────────────────────────────────────────────────────────────

    /**
     * @param token             Project token being launched.
     * @param quote             Arbitrary ERC-20 the launchpad bonded in. When it
     *                          is USDC itself there is nothing to auction, and
     *                          the premarket launches directly at seed time.
     * @param usdc              USDC (must equal the factory's own `usdc`).
     * @param factory           EXNIHILOFactory that will create the real market.
     * @param creator           Whoever seeded the premarket. Recorded for
     *                          origination attribution only — it grants no rights
     *                          and there is nothing to refund.
     * @param lpOwner           Claims the LP half of the fee stream from the
     *                          vault deployed at buyout.
     * @param integrator        Claims the integrator half. Zero means no
     *                          integrator, and the LP owner takes all of it.
     * @param quoteDecimals     Decimals of `quote`, used to scale the auction price.
     * @param startPrice        Auction start, in USDC (6 dec) per whole quote unit.
     *                          Intended to be the caller's honest spot quote plus
     *                          roughly 1 %. There is no band to absorb a bad
     *                          quote: too low and the reserve is sniped at that
     *                          number immediately. Ignored, and recorded as
     *                          zero, when `quote` is USDC.
     * @param decayBpsPerMinute Decay rate, in bps of `startPrice` per minute
     *                          (200 = 2 %/min). The price bottoms out at 1 unit
     *                          and stays there — never zero, so the auction stays
     *                          fillable forever. Ignored, and recorded as zero,
     *                          when `quote` is USDC.
     */
    struct Config {
        address token;
        address quote;
        address usdc;
        address factory;
        address creator;
        address lpOwner;
        address integrator;
        uint8   quoteDecimals;
        uint256 startPrice;
        uint256 decayBpsPerMinute;
    }

    // ── Immutables ────────────────────────────────────────────────────────────

    IERC20  public immutable token;
    IERC20  public immutable quote;
    IERC20  public immutable usdc;
    IEXNIHILOMarketFactory public immutable factory;

    address public immutable creator;
    address public immutable lpOwner;
    address public immutable integrator;

    /// @notice Whoever deployed this premarket — the PreMarketFactory on the
    ///         supported path. Only it may trigger a direct launch, which keeps
    ///         that path confined to the seeding transaction.
    address public immutable seeder;

    /// @notice True when `quote` is USDC itself. There is then nothing for the
    ///         auction to discover, so the market is created outright at seed
    ///         time and this premarket never trades.
    bool public immutable directLaunch;

    /// @notice True once the seeded reserves are provably in this contract.
    ///
    /// @dev    The constructor records tokenReserve/quoteReserve, but the assets
    ///         can only be moved in AFTER it returns — the address does not
    ///         exist until then. Between the two the contract is a live AMM
    ///         quoting reserves it does not hold, and a malicious token or quote
    ///         gets control during the transfers that fund it.
    ///
    ///         That window was closed only incidentally: every path out pays
    ///         before it is paid, so an empty contract fails on its own transfer
    ///         rather than on any check of its own (audit RE2-1). This makes it
    ///         a guard. confirmFunded verifies the balances rather than trusting
    ///         the seeder's word, so the flag states a fact the contract checked.
    bool public funded;

    /// @notice The LockedLpVault deployed by buyout(). Zero until launched.
    address public lpVault;

    /// @notice 10 ** quoteDecimals — the scale one whole quote unit is priced in.
    uint256 public immutable quoteUnit;

    uint256 public immutable startPrice;
    uint256 public immutable decayBpsPerMinute;
    uint256 public immutable startTime;


    // ── State ─────────────────────────────────────────────────────────────────

    uint256 public tokenReserve;
    uint256 public quoteReserve;

    /// @notice True once a buyout has created the real market. One-way; the AMM
    ///         closes at that point because its reserves have moved to the pool.
    bool public launched;

    /// @notice The EXNIHILOPool created by buyout(). Zero until launched.
    address public launchedPool;

    /// @notice USDC paid by the buyer that seeded the real market.
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

    /**
     * @param usdcPaid      What the buyer actually paid — the authoritative
     *                      figure, and what seeds the market.
     * @param quoteReceived The whole quote reserve.
     * @param price         The auction's USDC-per-whole-quote-unit at fill.
     *
     * @dev   `usdcPaid` is the authoritative figure. It equals
     *        `quoteReceived x price / quoteUnit` up to integer truncation, but
     *        read it directly rather than recomputing it.
     */
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

    /**
     * @dev Deployed and seeded in one transaction by PreMarketFactory. The
     *      factory pulls both legs from the launchpad and forwards them here, so
     *      a PreMarket is never observable in an unseeded state.
     *
     *      Neither position size caps nor position lifetime take a parameter:
     *      the pool derives both from its own age. Size ramps from 1 % to 20 %
     *      of reserves over the first day, lifetime steps from 1 hour to 30 days
     *      over the first week. There is correspondingly nothing here that can
     *      be misconfigured into a buyout-time revert.
     */
    constructor(Config memory c, uint256 tokenAmount, uint256 quoteAmount) {
        if (c.token   == address(0)) revert ZeroAddress();
        if (c.quote   == address(0)) revert ZeroAddress();
        if (c.usdc    == address(0)) revert ZeroAddress();
        if (c.factory == address(0)) revert ZeroAddress();
        if (c.creator == address(0)) revert ZeroAddress();
        if (c.lpOwner == address(0)) revert ZeroAddress();

        if (tokenAmount == 0 || quoteAmount == 0) revert ZeroAmount();

        if (c.usdc != IEXNIHILOMarketFactory(c.factory).usdc()) revert UsdcMismatch();

        // Mirror EXNIHILOFactory.createMarket's own token validation here, at
        // seed time. Both of these sail through seeding and then revert inside
        // createMarket on every buyout, forever, and there is no refund path to
        // fall back on — which is exactly the failure mode the design rule above
        // exists to prevent.
        if (c.token == c.usdc)  revert TokenIsUsdc();
        if (c.token == c.quote) revert TokenIsQuote();

        bool direct = c.quote == c.usdc;

        uint256 startPrice_;
        uint256 decay_;

        if (direct) {
            // Nothing to auction: the bonded leg already IS the market's USDC
            // leg, so the seeded amount is its own USDC value. The auction
            // parameters are meaningless here and are ignored rather than
            // rejected — a launchpad passing its usual defaults should not have
            // to special-case its own quote asset — and recorded as zero so
            // nothing off-chain mistakes this for a live auction.
            if (quoteAmount < MIN_SEED_USDC) revert SeedBelowMinimum();
        } else {
            if (c.startPrice == 0) revert InvalidPriceRange();
            if (c.decayBpsPerMinute == 0 || c.decayBpsPerMinute > BPS_DENOM) revert InvalidDecayRate();

            // The seeded reserve must be worth enough to open a usable market,
            // and far enough above the point where the priced cost truncates
            // that ordinary trading cannot reach it. Checking the reserve rather
            // than startPrice alone ties the bound to what is actually being
            // auctioned, so it holds for any quote decimals.
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

    // ── Auction pricing ───────────────────────────────────────────────────────

    /**
     * @notice Current Dutch price, in USDC (6 dec) per whole quote unit.
     *
     *         Falls by `decayBpsPerMinute` of `startPrice` every minute, with
     *         per-second resolution, bottoming out at 1 unit and staying there.
     *
     *         The floor is 1 rather than 0 so the auction never becomes
     *         unfillable. Nothing on-chain stops a bidder waiting for it: the
     *         protection is economic, in that the reserve is worth taking long
     *         before then, and whoever waits is leaving money on the table for
     *         everyone else.
     *
     * @dev    Linear rather than geometric so the price needs no fixed-point math
     *         and is exactly reproducible off-chain by any bidder. Over the first
     *         few minutes — the only window that matters here — the two shapes
     *         differ by well under 0.1 %.
     */
    function currentPrice() public view returns (uint256) {
        // A direct-launch premarket has no auction. Both parameters are zero, so
        // there is no price to report and the decay maths below would divide by
        // `decayBpsPerMinute`.
        if (directLaunch) return 0;

        uint256 floorPrice = (startPrice * (BPS_DENOM - MAX_DISCOUNT_BPS)) / BPS_DENOM;

        // Cap the elapsed term at just past the point the floor is reached.
        // Beyond it the result is the floor regardless, so this only removes the
        // unbounded multiply — a premarket nobody buys sits for years, and
        // startPrice x decay x elapsed would otherwise grow without limit and
        // eventually revert, bricking the only exit the contract has.
        uint256 elapsedMax = (MAX_DISCOUNT_BPS * 60) / decayBpsPerMinute + 1;
        uint256 elapsed = block.timestamp - startTime;
        if (elapsed > elapsedMax) elapsed = elapsedMax;

        uint256 drop = (startPrice * decayBpsPerMinute * elapsed) / (BPS_DENOM * 60);
        uint256 price = drop >= startPrice ? 0 : startPrice - drop;

        return price < floorPrice ? floorPrice : price;
    }

    /**
     * @notice USDC required to buy out the entire quote reserve right now, and
     *         the quote amount that would be received for it.
     *
     *         Reports zero when the quote reserve has been drawn down far enough
     *         that it prices to nothing; `buyout` reverts BuyoutNotPriceable
     *         there, and any quote-in swap clears it.
     */
    function buyoutCost() external view returns (uint256 usdcCost, uint256 quoteOut) {
        quoteOut = quoteReserve;
        usdcCost = _buyoutCost(quoteOut, currentPrice());
    }

    /**
     * @dev Priced cost of taking `quoteOut` at `price`, clamped up to the floor.
     *      Single source of truth for the view and the state-changing path, so
     *      the two cannot drift.
     */
    function _buyoutCost(uint256 quoteOut, uint256 price) internal view returns (uint256) {
        return (quoteOut * price) / quoteUnit;
    }

    /**
     * @notice Called by the seeding factory once both legs have been
     *         transferred in, opening the AMM. Verifies rather than trusts:
     *         reverts unless the balances actually cover the recorded reserves.
     *
     * @dev    Idempotent, and pointless to call twice — nothing reads it except
     *         the three guards below, and it can never be unset.
     */
    function confirmFunded() external {
        if (msg.sender != seeder) revert OnlySeeder();
        if (token.balanceOf(address(this)) < tokenReserve) revert NotFunded();
        if (quote.balanceOf(address(this)) < quoteReserve) revert NotFunded();
        funded = true;
    }

    // ── AMM ───────────────────────────────────────────────────────────────────

    /**
     * @notice Constant-product quote with the fee taken off the input, exactly
     *         as Uniswap V2 does. The fee is retained in the reserves and so
     *         becomes additional liquidity in the real market.
     *
     * @dev    Deliberately NOT the same fee model as EXNIHILOPool._cpAmountOut,
     *         which charges on the spot value of the input. The premarket is a
     *         plain spot AMM with no synthetic supply to keep consistent.
     */
    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) public pure returns (uint256) {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0) return 0;
        uint256 amountInWithFee = amountIn * (BPS_DENOM - swapFeeBps);
        return (amountInWithFee * reserveOut) / (reserveIn * BPS_DENOM + amountInWithFee);
    }

    /**
     * @notice Swap token for quote or vice versa against the premarket reserves.
     *
     *         Open for the entire auction. Arbitrage here is what keeps the
     *         eventual market's opening ratio current.
     *
     * @param amountIn      Raw input amount.
     * @param minAmountOut  Slippage guard.
     * @param tokenToQuote  true = token in / quote out, false = the reverse.
     * @param to            Recipient of the output.
     */
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

        // ── EFFECTS ───────────────────────────────────────────────────────────
        if (tokenToQuote) {
            tokenReserve = reserveIn + amountIn;
            quoteReserve = reserveOut - amountOut;
        } else {
            quoteReserve = reserveIn + amountIn;
            tokenReserve = reserveOut - amountOut;
        }

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        IERC20 assetIn  = tokenToQuote ? token : quote;
        IERC20 assetOut = tokenToQuote ? quote : token;

        _pullExact(assetIn, msg.sender, amountIn);
        assetOut.safeTransfer(to, amountOut);

        emit Swapped(
            msg.sender, to, tokenToQuote, amountIn, amountOut, tokenReserve, quoteReserve
        );
    }

    // ── Buyout / launch ───────────────────────────────────────────────────────

    /**
     * @notice Buy the entire quote reserve at the current Dutch price and launch
     *         the real EXNIHILO market in the same transaction.
     *
     *         The caller pays `currentPrice() x quoteReserve` USDC and receives
     *         the whole quote reserve. That USDC, together with the token reserve as it
     *         stands, becomes the new market's opening liquidity, so the market
     *         opens at the premarket's live ratio priced at the auction's
     *         realised rate.
     *
     *         A buyout is therefore always executable: there is no decay far
     *         enough, and no reserve small enough, to price one out of reach.
     *         That matters more here than the last cent of price accuracy,
     *         because nothing in this contract can return the reserves if the
     *         buyout is the path that closes.
     *
     * @param maxUsdc      Cost guard. The price only falls with time, but the
     *                     quote reserve can grow if someone swaps quote in, so
     *                     the total cost is not monotonic.
     * @param minQuoteOut  Guard against the reserve being drained between quote
     *                     and execution.
     */
    function buyout(
        uint256 maxUsdc,
        uint256 minQuoteOut
    ) external nonReentrant returns (address pool, uint256 lpNftId) {
        if (launched) revert AlreadyLaunched();

        // Selling USDC for USDC at a decaying price would hand the reserve away
        // a tenth at a time. `launchDirect` is that premarket's exit instead.
        if (directLaunch) revert NoAuction();

        if (!funded) revert NotFunded();

        // Both reserves are non-zero by construction and stay non-zero: the
        // constant-product curve is asymptotic, so no swap can fully drain a side.
        uint256 quoteOut = quoteReserve;
        uint256 tokenOut = tokenReserve;

        uint256 price   = currentPrice();
        uint256 usdcIn  = _buyoutCost(quoteOut, price);

        // A reserve drawn down far enough by trading prices to nothing, and a
        // market cannot be seeded with zero USDC. Reverting here is correct and
        // is NOT a stranding risk: the condition is temporary and anyone can
        // clear it by swapping quote in, which is also the arbitrage a reserve
        // that cheap invites. This used to clamp up to a flat floor instead,
        // which was strictly worse in both directions — it was the lever C-2
        // pulled, and it let the drained moment be locked in as a permanent
        // launch over a near-empty market, since `launched` is one-way.
        if (usdcIn == 0) revert BuyoutNotPriceable();

        if (usdcIn > maxUsdc) revert CostExceedsMax();
        if (quoteOut < minQuoteOut) revert QuoteBelowMin();

        // ── EFFECTS ───────────────────────────────────────────────────────────
        launched     = true;
        tokenReserve = 0;
        quoteReserve = 0;
        launchUsdc   = usdcIn;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        _pullExact(usdc, msg.sender, usdcIn);
        quote.safeTransfer(msg.sender, quoteOut);

        emit BoughtOut(msg.sender, usdcIn, quoteOut, price);

        (pool, lpNftId) = _launch(tokenOut, usdcIn);
    }

    /**
     * @notice Create the real market straight from the seeded reserves, with no
     *         auction. Only reachable when `quote` is USDC, where there is
     *         nothing for an auction to discover.
     *
     *         `PreMarketFactory` calls this in the transaction that seeds the
     *         premarket, so such a premarket is never observable as a live
     *         auction and never trades. It is restricted to `seeder` to keep it
     *         that way: the direct path is the tail of seeding, not a second
     *         entry point anyone can drive.
     *
     *         The token reserve and the USDC reserve become the market's opening
     *         liquidity exactly as seeded — no price is applied to either leg —
     *         and the LP NFT is locked in a LockedLpVault just as a buyout would
     *         lock it.
     */
    function launchDirect() external nonReentrant returns (address pool, uint256 lpNftId) {
        if (!directLaunch) revert NotDirectLaunch();
        if (msg.sender != seeder) revert OnlySeeder();
        if (!funded) revert NotFunded();
        if (launched) revert AlreadyLaunched();

        uint256 usdcIn   = quoteReserve;
        uint256 tokenOut = tokenReserve;

        // ── EFFECTS ───────────────────────────────────────────────────────────
        launched     = true;
        tokenReserve = 0;
        quoteReserve = 0;
        launchUsdc   = usdcIn;

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        // Nothing is paid in and nothing is paid out: `quote` and `usdc` are the
        // same asset, so the reserve already sitting here is the market's.
        (pool, lpNftId) = _launch(tokenOut, usdcIn);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    /**
     * @dev Hand `tokenOut` and `usdcIn` to EXNIHILOFactory and lock the LP NFT
     *      that comes back in a fresh LockedLpVault. Shared by `buyout` and
     *      `launchDirect` so the two paths cannot drift apart.
     *
     *      Pure INTERACTIONS: callers must already have written the effects
     *      (`launched`, the zeroed reserves, `launchUsdc`) before calling in.
     */
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

        // Revoke residual approvals (defense-in-depth for non-standard ERC-20s
        // that do not zero the allowance on an exact transferFrom).
        token.forceApprove(address(factory), 0);
        usdc.forceApprove(address(factory), 0);

        launchedPool = pool;

        // Lock the LP in the same transaction the market is created in, so no
        // block ever exists in which the liquidity could be withdrawn.
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

        // createMarket transferred the LP NFT here; forward it on. Plain
        // transferFrom, so no ERC721 receiver hook is required at either end.
        IERC721(lpNftAddr).transferFrom(address(this), lpVault, lpNftId);

        emit Launched(pool, lpVault, lpNftId, tokenOut, usdcIn);
    }

    /**
     * @dev Pull exactly `amount` and verify the balance moved by exactly that
     *      much. Mirrors EXNIHILOPool._transferIn: fee-on-transfer assets would
     *      silently desynchronise the reserves from the real balances.
     */
    function _pullExact(IERC20 asset, address from, uint256 amount) internal {
        uint256 balanceBefore = asset.balanceOf(address(this));
        asset.safeTransferFrom(from, address(this), amount);
        if (asset.balanceOf(address(this)) - balanceBefore != amount) {
            revert FeeOnTransferNotSupported();
        }
    }
}
