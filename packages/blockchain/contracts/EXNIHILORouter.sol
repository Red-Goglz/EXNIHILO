// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IEXNIHILOFactory {
    function isPool(address pool) external view returns (bool);
}

interface IEXNIHILOPool {
    function underlyingToken() external view returns (IERC20);
    function underlyingUsdc() external view returns (IERC20);
    function backedAirUsd() external view returns (uint256);
    function longOpenInterest() external view returns (uint256);
    function shortOpenInterest() external view returns (uint256);

    function openLong(uint256 usdcAmount, uint256 minAirTokenOut, address recipient) external;
    function openShort(uint256 usdcNotional, uint256 minAirUsdOut, address recipient) external;
    function swap(uint256 amountIn, uint256 minAmountOut, bool tokenToUsdc, address recipient) external;
}

/**
 * @title EXNIHILORouter
 * @notice Thin router for trading operations. Users approve USDC (and any
 *         underlying tokens) to this contract once; the router pulls only
 *         the position fee from the caller, approves the target pool, and
 *         forwards the call.
 *
 *         LP operations (addLiquidity, removeLiquidity, claimFees, setPositionCaps)
 *         and position exits (closeLong, closeShort, realizeLong, realizeShort)
 *         are called directly on the pool — the router does not wrap them.
 */
contract EXNIHILORouter {
    using SafeERC20 for IERC20;

    IEXNIHILOFactory public immutable factory;
    IERC20           public immutable usdc;

    // Must match EXNIHILOPool constants exactly
    uint256 private constant BPS_DENOM        = 10_000;
    uint256 private constant LP_FEE_BPS       = 300;   // 3 %
    uint256 private constant PROTOCOL_FEE_BPS = 200;   // 2 %
    uint256 private constant MIN_POSITION_FEE = 50_000; // 0.05 USDC (6 dec)
    uint256 private constant IMPACT_FEE_BPS   = 1500;  // 15 % impact scaling rate

    error PoolNotRegistered();

    modifier onlyPool(address pool) {
        if (!factory.isPool(pool)) revert PoolNotRegistered();
        _;
    }

    constructor(address factory_, address usdc_) {
        factory = IEXNIHILOFactory(factory_);
        usdc    = IERC20(usdc_);
    }

    /// @dev Replicates the pool's fee calculation (base + OI-integral impact)
    ///      so the router pulls exactly what the pool will consume.
    function _positionFee(uint256 notional, address pool, bool isLong) internal view returns (uint256) {
        uint256 fee = (notional * PROTOCOL_FEE_BPS) / BPS_DENOM
                    + (notional * LP_FEE_BPS)       / BPS_DENOM;
        if (fee < MIN_POSITION_FEE) {
            fee = MIN_POSITION_FEE;
        }
        // OI-integral impact fee — must match EXNIHILOPool.openLong / openShort.
        uint256 backedUsd = IEXNIHILOPool(pool).backedAirUsd();
        uint256 oi = isLong
            ? IEXNIHILOPool(pool).longOpenInterest()
            : IEXNIHILOPool(pool).shortOpenInterest();
        uint256 impactFee = (IMPACT_FEE_BPS * notional * (2 * oi + notional))
                          / (2 * backedUsd * BPS_DENOM);
        return fee + impactFee;
    }

    /// @notice Open a long position on `pool`. Caller must have approved USDC to this router.
    function openLong(
        address pool,
        uint256 usdcAmount,
        uint256 minAirTokenOut
    ) external onlyPool(pool) {
        uint256 fee = _positionFee(usdcAmount, pool, true);
        usdc.safeTransferFrom(msg.sender, address(this), fee);
        usdc.forceApprove(pool, fee);
        IEXNIHILOPool(pool).openLong(usdcAmount, minAirTokenOut, msg.sender);
        usdc.forceApprove(pool, 0);
    }

    /// @notice Open a short position on `pool`. Caller must have approved USDC to this router.
    function openShort(
        address pool,
        uint256 usdcNotional,
        uint256 minAirUsdOut
    ) external onlyPool(pool) {
        uint256 fee = _positionFee(usdcNotional, pool, false);
        usdc.safeTransferFrom(msg.sender, address(this), fee);
        usdc.forceApprove(pool, fee);
        IEXNIHILOPool(pool).openShort(usdcNotional, minAirUsdOut, msg.sender);
        usdc.forceApprove(pool, 0);
    }

    /// @notice Swap tokens via `pool`. Caller must have approved the input token to this router.
    function swap(
        address pool,
        uint256 amountIn,
        uint256 minAmountOut,
        bool tokenToUsdc
    ) external onlyPool(pool) {
        IERC20 tokenIn = tokenToUsdc
            ? IEXNIHILOPool(pool).underlyingToken()
            : usdc;

        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        tokenIn.forceApprove(pool, amountIn);
        IEXNIHILOPool(pool).swap(amountIn, minAmountOut, tokenToUsdc, msg.sender);
        tokenIn.forceApprove(pool, 0);
    }
}
