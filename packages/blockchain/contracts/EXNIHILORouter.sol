// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IEXNIHILOFactory {
    function isPool(address pool) external view returns (bool);
}

interface IEXNIHILOPool {
    function underlyingToken() external view returns (IERC20);
    function underlyingUsdc() external view returns (IERC20);
    function quoteOpenFee(uint256 notional, bool isLong) external view returns (uint256);

    function openLong(uint256 usdcAmount, uint256 minAirTokenOut, address recipient) external;
    function openShort(uint256 usdcNotional, uint256 minAirUsdOut, address recipient) external;
    function swap(uint256 amountIn, uint256 minAmountOut, bool tokenToUsdc, address recipient) external;
}

/**
 * @title  EXNIHILORouter
 * @notice Pulls only what a registered pool needs (the open fee or the swap input),
 *         forwards the call with the caller as recipient and refunds any residue.
 *         LP and position-holder actions go to the pool directly.
 */
contract EXNIHILORouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IEXNIHILOFactory public immutable factory;
    IERC20           public immutable usdc;

    error PoolNotRegistered();

    modifier onlyPool(address pool) {
        if (!factory.isPool(pool)) revert PoolNotRegistered();
        _;
    }

    constructor(address factory_, address usdc_) {
        factory = IEXNIHILOFactory(factory_);
        usdc    = IERC20(usdc_);
    }

    function _positionFee(uint256 notional, address pool, bool isLong) internal view returns (uint256) {
        return IEXNIHILOPool(pool).quoteOpenFee(notional, isLong);
    }

    /// @dev Refund what this call added but the pool left, measured from `balBefore`.
    function _refundResidual(IERC20 token, uint256 balBefore, address recipient) internal {
        uint256 balAfter = token.balanceOf(address(this));
        if (balAfter > balBefore) {
            token.safeTransfer(recipient, balAfter - balBefore);
        }
    }

    /// @notice Open a long on `pool`. Caller must have approved USDC to this router.
    function openLong(
        address pool,
        uint256 usdcAmount,
        uint256 minAirTokenOut
    ) external nonReentrant onlyPool(pool) {
        uint256 fee = _positionFee(usdcAmount, pool, true);
        uint256 balBefore = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), fee);
        usdc.forceApprove(pool, fee);
        IEXNIHILOPool(pool).openLong(usdcAmount, minAirTokenOut, msg.sender);
        usdc.forceApprove(pool, 0);
        _refundResidual(usdc, balBefore, msg.sender);
    }

    /// @notice Open a short on `pool`. Caller must have approved USDC to this router.
    function openShort(
        address pool,
        uint256 usdcNotional,
        uint256 minAirUsdOut
    ) external nonReentrant onlyPool(pool) {
        uint256 fee = _positionFee(usdcNotional, pool, false);
        uint256 balBefore = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), fee);
        usdc.forceApprove(pool, fee);
        IEXNIHILOPool(pool).openShort(usdcNotional, minAirUsdOut, msg.sender);
        usdc.forceApprove(pool, 0);
        _refundResidual(usdc, balBefore, msg.sender);
    }

    /// @notice Swap via `pool`. Caller must have approved the input token to this router.
    function swap(
        address pool,
        uint256 amountIn,
        uint256 minAmountOut,
        bool tokenToUsdc
    ) external nonReentrant onlyPool(pool) {
        IERC20 tokenIn = tokenToUsdc
            ? IEXNIHILOPool(pool).underlyingToken()
            : usdc;

        uint256 balBefore = tokenIn.balanceOf(address(this));
        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        tokenIn.forceApprove(pool, amountIn);
        IEXNIHILOPool(pool).swap(amountIn, minAmountOut, tokenToUsdc, msg.sender);
        tokenIn.forceApprove(pool, 0);
        _refundResidual(tokenIn, balBefore, msg.sender);
    }
}
