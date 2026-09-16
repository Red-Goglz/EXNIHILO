// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

interface IEXNIHILOPool {
    function underlyingToken() external view returns (address);
    function quoteClose(uint256 nftId) external view returns (bool ready, int256 pnl);
    function liveAmountsOf(uint256 nftId)
        external view returns (uint256 locked, uint256 debt, uint256 notional);
    function remainingSizeBps(uint256 nftId) external view returns (uint256);
}

interface ITokenMeta {
    function totalSupply() external view returns (uint256);
    function symbol()      external view returns (string memory);
    function decimals()    external view returns (uint8);
}

interface IEXNIHILOFactory {
    function isPool(address pool) external view returns (bool);
}

/**
 * @title  PositionNFT
 * @notice Long and short position registry for all EXNIHILO pools. Collateral stays
 *         in the pool; only registered pools mint, and only a position's own pool
 *         releases it. tokenURI renders a live on-chain SVG.
 */
contract PositionNFT is ERC721Enumerable {
    using Strings for uint256;

    // ── Position data ──────────────────────────────────────────────────────────

    // Amounts are as at open; live figures come from EXNIHILOPool.liveAmountsOf().
    struct Position {
        bool isLong;
        address pool;
        uint256 lockedAmountAtOpen; // airToken (long) / airUsd (short)
        uint256 usdcIn;             // USDC notional
        uint256 airUsdMinted;       // long debt
        uint256 airTokenMinted;     // short debt
        uint256 feesPaid;
        uint256 openedAt;
        uint256 fundingIndexAtOpen; // side's funding index at mint, in RAY
    }

    struct LiveData {
        string tokenSymbol;
        bool   pnlReady;      // pool returned a usable quote
        bool   pnlPositive;
        uint256 pnlAbs;       // USDC (6 dec), net of the close fee
        uint8  tokenDecimals;
        uint256 locked;       // live, net of funding
        uint256 debt;         // live, net of funding
        uint256 notional;     // live, net of funding
        uint256 remainingBps;
    }

    // ── State ──────────────────────────────────────────────────────────────────

    uint256 private _nextTokenId;
    mapping(uint256 => Position) private _positions;

    address private immutable _deployer;

    /// @notice Pool registry consulted on mint; set once by the deployer.
    address public factory;

    // ── Errors ─────────────────────────────────────────────────────────────────

    error OnlyPool();
    error OnlyDeployer();
    error FactoryAlreadySet();
    error FactoryNotSet();
    error ZeroAddress();
    error PositionNotFound();
    error PositionNotFromPool();
    error OnlyTokenOwner();

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor() ERC721("EXNIHILO Position", "EXPOS") {
        _deployer = msg.sender;
    }

    // ── Events ─────────────────────────────────────────────────────────────────

    event FactoryInitialized(address indexed factory);

    // ── Factory initialisation ────────────────────────────────────────────────

    /// @notice One-time wiring to the factory whose pools may mint. Deployer only.
    function initFactory(address factory_) external {
        if (msg.sender != _deployer) revert OnlyDeployer();
        if (factory != address(0)) revert FactoryAlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactoryInitialized(factory_);
    }

    // ── Views ──────────────────────────────────────────────────────────────────

    /// @notice Opening data for `tokenId`; reverts if it does not exist.
    function getPosition(uint256 tokenId) external view returns (Position memory) {
        if (_positions[tokenId].pool == address(0)) revert PositionNotFound();
        return _positions[tokenId];
    }

    /// @notice On-chain JSON metadata and SVG, with live PnL from the pool.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (_positions[tokenId].pool == address(0)) revert PositionNotFound();
        Position memory pos = _positions[tokenId];

        LiveData memory ld = _readLive(tokenId, pos);

        bytes memory svg  = _buildSVG(tokenId, pos, ld);
        bytes memory json = abi.encodePacked(
            '{"name":"', ld.tokenSymbol, pos.isLong ? " LONG" : " SHORT",
            ' #', tokenId.toString(),
            '","description":"EXNIHILO - Out of Thin Air. ',
            ld.tokenSymbol, '/USDC ',
            pos.isLong ? "long" : "short",
            ' position. Fully on-chain.",',
            '"image":"data:image/svg+xml;base64,', Base64.encode(svg), '",'
        );

        json = abi.encodePacked(json, _buildAttributes(tokenId, pos, ld), '}');

        return string(abi.encodePacked(
            "data:application/json;base64,",
            Base64.encode(json)
        ));
    }

    /// @dev Net return on the premium (feesPaid is the trader's whole stake). The
    ///      payout floors at zero, so the loss floors at −100 %.
    function _netReturn(Position memory pos, LiveData memory ld)
        internal
        pure
        returns (bool up, uint256 usdcAbs, uint256 pct)
    {
        uint256 payout  = ld.pnlPositive ? ld.pnlAbs : 0;
        uint256 premium = pos.feesPaid;

        if (payout >= premium) {
            up      = true;
            usdcAbs = payout - premium;
        } else {
            usdcAbs = premium - payout;
        }

        pct = premium == 0 ? 0 : (usdcAbs * 100) / premium;
    }

    function _buildAttributes(
        uint256 tokenId,
        Position memory pos,
        LiveData memory ld
    ) internal pure returns (bytes memory) {
        // Chunked to stay within the encodePacked argument limit.
        bytes memory a1 = abi.encodePacked(
            '"attributes":[',
            '{"trait_type":"Side","value":"', pos.isLong ? "Long" : "Short", '"},',
            '{"trait_type":"Market","value":"', ld.tokenSymbol, '/USDC"},',
            '{"trait_type":"Token ID","display_type":"number","value":', tokenId.toString(), '},',
            '{"trait_type":"Position Size (USDC)","display_type":"number","value":', _fmt6(ld.notional), '},'
        );

        bytes memory a2 = pos.isLong
            ? abi.encodePacked(
                '{"trait_type":"Locked ', ld.tokenSymbol, '","display_type":"number","value":', _fmtToken(ld.locked, ld.tokenDecimals), '},',
                '{"trait_type":"Debt (airUSD)","display_type":"number","value":', _fmt6(ld.debt), '},'
            )
            : abi.encodePacked(
                '{"trait_type":"Locked USDC","display_type":"number","value":', _fmt6(ld.locked), '},',
                '{"trait_type":"Debt (airToken)","display_type":"number","value":', _fmtToken(ld.debt, ld.tokenDecimals), '},'
            );

        bytes memory a3 = abi.encodePacked(
            '{"trait_type":"Fees Paid (USDC)","display_type":"number","value":', _fmt6(pos.feesPaid), '},',
            '{"trait_type":"Opened","display_type":"date","value":', pos.openedAt.toString(), '},',
            '{"trait_type":"Size Remaining %","display_type":"number","value":', (ld.remainingBps / 100).toString(), '},'
        );

        bytes memory pnlAttr;
        if (ld.pnlReady) {
            (bool up, uint256 usdcAbs, uint256 pct) = _netReturn(pos, ld);
            pnlAttr = abi.encodePacked(
                '{"trait_type":"Est. PnL (USDC)","display_type":"number","value":',
                up ? "" : "-",
                _fmt6(usdcAbs), '},',
                '{"trait_type":"Return on Premium %","display_type":"number","value":',
                up ? "" : "-",
                pct.toString(), '}'
            );
        } else {
            pnlAttr = bytes('{"trait_type":"Est. PnL","value":"N/A"}');
        }

        return abi.encodePacked(a1, a2, a3, pnlAttr, ']');
    }

    // ── Mint / release (pools only) ────────────────────────────────────────────

    function mintLong(
        address to,
        address pool,
        uint256 usdcIn,
        uint256 airUsdMinted,
        uint256 airTokenLocked,
        uint256 feesPaid,
        uint256 fundingIndexAtOpen
    ) external returns (uint256 tokenId) {
        if (factory == address(0)) revert FactoryNotSet();
        if (msg.sender != pool) revert OnlyPool();
        if (!IEXNIHILOFactory(factory).isPool(pool)) revert OnlyPool();

        tokenId = _nextTokenId++;
        _positions[tokenId] = Position({
            isLong: true,
            pool: pool,
            lockedAmountAtOpen: airTokenLocked,
            usdcIn: usdcIn,
            airUsdMinted: airUsdMinted,
            airTokenMinted: 0,
            feesPaid: feesPaid,
            openedAt: block.timestamp,
            fundingIndexAtOpen: fundingIndexAtOpen
        });

        _safeMint(to, tokenId);
    }

    function mintShort(
        address to,
        address pool,
        uint256 airTokenMinted,
        uint256 airUsdLocked,
        uint256 usdcIn,
        uint256 feesPaid,
        uint256 fundingIndexAtOpen
    ) external returns (uint256 tokenId) {
        if (factory == address(0)) revert FactoryNotSet();
        if (msg.sender != pool) revert OnlyPool();
        if (!IEXNIHILOFactory(factory).isPool(pool)) revert OnlyPool();

        tokenId = _nextTokenId++;
        _positions[tokenId] = Position({
            isLong: false,
            pool: pool,
            lockedAmountAtOpen: airUsdLocked,
            usdcIn: usdcIn,
            airUsdMinted: 0,
            airTokenMinted: airTokenMinted,
            feesPaid: feesPaid,
            openedAt: block.timestamp,
            fundingIndexAtOpen: fundingIndexAtOpen
        });

        _safeMint(to, tokenId);
    }

    function release(uint256 tokenId) external returns (Position memory position) {
        position = _positions[tokenId];
        if (position.pool == address(0)) revert PositionNotFound();
        if (msg.sender != position.pool) revert PositionNotFromPool();

        delete _positions[tokenId];
        _burn(tokenId);
    }

    // ── Live data ──────────────────────────────────────────────────────────────

    /// @dev Best-effort pool reads; every call is try/catch so tokenURI never reverts.
    function _readLive(uint256 tokenId, Position memory pos) internal view returns (LiveData memory ld) {
        ld.tokenDecimals = 18; // safe default

        // Opening figures as the fallback if the pool call fails.
        ld.locked       = pos.lockedAmountAtOpen;
        ld.debt         = pos.isLong ? pos.airUsdMinted : pos.airTokenMinted;
        ld.notional     = pos.usdcIn;
        ld.remainingBps = 10_000;
        try IEXNIHILOPool(pos.pool).liveAmountsOf(tokenId) returns (
            uint256 liveLocked, uint256 liveDebt, uint256 liveNotional
        ) {
            ld.locked   = liveLocked;
            ld.debt     = liveDebt;
            ld.notional = liveNotional;
            try IEXNIHILOPool(pos.pool).remainingSizeBps(tokenId) returns (uint256 bps) {
                ld.remainingBps = bps;
            } catch {}
        } catch {}

        try IEXNIHILOPool(pos.pool).underlyingToken() returns (address token) {
            try ITokenMeta(token).symbol() returns (string memory sym) {
                ld.tokenSymbol = sym;
            } catch { ld.tokenSymbol = "TOKEN"; }
            try ITokenMeta(token).decimals() returns (uint8 d) {
                ld.tokenDecimals = d;
            } catch {}
        } catch { ld.tokenSymbol = "TOKEN"; }

        // !ready still carries the estimated shortfall; only a failed or zero
        // quote renders "N/A".
        try IEXNIHILOPool(pos.pool).quoteClose(tokenId) returns (bool ready, int256 pnl) {
            ld.pnlReady    = ready || pnl != 0;
            ld.pnlPositive = ready && pnl >= 0;
            ld.pnlAbs      = pnl >= 0 ? uint256(pnl) : uint256(-pnl);
        } catch { /* pnlReady stays false */ }
    }

    // ── SVG ────────────────────────────────────────────────────────────────────

    function _buildSVG(
        uint256 tokenId,
        Position memory pos,
        LiveData memory ld
    ) internal pure returns (bytes memory) {
        string memory sc = pos.isLong ? "#00ff88" : "#ff3b30";
        string memory sl = pos.isLong ? "LONG"    : "SHORT";

        return abi.encodePacked(
            _svgOpen(),
            _svgChrome(tokenId, sc, sl, ld.tokenSymbol),
            pos.isLong ? _svgLongData(pos, ld) : _svgShortData(pos, ld),
            _svgPnl(pos, ld),
            _svgFooter(pos, ld),
            "</svg>"
        );
    }

    function _svgOpen() internal pure returns (bytes memory) {
        bytes memory styles = abi.encodePacked(
            "<defs><style>",
            ".f{font-family:'Courier New',Courier,monospace;}",
            ".lbl{font-size:13;letter-spacing:2;fill:#8a8a8a;}",
            ".val{font-size:20;fill:#e8e8e8;}",
            ".dat{font-size:16;fill:#999;}",
            // glitch cyan
            "@keyframes gc{",
            "0%,87%,100%{clip-path:inset(0 0 100% 0);opacity:0;transform:translateX(0)}",
            "88%{clip-path:inset(8% 0 52% 0);opacity:1;transform:translateX(-4px)}",
            "89%{clip-path:inset(30% 0 28% 0);opacity:1;transform:translateX(3px)}",
            "90%{clip-path:inset(68% 0 4% 0);opacity:1;transform:translateX(-2px)}",
            "91%{clip-path:inset(0 0 100% 0);opacity:0;transform:translateX(0)}}",
            // glitch red
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

        // 800x450 (16:9) so X renders it uncropped.
        bytes memory chrome = abi.encodePacked(
            '<rect width="800" height="450" fill="#000"/>',
            '<rect x="1" y="1" width="798" height="448" fill="none" stroke="#1a1a1a"/>',
            '<polyline points="1,24 1,1 24,1"            fill="none" stroke="#00e5ff" stroke-width="1.5"/>',
            '<polyline points="776,1 799,1 799,24"       fill="none" stroke="#00e5ff" stroke-width="1.5"/>',
            '<polyline points="1,426 1,449 24,449"       fill="none" stroke="#00e5ff" stroke-width="1.5"/>',
            '<polyline points="776,449 799,449 799,426"  fill="none" stroke="#00e5ff" stroke-width="1.5"/>'
        );

        // Glitch title: cyan and red layers under white.
        bytes memory title = abi.encodePacked(
            '<text x="32" y="58" class="f gc" font-size="32" letter-spacing="8" font-weight="bold">EXNIHILO</text>',
            '<text x="32" y="58" class="f gr" font-size="32" letter-spacing="8" font-weight="bold">EXNIHILO</text>',
            '<text x="32" y="58" class="f"    font-size="32" letter-spacing="8" fill="#fff" font-weight="bold">EXNIHILO</text>',
            '<text x="32" y="80" class="f" font-size="12" letter-spacing="3" fill="#00e5ff">POSITION CERTIFICATE</text>',
            '<line x1="32" y1="96" x2="768" y2="96" stroke="#1a1a1a"/>'
        );

        return abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">',
            styles,
            chrome,
            title
        );
    }

    function _svgChrome(
        uint256 tokenId,
        string memory sc,
        string memory sl,
        string memory tokenSymbol
    ) internal pure returns (bytes memory) {
        string memory market = string(abi.encodePacked(tokenSymbol, " / USDC"));

        bytes memory badge = abi.encodePacked(
            '<rect x="32" y="110" width="74" height="26" fill="', sc, '" fill-opacity="0.08"/>',
            '<rect x="32" y="110" width="74" height="26" fill="none" stroke="', sc, '" stroke-opacity="0.35"/>',
            '<text x="69" y="128" class="f" font-size="13" letter-spacing="2" fill="', sc, '" text-anchor="middle">', sl, "</text>"
        );

        bytes memory head = abi.encodePacked(
            '<text x="120" y="129" class="f" font-size="21" letter-spacing="2" fill="#fff" font-weight="bold">', market, "</text>",
            '<text x="768" y="58" class="f" font-size="14" fill="#666" text-anchor="end">#', tokenId.toString(), "</text>"
        );

        return abi.encodePacked(badge, head);
    }

    // Stats strip columns 1-3; the footer adds 4-5.
    function _svgLongData(Position memory pos, LiveData memory ld) internal pure returns (bytes memory) {
        string memory lockedLabel = string(abi.encodePacked("LOCKED ", ld.tokenSymbol));
        return abi.encodePacked(
            '<text x="32"  y="330" class="f lbl">POSITION SIZE</text>',
            '<text x="196" y="330" class="f lbl">', lockedLabel, "</text>",
            '<text x="360" y="330" class="f lbl">PREMIUM PAID</text>',
            '<text x="32"  y="360" class="f val">', _fmt6(ld.notional),       "</text>",
            '<text x="196" y="360" class="f val">', _fmtToken(ld.locked, ld.tokenDecimals), "</text>",
            '<text x="360" y="360" class="f val">', _fmt6(pos.feesPaid), "</text>"
        );
    }

    function _svgShortData(Position memory pos, LiveData memory ld) internal pure returns (bytes memory) {
        return abi.encodePacked(
            '<text x="32"  y="330" class="f lbl">POSITION SIZE</text>',
            '<text x="196" y="330" class="f lbl">LOCKED USDC</text>',
            '<text x="360" y="330" class="f lbl">PREMIUM PAID</text>',
            '<text x="32"  y="360" class="f val">', _fmt6(ld.notional),     "</text>",
            '<text x="196" y="360" class="f val">', _fmt6(ld.locked), "</text>",
            '<text x="360" y="360" class="f val">', _fmt6(pos.feesPaid),     "</text>"
        );
    }

    function _svgPnl(Position memory pos, LiveData memory ld) internal pure returns (bytes memory) {
        string memory pnlColor;
        string memory pnlText;
        string memory caption = "";

        (bool up, uint256 usdcAbs, uint256 pct) = _netReturn(pos, ld);

        if (!ld.pnlReady) {
            pnlColor = "#8a8a8a";
            pnlText  = "N/A";
            caption  = "POOL CANNOT PRICE THIS POSITION";
        } else if (usdcAbs == 0) {
            pnlColor = "#aaaaaa";
            pnlText  = "$0.00";
            caption  = "NET OF PREMIUM PAID";
        } else {
            // Colour follows the net return, not the payout.
            pnlColor = up ? "#00ff88" : "#ff3b30";
            string memory pctPart = "";
            if (pos.feesPaid > 0) {
                pctPart = string(abi.encodePacked(
                    "  (", up ? "+" : "-", pct.toString(), "%)"
                ));
            }
            pnlText = string(abi.encodePacked(
                up ? "+$" : "-$", _fmt6(usdcAbs), pctPart
            ));
            caption = "NET OF PREMIUM PAID";
        }

        return abi.encodePacked(
            '<text x="400" y="196" class="f lbl" text-anchor="middle" letter-spacing="4">EST. PnL</text>',
            '<text x="400" y="252" class="f" font-size="56" font-weight="bold" fill="', pnlColor, '" text-anchor="middle" letter-spacing="2">', pnlText, "</text>",
            '<text x="400" y="276" class="f" font-size="12" letter-spacing="2" fill="#8a8a8a" text-anchor="middle">', caption, "</text>"
        );
    }

    function _svgFooter(Position memory pos, LiveData memory ld) internal pure returns (bytes memory) {
        return abi.encodePacked(
            '<line x1="32" y1="300" x2="768" y2="300" stroke="#1a1a1a"/>',
            '<text x="524" y="330" class="f lbl">OPENED</text>',
            '<text x="524" y="360" class="f dat">', _fmtDate(pos.openedAt), "</text>",
            '<text x="656" y="330" class="f lbl">SIZE LEFT</text>',
            '<text x="656" y="360" class="f dat">', (ld.remainingBps / 100).toString(), '%', "</text>",
            '<text x="768" y="424" class="f" font-size="12" letter-spacing="3" fill="#555" text-anchor="end">OUT OF THIN AIR</text>',
            '<text x="32" y="424" class="f" font-size="12" letter-spacing="2" fill="#555">exnihilo.markets</text>'
        );
    }

    // ── Formatters ─────────────────────────────────────────────────────────────

    function _fmt6(uint256 v) internal pure returns (string memory) {
        uint256 whole = v / 1e6;
        uint256 frac  = (v % 1e6) / 1e4;
        if (frac < 10) return string(abi.encodePacked(whole.toString(), ".0", frac.toString()));
        return string(abi.encodePacked(whole.toString(), ".", frac.toString()));
    }

    /// @dev Up to 4 fractional digits, for any token decimals.
    function _fmtToken(uint256 v, uint8 dec) internal pure returns (string memory) {
        if (dec == 0) return v.toString();
        uint256 unit = 10 ** uint256(dec);
        uint256 whole = v / unit;
        uint8 show = dec > 4 ? 4 : dec;
        uint256 frac = (v % unit) / (10 ** uint256(dec - show));
        bytes memory fracB = bytes(frac.toString());
        string memory pad = "";
        if (uint256(show) > fracB.length) {
            uint256 padLen = uint256(show) - fracB.length;
            if (padLen == 1) pad = "0";
            else if (padLen == 2) pad = "00";
            else if (padLen == 3) pad = "000";
        }
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
