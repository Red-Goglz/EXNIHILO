// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IPoolManip {
    function swap(uint256 amountIn, uint256 minAmountOut, bool tokenToUsdc, address recipient) external;
    function openLong(uint256 usdcAmount, uint256 minAirTokenOut, address recipient) external;
    function openShort(uint256 usdcNotional, uint256 minAirUsdOut, address recipient) external;
    function closeLong(uint256 nftId, uint256 minUsdcOut, address to) external;
    function closeShort(uint256 nftId, uint256 minUsdcOut, address to) external;
    function sweepDust(uint256 nftId) external;
    function backedAirToken() external view returns (uint256);
    function backedAirUsd() external view returns (uint256);
    function effectiveLeverageCap() external view returns (uint256);
}

/**
 * @title  AtomicManipulator
 * @notice Test-only: moves the price and trades against the move inside one
 *         transaction. Swaps are split into `j` chunks, which keeps the spot-value
 *         swap fee near 1 % of output.
 */
contract AtomicManipulator is IERC721Receiver {
    IPoolManip public immutable pool;
    IERC20 public immutable usdc;
    IERC20 public immutable token;

    uint256 public lastId;
    uint256[] public held;
    bool public heldLong;

    constructor(address pool_, address usdc_, address token_) {
        pool = IPoolManip(pool_);
        usdc = IERC20(usdc_);
        token = IERC20(token_);
        IERC20(usdc_).approve(pool_, type(uint256).max);
        IERC20(token_).approve(pool_, type(uint256).max);
    }

    /// @notice `k` shorts, dump `dump` tokens, close them all, buy the dump back.
    function shortDumpClose(uint256 notional, uint256 k, uint256 dump, uint256 j) external {
        uint256[] memory ids = new uint256[](k);
        for (uint256 i; i < k; i++) ids[i] = _openShort(notional);
        uint256 sold = _dump(dump, j);
        for (uint256 i; i < k; i++) pool.closeShort(ids[i], 0, address(this));
        _rebuy(sold, j);
    }

    /// @notice A long, pump with `pump` USDC, close, sell the pumped tokens back.
    function longPumpClose(uint256 notional, uint256 pump, uint256 j) external {
        uint256 t0 = token.balanceOf(address(this));
        pool.openLong(notional, 0, address(this));
        uint256 id = lastId;
        _pump(pump, j);
        pool.closeLong(id, 0, address(this));
        _sell(token.balanceOf(address(this)) - t0, j);
    }

    /// @notice Pump, open `k` shorts at the moved price, unpump. Closed later by closeHeld.
    function pumpOpenShort(uint256 pump, uint256 notional, uint256 k, uint256 j) external {
        uint256 t0 = token.balanceOf(address(this));
        _pump(pump, j);
        for (uint256 i; i < k; i++) held.push(_openShort(notional));
        heldLong = false;
        _sell(token.balanceOf(address(this)) - t0, j);
    }

    /// @notice Dump, open a long at the moved price, buy the dump back. Closed later.
    function dumpOpenLong(uint256 dump, uint256 notional, uint256 j) external {
        uint256 sold = _dump(dump, j);
        uint256 cap = pool.effectiveLeverageCap();
        pool.openLong(notional < cap ? notional : cap, 0, address(this));
        held.push(lastId);
        heldLong = true;
        _rebuy(sold, j);
    }

    function closeHeld() external {
        for (uint256 i; i < held.length; i++) {
            if (heldLong) pool.closeLong(held[i], 0, address(this));
            else pool.closeShort(held[i], 0, address(this));
        }
        delete held;
    }

    /// @notice Sweep the pool's last position, flushing it, then open a long in the same block.
    function sweepThenOpenLong(uint256 dustId, uint256 notional) external {
        pool.sweepDust(dustId);
        pool.openLong(notional, 0, address(this));
    }

    function _openShort(uint256 notional) internal returns (uint256) {
        uint256 cap = pool.effectiveLeverageCap();
        pool.openShort(notional < cap ? notional : cap, 0, address(this));
        return lastId;
    }

    function _dump(uint256 amount, uint256 j) internal returns (uint256 sold) {
        for (uint256 i; i < j; i++) pool.swap(amount / j, 0, true, address(this));
        sold = (amount / j) * j;
    }

    function _pump(uint256 amount, uint256 j) internal {
        for (uint256 i; i < j; i++) pool.swap(amount / j, 0, false, address(this));
    }

    function _sell(uint256 amount, uint256 j) internal {
        for (uint256 i; i < j; i++) {
            uint256 a = amount / (j - i);
            pool.swap(a, 0, true, address(this));
            amount -= a;
        }
    }

    /// @dev Buy back at least `sold` tokens in `j` swaps.
    function _rebuy(uint256 sold, uint256 j) internal {
        uint256 got;
        for (uint256 i; i < j; i++) {
            uint256 want = (sold - got) / (j - i);
            uint256 t0 = token.balanceOf(address(this));
            pool.swap(_usdcFor(want), 0, false, address(this));
            got += token.balanceOf(address(this)) - t0;
        }
    }

    /// @dev Mirrors EXNIHILOPool._cpAmountOut at a 1 % fee.
    function _cp(uint256 a, uint256 ri, uint256 ro) internal pure returns (uint256) {
        uint256 raw = a * ro / (ri + a);
        uint256 fn = a * ro * 100;
        uint256 fd = ri * 10_000;
        uint256 fee = fn == 0 ? 0 : (fn + fd - 1) / fd;
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

    function onERC721Received(address, address, uint256 tokenId, bytes calldata)
        external
        returns (bytes4)
    {
        lastId = tokenId;
        return IERC721Receiver.onERC721Received.selector;
    }
}
