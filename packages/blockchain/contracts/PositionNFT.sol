// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title PositionNFT
 * @notice Manages both Long and Short position tokens for all EXNIHILO pools.
 *
 * Custody model
 * ─────────────
 * When a position is opened the pool approves this contract to pull the locked
 * wrapper tokens, then calls mintLong / mintShort.  The tokens live here for
 * the lifetime of the position.
 *
 * When a position is settled (close, realize, or LP liquidation) the pool calls
 * release(), which burns the NFT and returns the locked tokens to the pool.
 * The returned Position struct gives the pool everything it needs to emit the
 * correct event and complete the settlement math.
 *
 * Access control
 * ──────────────
 * mintLong / mintShort  →  msg.sender must equal the `pool` argument.
 * release               →  msg.sender must equal positions[tokenId].pool.
 */
interface IEXNIHILOPool {
    function backedAirToken()  external view returns (uint256);
    function backedAirUsd()   external view returns (uint256);
    function airToken()   external view returns (address);
    function airUsdToken()    external view returns (address);
    function underlyingToken() external view returns (address);
}

interface ITokenMeta {
    function totalSupply() external view returns (uint256);
    function symbol()      external view returns (string memory);
}

contract PositionNFT is ERC721Enumerable {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    // ── Position data ──────────────────────────────────────────────────────────

    struct Position {
        bool isLong;
        address pool;
        /// @dev airToken for longs, airUsd for shorts
        address lockedToken;
        /// @dev airTokenLocked for longs, airUsdLocked for shorts
        uint256 lockedAmount;
        /// @dev Long only: USDC notional used to open the position
        uint256 usdcIn;
        /// @dev Long only: synthetic airUsd debt minted at open
        uint256 airUsdMinted;
        /// @dev Short only: synthetic airToken debt minted at open
        uint256 airTokenMinted;
        uint256 feesPaid;
        uint256 openedAt;
    }

    /// @dev Live pool data resolved at tokenURI call time.
    struct LiveData {
        string tokenSymbol;   // underlying token symbol, e.g. "PEPE"
        bool   pnlReady;     // false if pool state unavailable
        bool   pnlPositive;
        uint256 pnlAbs;      // abs PnL in USDC 6-dec units
    }

    // ── State ──────────────────────────────────────────────────────────────────

    uint256 private _nextTokenId;
    mapping(uint256 => Position) private _positions;

    // ── Errors ─────────────────────────────────────────────────────────────────

    error OnlyPool();
    error PositionNotFound();
    error PositionNotFromPool();

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor() ERC721("EXNIHILO Position", "EXPOS") {}

    // ── Views ──────────────────────────────────────────────────────────────────

    /**
     * @notice Returns the full position data for `tokenId`.
     * @dev Reverts if the token does not exist.
     */
    function getPosition(uint256 tokenId) external view returns (Position memory) {
        if (_positions[tokenId].pool == address(0)) revert PositionNotFound();
        return _positions[tokenId];
    }

    /**
     * @notice Fully on-chain SVG metadata.  Live PnL is computed from current
     *         pool reserves — no external data source required.
     */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (_positions[tokenId].pool == address(0)) revert PositionNotFound();
        Position memory pos = _positions[tokenId];

        LiveData memory ld = _readLive(pos);

        bytes memory svg  = _buildSVG(tokenId, pos, ld);
        bytes memory json = abi.encodePacked(
            '{"name":"EXNIHILO Position #', tokenId.toString(),
            '","description":"EXNIHILO - Out of Thin Air',
            pos.isLong ? "long" : "short",
            ' position. Fully on-chain.",',
            '"image":"data:image/svg+xml;base64,', Base64.encode(svg), '"}'
        );

        return string(abi.encodePacked(
            "data:application/json;base64,",
            Base64.encode(json)
        ));
    }

    // ── Mint ───────────────────────────────────────────────────────────────────

    function mintLong(
        address to,
        address pool,
        address airToken,
        uint256 usdcIn,
        uint256 airUsdMinted,
        uint256 airTokenLocked,
        uint256 feesPaid
    ) external returns (uint256 tokenId) {
        if (msg.sender != pool) revert OnlyPool();

        IERC20(airToken).safeTransferFrom(pool, address(this), airTokenLocked);

        tokenId = _nextTokenId++;
        _positions[tokenId] = Position({
            isLong: true,
            pool: pool,
            lockedToken: airToken,
            lockedAmount: airTokenLocked,
            usdcIn: usdcIn,
            airUsdMinted: airUsdMinted,
            airTokenMinted: 0,
            feesPaid: feesPaid,
            openedAt: block.timestamp
        });

        _safeMint(to, tokenId);
    }

    function mintShort(
        address to,
        address pool,
        address airUsdToken,
        uint256 airTokenMinted,
        uint256 airUsdLocked,
        uint256 feesPaid
    ) external returns (uint256 tokenId) {
        if (msg.sender != pool) revert OnlyPool();

        IERC20(airUsdToken).safeTransferFrom(pool, address(this), airUsdLocked);

        tokenId = _nextTokenId++;
        _positions[tokenId] = Position({
            isLong: false,
            pool: pool,
            lockedToken: airUsdToken,
            lockedAmount: airUsdLocked,
            usdcIn: 0,
            airUsdMinted: 0,
            airTokenMinted: airTokenMinted,
            feesPaid: feesPaid,
            openedAt: block.timestamp
        });

        _safeMint(to, tokenId);
    }

    // ── Release ────────────────────────────────────────────────────────────────

    function release(uint256 tokenId) external returns (Position memory position) {
        position = _positions[tokenId];
        if (position.pool == address(0)) revert PositionNotFound();
        if (msg.sender != position.pool) revert PositionNotFromPool();

        delete _positions[tokenId];
        _burn(tokenId);

        IERC20(position.lockedToken).safeTransfer(position.pool, position.lockedAmount);
    }

    // ── Live data reader ───────────────────────────────────────────────────────

    /**
     * @dev Reads current pool reserves to compute live PnL and token symbol.
     *      All external calls are wrapped in try/catch so tokenURI never reverts
     *      due to pool state issues.
     *
     *      Long PnL:
     *        airUsdOut = lockedAmount * backedAirUsd / airToken.totalSupply()
     *        pnl       = int(airUsdOut) - int(airUsdMinted)
     *
     *      Short PnL (cpAmountIn ceiling approximation):
     *        denom     = backedAirToken - airTokenMinted
     *        cost      = ceil(airUsd.totalSupply() * airTokenMinted / denom)
     *        pnl       = int(lockedAmount) - int(cost)
     */
    function _readLive(Position memory pos) internal view returns (LiveData memory ld) {
        // Token symbol (best-effort)
        try IEXNIHILOPool(pos.pool).underlyingToken() returns (address token) {
            try ITokenMeta(token).symbol() returns (string memory sym) {
                ld.tokenSymbol = sym;
            } catch { ld.tokenSymbol = "TOKEN"; }
        } catch { ld.tokenSymbol = "TOKEN"; }

        // Pool reserves for PnL
        try IEXNIHILOPool(pos.pool).backedAirToken() returns (uint256 bam) {
            uint256 bau         = IEXNIHILOPool(pos.pool).backedAirUsd();
            address airTokenAddr = IEXNIHILOPool(pos.pool).airToken();
            address airUsdAddr  = IEXNIHILOPool(pos.pool).airUsdToken();
            uint256 airTokenSup  = ITokenMeta(airTokenAddr).totalSupply();
            uint256 airUsdSup   = ITokenMeta(airUsdAddr).totalSupply();

            if (pos.isLong) {
                if (airTokenSup > 0) {
                    uint256 airUsdOut = (pos.lockedAmount * bau) / airTokenSup;
                    int256  raw       = int256(airUsdOut) - int256(pos.airUsdMinted);
                    ld.pnlReady    = true;
                    ld.pnlPositive = raw >= 0;
                    ld.pnlAbs      = raw >= 0 ? uint256(raw) : uint256(-raw);
                }
            } else {
                uint256 denom = bam > pos.airTokenMinted ? bam - pos.airTokenMinted : 0;
                if (denom > 0) {
                    uint256 cost = (airUsdSup * pos.airTokenMinted + denom - 1) / denom;
                    int256  raw  = int256(pos.lockedAmount) - int256(cost);
                    ld.pnlReady    = true;
                    ld.pnlPositive = raw >= 0;
                    ld.pnlAbs      = raw >= 0 ? uint256(raw) : uint256(-raw);
                }
            }
        } catch { /* pnlReady stays false */ }
    }

    // ── SVG builder ────────────────────────────────────────────────────────────

    function _buildSVG(
        uint256 tokenId,
        Position memory pos,
        LiveData memory ld
    ) internal pure returns (bytes memory) {
        string memory sc = pos.isLong ? "#00ff88" : "#ff3b30";
        string memory sl = pos.isLong ? "LONG"    : "SHORT";

        return abi.encodePacked(
            _svgOpen(),
            _svgChrome(tokenId, sc, sl),
            pos.isLong ? _svgLongData(pos, ld) : _svgShortData(pos, ld),
            _svgPnl(ld),
            _svgFooter(pos),
            "</svg>"
        );
    }

    function _svgOpen() internal pure returns (bytes memory) {
        // CSS animations split across two encodePacked calls to stay within
        // the 16-argument limit.
        bytes memory styles = abi.encodePacked(
            "<defs><style>",
            ".f{font-family:'Courier New',Courier,monospace;}",
            ".lbl{font-size:9;letter-spacing:2;fill:#555;}",
            ".val{font-size:13;fill:#ccc;}",
            // Glitch cyan — exact keyframes from the website
            "@keyframes gc{",
            "0%,87%,100%{clip-path:inset(0 0 100% 0);opacity:0;transform:translateX(0)}",
            "88%{clip-path:inset(8% 0 52% 0);opacity:1;transform:translateX(-4px)}",
            "89%{clip-path:inset(30% 0 28% 0);opacity:1;transform:translateX(3px)}",
            "90%{clip-path:inset(68% 0 4% 0);opacity:1;transform:translateX(-2px)}",
            "91%{clip-path:inset(0 0 100% 0);opacity:0;transform:translateX(0)}}",
            // Glitch red
            "@keyframes gr{",
            "0%,89%,100%{clip-path:inset(0 0 100% 0);opacity:0;transform:translateX(0)}",
            "90%{clip-path:inset(48% 0 12% 0);opacity:1;transform:translateX(4px)}",
            "91%{clip-path:inset(12% 0 62% 0);opacity:1;transform:translateX(-3px)}",
            "92%{clip-path:inset(78% 0 0% 0);opacity:1;transform:translateX(2px)}",
            "93%{clip-path:inset(0 0 100% 0);opacity:0;transform:translateX(0)}}",
            ".gc{animation:gc 8s infinite;fill:#00e5ff;transform-box:fill-box;}",
            ".gr{animation:gr 8s infinite;fill:#ff3b30;transform-box:fill-box;}",
            "</style></defs>"
        );

        bytes memory chrome = abi.encodePacked(
            '<rect width="400" height="440" fill="#000"/>',
            '<rect x="1" y="1" width="398" height="438" fill="none" stroke="#1a1a1a"/>',
            '<polyline points="1,20 1,1 20,1"           fill="none" stroke="#00e5ff" stroke-width="1.5"/>',
            '<polyline points="380,1 399,1 399,20"       fill="none" stroke="#00e5ff" stroke-width="1.5"/>',
            '<polyline points="1,420 1,439 20,439"       fill="none" stroke="#00e5ff" stroke-width="1.5"/>',
            '<polyline points="380,439 399,439 399,420"  fill="none" stroke="#00e5ff" stroke-width="1.5"/>'
        );

        // Three-layer glitch title: cyan behind, red behind, white on top
        bytes memory title = abi.encodePacked(
            '<text x="20" y="42" class="f gc" font-size="26" letter-spacing="6" font-weight="bold">EXNIHILO</text>',
            '<text x="20" y="42" class="f gr" font-size="26" letter-spacing="6" font-weight="bold">EXNIHILO</text>',
            '<text x="20" y="42" class="f"    font-size="26" letter-spacing="6" fill="#fff" font-weight="bold">EXNIHILO</text>',
            '<text x="20" y="58" class="f" font-size="9" letter-spacing="3" fill="#00e5ff">POSITION CERTIFICATE</text>',
            '<line x1="20" y1="70" x2="380" y2="70" stroke="#1a1a1a"/>'
        );

        return abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 440">',
            styles,
            chrome,
            title
        );
    }

    function _svgChrome(
        uint256 tokenId,
        string memory sc,
        string memory sl
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            '<rect x="20" y="82" width="56" height="20" fill="', sc, '" fill-opacity="0.08"/>',
            '<rect x="20" y="82" width="56" height="20" fill="none" stroke="', sc, '" stroke-opacity="0.35"/>',
            '<text x="48" y="96" class="f" font-size="10" letter-spacing="2" fill="', sc, '" text-anchor="middle">', sl, "</text>",
            '<text x="380" y="96" class="f" font-size="10" fill="#3a3a3a" text-anchor="end">#', tokenId.toString(), "</text>",
            '<line x1="20" y1="114" x2="380" y2="114" stroke="#1a1a1a"/>'
        );
    }

    function _svgLongData(Position memory pos, LiveData memory ld) internal pure returns (bytes memory) {
        string memory lockedLabel = string(abi.encodePacked("LOCKED ", ld.tokenSymbol));
        return abi.encodePacked(
            '<text x="20"  y="136" class="f lbl">POSITION SIZE</text>',
            '<text x="210" y="136" class="f lbl">', lockedLabel, "</text>",
            '<text x="20"  y="156" class="f val">', _fmt6(pos.usdcIn),        "</text>",
            '<text x="210" y="156" class="f val">', _fmt18(pos.lockedAmount), "</text>",
            '<text x="20"  y="196" class="f lbl">FEES PAID</text>',
            '<text x="20"  y="216" class="f val">', _fmt6(pos.feesPaid), "</text>"
        );
    }

    function _svgShortData(Position memory pos, LiveData memory ld) internal pure returns (bytes memory) {
        // suppress unused warning — ld used for PnL section only
        ld;
        return abi.encodePacked(
            '<text x="20"  y="136" class="f lbl">LOCKED USDC</text>',
            '<text x="20"  y="156" class="f val">', _fmt6(pos.lockedAmount), "</text>",
            '<text x="20"  y="196" class="f lbl">FEES PAID</text>',
            '<text x="20"  y="216" class="f val">', _fmt6(pos.feesPaid),     "</text>"
        );
    }

    function _svgPnl(LiveData memory ld) internal pure returns (bytes memory) {
        string memory pnlColor;
        string memory pnlText;

        if (!ld.pnlReady) {
            pnlColor = "#555555";
            pnlText  = "N/A";
        } else if (ld.pnlPositive) {
            pnlColor = "#00ff88";
            pnlText  = string(abi.encodePacked("+$", _fmt6(ld.pnlAbs)));
        } else {
            pnlColor = "#ff3b30";
            pnlText  = string(abi.encodePacked("-$", _fmt6(ld.pnlAbs)));
        }

        return abi.encodePacked(
            '<line x1="20" y1="244" x2="380" y2="244" stroke="#1a1a1a"/>',
            '<text x="200" y="268" class="f lbl" text-anchor="middle" letter-spacing="4">EST. P&amp;L</text>',
            '<text x="200" y="310" class="f" font-size="32" font-weight="bold" fill="', pnlColor, '" text-anchor="middle" letter-spacing="2">', pnlText, "</text>",
            '<line x1="20" y1="334" x2="380" y2="334" stroke="#1a1a1a"/>'
        );
    }

    function _svgFooter(Position memory pos) internal pure returns (bytes memory) {
        return abi.encodePacked(
            '<text x="20" y="356" class="f lbl">OPENED</text>',
            '<text x="20" y="374" class="f" font-size="11" fill="#444">', _fmtDate(pos.openedAt), "</text>"
        );
    }

    // ── Formatters ─────────────────────────────────────────────────────────────

    function _fmt6(uint256 v) internal pure returns (string memory) {
        uint256 whole = v / 1e6;
        uint256 frac  = (v % 1e6) / 1e4;
        if (frac < 10) return string(abi.encodePacked(whole.toString(), ".0", frac.toString()));
        return string(abi.encodePacked(whole.toString(), ".", frac.toString()));
    }

    function _fmt18(uint256 v) internal pure returns (string memory) {
        uint256 whole = v / 1e18;
        uint256 frac  = (v % 1e18) / 1e14;
        bytes memory fracB = bytes(frac.toString());
        string memory pad = fracB.length == 1 ? "000"
                          : fracB.length == 2 ? "00"
                          : fracB.length == 3 ? "0"
                          : "";
        return string(abi.encodePacked(whole.toString(), ".", pad, frac.toString()));
    }

    function _fmtDate(uint256 ts) internal pure returns (string memory) {
        (uint256 y, uint256 mo, uint256 d) = _tsToYMD(ts);
        return string(abi.encodePacked(
            y.toString(), "-",
            mo < 10 ? "0" : "", mo.toString(), "-",
            d  < 10 ? "0" : "", d.toString()
        ));
    }

    function _tsToYMD(uint256 ts) internal pure returns (uint256 year, uint256 month, uint256 day) {
        int256 z   = int256(ts / 86400) + 719468;
        int256 era = (z >= 0 ? z : z - 146096) / 146097;
        int256 doe = z - era * 146097;
        int256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        int256 y   = yoe + era * 400;
        int256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        int256 mp  = (5 * doy + 2) / 153;
        int256 d_  = doy - (153 * mp + 2) / 5 + 1;
        int256 m   = mp < 10 ? mp + 3 : mp - 9;
        if (m <= 2) y += 1;
        year  = uint256(y);
        month = uint256(m);
        day   = uint256(d_);
    }
}
