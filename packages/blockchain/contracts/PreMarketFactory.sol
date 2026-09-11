// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./PreMarket.sol";

interface IERC20Metadata {
    function decimals() external view returns (uint8);
}

/**
 * @title  PreMarketFactory
 * @author EXNIHILO
 * @notice Permissionless factory for PreMarket instances — the any-ERC-20 entry
 *         point a launchpad calls at bond.
 *
 *         This is the "second createMarket" from an integrator's point of view:
 *         one call, any quote asset. The real EXNIHILOFactory and EXNIHILOPool
 *         are untouched; the premarket converts the quote leg to USDC by auction
 *         and then calls the existing createMarket itself.
 *
 *         When the quote leg is already USDC there is nothing to convert, so the
 *         auction is skipped entirely: this factory seeds the premarket and
 *         launches it in the same call, and the caller gets a live market rather
 *         than a live auction. See PreMarket's own header for why running the
 *         auction on USDC would be worse than skipping it.
 *
 * ── Immutability ───────────────────────────────────────────────────────────────
 *
 *   No owner, no admin functions, all constructor parameters immutable —
 *   matching EXNIHILOFactory. A launchpad locking liquidity into a premarket can
 *   verify that nothing about its behaviour can later be changed.
 *
 * ── Seeding ────────────────────────────────────────────────────────────────────
 *
 *   The PreMarket records its reserves in its constructor, then this factory
 *   pulls both legs straight from the caller to the new premarket in a single
 *   hop. Recorded reserves and real balances therefore agree before the
 *   transaction ends, and there is no intermediate custody.
 */
