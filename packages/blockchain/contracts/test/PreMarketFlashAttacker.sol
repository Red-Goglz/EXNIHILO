// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IFlashBorrower {
    function onFlashLoan(address asset, uint256 amount, bytes calldata data) external;
}

/// @dev Test-only uncollateralised lender: its balance must be whole by the end of the call.
contract MockFlashLender {
    using SafeERC20 for IERC20;

    function flashLoan(
        IERC20 asset,
        uint256 amount,
        address receiver,
        bytes calldata data
    ) external {
        uint256 balanceBefore = asset.balanceOf(address(this));
        asset.safeTransfer(receiver, amount);
        IFlashBorrower(receiver).onFlashLoan(address(asset), amount, data);
        require(asset.balanceOf(address(this)) >= balanceBefore, "flash loan not repaid");
    }
}

interface IPreMarketLike {
    function swap(uint256 amountIn, uint256 minAmountOut, bool tokenToQuote, address to)
        external returns (uint256 amountOut);
    function buyout(uint256 maxUsdc, uint256 minQuoteOut)
        external returns (address pool, uint256 lpNftId);
}

interface IPoolLike {
    function swap(uint256 amountIn, uint256 minAmountOut, bool tokenToUsdc, address recipient)
        external;
}

/**
 * @title  PreMarketFlashAttacker
 * @notice Test-only swap-then-buyout round trip on borrowed quote: swap it in for
 *         tokens, buy out (receiving the whole quote reserve), repay, and dump the
 *         tokens into the launched market. Tests assert on net USDC.
 */
contract PreMarketFlashAttacker is IFlashBorrower {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    IERC20 public immutable quote;
    IERC20 public immutable usdc;
    IPreMarketLike public immutable preMarket;
    MockFlashLender public immutable lender;

    address public launchedPool;
    uint256 public tokensTaken;
    uint256 public quoteReceived;
    uint256 public usdcPaid;
    uint256 public usdcFromDump;

    constructor(
        address token_,
        address quote_,
        address usdc_,
        address preMarket_,
        address lender_
    ) {
        token     = IERC20(token_);
        quote     = IERC20(quote_);
        usdc      = IERC20(usdc_);
        preMarket = IPreMarketLike(preMarket_);
        lender    = MockFlashLender(lender_);
    }

    /// @param borrow   Quote to flash-borrow and push through the premarket.
    /// @param maxUsdc  Cost guard forwarded to buyout.
    function attack(uint256 borrow, uint256 maxUsdc) external {
        lender.flashLoan(quote, borrow, address(this), abi.encode(maxUsdc));
    }

    function onFlashLoan(address, uint256 amount, bytes calldata data) external override {
        require(msg.sender == address(lender), "only lender");
        uint256 maxUsdc = abi.decode(data, (uint256));

        // amount == 0 is the control case: a plain buyout.
        if (amount != 0) {
            quote.forceApprove(address(preMarket), amount);
            tokensTaken = preMarket.swap(amount, 0, false, address(this));
        }

        uint256 usdcBefore  = usdc.balanceOf(address(this));
        uint256 quoteBefore = quote.balanceOf(address(this));
        usdc.forceApprove(address(preMarket), maxUsdc);
        (address pool, ) = preMarket.buyout(maxUsdc, 0);
        launchedPool  = pool;
        usdcPaid      = usdcBefore - usdc.balanceOf(address(this));
        quoteReceived = quote.balanceOf(address(this)) - quoteBefore;

        quote.safeTransfer(address(lender), amount);

        // Realise the tokens against the launched market.
        uint256 held = token.balanceOf(address(this));
        if (held != 0) {
            uint256 beforeDump = usdc.balanceOf(address(this));
            token.forceApprove(pool, held);
            IPoolLike(pool).swap(held, 0, true, address(this));
            usdcFromDump = usdc.balanceOf(address(this)) - beforeDump;
        }
    }
}
