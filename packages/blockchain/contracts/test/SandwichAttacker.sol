// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IPoolSandwich {
    function swap(uint256 amountIn, uint256 minAmountOut, bool tokenToUsdc, address recipient)
        external;
    function openLong(uint256 usdcAmount, uint256 minAirTokenOut, address recipient) external;
    function closeLong(uint256 nftId, uint256 minUsdcOut, address to) external;
}

/**
 * @title  SandwichAttacker
 * @notice Test-only: pump → close → unwind in one transaction, which a script
 *         cannot do (each await mines its own block).
 */
contract SandwichAttacker is IERC721Receiver {
    IPoolSandwich public immutable pool;
    IERC20 public immutable usdc;
    IERC20 public immutable token;

    constructor(address pool_, address usdc_, address token_) {
        pool  = IPoolSandwich(pool_);
        usdc  = IERC20(usdc_);
        token = IERC20(token_);
        IERC20(usdc_).approve(pool_, type(uint256).max);
        IERC20(token_).approve(pool_, type(uint256).max);
    }

    function openLong(uint256 notional) external {
        pool.openLong(notional, 0, address(this));
    }

    /// @notice Close with no manipulation — the baseline.
    function plainClose(uint256 nftId) external {
        pool.closeLong(nftId, 0, address(this));
    }

    /// @notice Pump, close at the moved mark, unwind.
    function sandwichClose(uint256 nftId, uint256 pumpUsdc) external {
        pool.swap(pumpUsdc, 0, false, address(this)); // USDC → token, price up
        pool.closeLong(nftId, 0, address(this));
        uint256 bal = token.balanceOf(address(this));
        if (bal > 0) {
            pool.swap(bal, 0, true, address(this)); // token → USDC, unwind
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }
}
