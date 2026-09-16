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
 * @notice Permissionless, ownerless entry point for launching a market from any
 *         ERC-20 quote through a PreMarket. A USDC quote launches immediately.
 */
contract PreMarketFactory is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Immutables ────────────────────────────────────────────────────────────

    address public immutable marketFactory;
    /// @notice USDC, read from marketFactory.
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

    struct Params {
        address token;
        uint256 tokenAmount;
        address quote;             // USDC skips the auction
        uint256 quoteAmount;
        uint256 startPrice;        // USDC (6 dec) per whole quote unit, ~spot + 1 %
        uint256 decayBpsPerMinute; // bps of startPrice per minute (200 = 2 %)
        address lpOwner;
        address integrator;        // zero disables the integrator share
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address marketFactory_) {
        if (marketFactory_ == address(0)) revert ZeroAddress();
        marketFactory = marketFactory_;
        usdc = IEXNIHILOMarketFactory(marketFactory_).usdc();
    }

    // ── Creation ──────────────────────────────────────────────────────────────

    /// @notice Deploy and seed a PreMarket from pre-approved legs; msg.sender is its
    ///         creator. Irreversible. With a USDC quote the premarket is returned
    ///         already launched.
    function createPreMarket(
        Params calldata p
    ) external nonReentrant returns (address preMarket) {
        if (p.token == address(0) || p.quote == address(0)) revert ZeroAddress();
        if (p.tokenAmount == 0 || p.quoteAmount == 0) revert ZeroAmount();
        if (p.token == usdc)    revert TokenIsUsdc();
        if (p.token == p.quote) revert TokenIsQuote();

        // No fallback: quoteUnit prices every buyout, so unreadable decimals are refused.
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

        _pullExactTo(p.token, msg.sender, preMarket, p.tokenAmount);
        _pullExactTo(p.quote, msg.sender, preMarket, p.quoteAmount);

        PreMarket(preMarket).confirmFunded();

        isPreMarket[preMarket] = true;
        allPreMarkets.push(preMarket);

        emit PreMarketCreated(
            preMarket, p.token, p.quote, msg.sender, p.tokenAmount, p.quoteAmount
        );

        // USDC quote: launch now, so no USDC-for-USDC auction ever exists.
        if (p.quote == usdc) {
            PreMarket(preMarket).launchDirect();
        }
    }

    function allPreMarketsLength() external view returns (uint256) {
        return allPreMarkets.length;
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    /// @dev Transfer exactly `amount` from `from` to `to`; rejects fee-on-transfer tokens.
    function _pullExactTo(address asset, address from, address to, uint256 amount) internal {
        uint256 balanceBefore = IERC20(asset).balanceOf(to);
        IERC20(asset).safeTransferFrom(from, to, amount);
        if (IERC20(asset).balanceOf(to) - balanceBefore != amount) {
            revert FeeOnTransferNotSupported();
        }
    }
}