contract PreMarketFactory is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Immutables ────────────────────────────────────────────────────────────

    /// @notice EXNIHILOFactory every premarket will launch its market through.
    address public immutable marketFactory;

    /// @notice USDC, read from `marketFactory` so the two can never disagree.
    address public immutable usdc;

    // ── Registry ──────────────────────────────────────────────────────────────

    mapping(address => bool) public isPreMarket;
    address[] public allPreMarkets;

    // ── Errors ────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error TokenIsUsdc();
    error TokenIsQuote();
    error FeeOnTransferNotSupported();
    error QuoteDecimalsUnavailable();

    // ── Events ────────────────────────────────────────────────────────────────

    event PreMarketCreated(
        address indexed preMarket,
        address indexed token,
        address indexed quote,
        address creator,
        uint256 tokenAmount,
        uint256 quoteAmount
    );

    // ── Params ────────────────────────────────────────────────────────────────

    /**
     * @param token             Project token to launch a market for.
     * @param tokenAmount       Token liquidity seeded into the premarket.
     * @param quote             Any standard ERC-20 the launchpad bonded in.
     *                          Pass USDC to skip the auction and open the real
     *                          market immediately at the seeded ratio.
     * @param quoteAmount       Quote liquidity seeded into the premarket.
     * @param startPrice        Dutch start, USDC (6 dec) per whole quote unit.
     *                          Ignored when `quote` is USDC.
     *                          Intended to be an honest spot quote plus ~1 %.
     *                          Overestimating costs about 30 seconds per 1 % at
     *                          the default rate; underestimating gets the reserve
     *                          sniped at that number, with no band to absorb it.
     * @param decayBpsPerMinute Decay per minute in bps of startPrice (200 = 2 %).
     *                          Ignored when `quote` is USDC.
     * @param lpOwner           Claims the LP half of the fee stream post-launch.
     * @param integrator        Claims the integrator half. Zero disables it.
     */
    struct Params {
        address token;
        uint256 tokenAmount;
        address quote;
        uint256 quoteAmount;
        uint256 startPrice;
        uint256 decayBpsPerMinute;
        address lpOwner;
        address integrator;
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address marketFactory_) {
        if (marketFactory_ == address(0)) revert ZeroAddress();
        marketFactory = marketFactory_;
        usdc = IEXNIHILOMarketFactory(marketFactory_).usdc();
    }

    // ── Creation ──────────────────────────────────────────────────────────────

    /**
     * @notice Deploy and seed a premarket. Both legs must be approved to this
     *         factory beforehand.
     *
     *         `msg.sender` is recorded as the premarket's `creator`. Seeding is
     *         irreversible — there is no withdrawal or refund path, and the only
     *         way the assets move again is a buyout.
     *
     *         When `quote` is USDC the premarket is launched before this call
     *         returns, so the address handed back is already `launched`, with
     *         `launchedPool` and `lpVault` set. Callers that need to distinguish
     *         the two shapes should read `PreMarket.directLaunch()` rather than
     *         comparing addresses themselves.
     *
     * @return preMarket Address of the newly deployed PreMarket.
     */
    function createPreMarket(
        Params calldata p
    ) external nonReentrant returns (address preMarket) {
        if (p.token == address(0) || p.quote == address(0)) revert ZeroAddress();
        if (p.tokenAmount == 0 || p.quoteAmount == 0) revert ZeroAmount();

        // Mirror EXNIHILOFactory.createMarket's token validation, which would
        // otherwise only be reached at buyout — by which point the seed is
        // already in custody and there is no path that returns it. PreMarket's
        // constructor repeats both checks; this one names the mistake before
        // anything is deployed or pulled.
        if (p.token == usdc)    revert TokenIsUsdc();
        if (p.token == p.quote) revert TokenIsQuote();

        // Read the quote asset's decimals so the auction price can be expressed
        // per whole unit.
        //
        // Deliberately NOT EXNIHILOFactory's fallback-to-18. There the value is
        // cosmetic; here it is load-bearing arithmetic — quoteUnit divides every
        // buyout price and the seed-value check. Guessing 18 for a 6-decimal
        // quote is a 1e12 error in what the reserve is thought to be worth
        // (audit IA-R2-5). A quote asset whose decimals cannot be read is one
        // this contract cannot price, so it is refused rather than assumed. The
        // cost is that a quote token without the optional metadata extension
        // cannot be used; a launchpad hitting this can wrap it.
        uint8 quoteDecimals;
        try IERC20Metadata(p.quote).decimals() returns (uint8 d) {
            quoteDecimals = d;
        } catch {
            revert QuoteDecimalsUnavailable();
        }

        preMarket = address(
            new PreMarket(
                PreMarket.Config({
                    token:            p.token,
                    quote:            p.quote,
                    usdc:             usdc,
                    factory:          marketFactory,
                    creator:          msg.sender,
                    lpOwner:          p.lpOwner,
                    integrator:       p.integrator,
                    quoteDecimals:    quoteDecimals,
                    startPrice:        p.startPrice,
                    decayBpsPerMinute: p.decayBpsPerMinute
                }),
                p.tokenAmount,
                p.quoteAmount
            )
        );

        // Single hop from the caller into the premarket, so the reserves the
        // constructor recorded match the real balances by the end of this call.
        _pullExactTo(p.token, msg.sender, preMarket, p.tokenAmount);
        _pullExactTo(p.quote, msg.sender, preMarket, p.quoteAmount);

        // Both legs are in. Until this call the child quotes reserves it does
        // not hold and its AMM is shut (audit RE2-1); it re-checks the balances
        // itself rather than taking this call as proof.
        PreMarket(preMarket).confirmFunded();

        isPreMarket[preMarket] = true;
        allPreMarkets.push(preMarket);

        emit PreMarketCreated(
            preMarket, p.token, p.quote, msg.sender, p.tokenAmount, p.quoteAmount
        );

        // A premarket bonded in USDC has nothing to auction. Launching it here
        // means it is never observable as a live auction, so the mispriced
        // USDC-for-USDC buyout it would otherwise expose has no block to run in.
        // Both legs are already in the premarket, so this needs nothing further
        // from the caller.
        if (p.quote == usdc) {
            PreMarket(preMarket).launchDirect();
        }
    }

    function allPreMarketsLength() external view returns (uint256) {
        return allPreMarkets.length;
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    /**
     * @dev Transfer exactly `amount` from `from` to `to` and verify the
     *      recipient's balance moved by exactly that much. Fee-on-transfer
     *      assets would leave the premarket's recorded reserves overstated.
     */
    function _pullExactTo(address asset, address from, address to, uint256 amount) internal {
        uint256 balanceBefore = IERC20(asset).balanceOf(to);
        IERC20(asset).safeTransferFrom(from, to, amount);
        if (IERC20(asset).balanceOf(to) - balanceBefore != amount) {
            revert FeeOnTransferNotSupported();
        }
    }
}
