// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title PositionNFT
 * @notice Manages both Long and Short position tokens for all EXNIHILO pools.
 *
 * Registry model
 * ──────────────
 * The NFT is a pure position registry: locked collateral never leaves the
 * pool — the pool's supply counters plus the Position struct fully describe it. mintLong / mintShort record the position and mint the
 * NFT; release() burns the NFT and returns the Position struct, which gives
 * the pool everything it needs to complete the settlement math.
 *
 * Access control
 * ──────────────
 * mintLong / mintShort  →  factory must be initialised, msg.sender must equal
 *                          the `pool` argument, and the pool must be registered
 *                          with the factory.
 * release               →  msg.sender must equal positions[tokenId].pool.
 */
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

contract PositionNFT is ERC721Enumerable {
    using Strings for uint256;

    // ── Position data ──────────────────────────────────────────────────────────

    struct Position {
        bool isLong;
        address pool;
        /// @dev airTokenLocked for longs, airUsdLocked for shorts, AS AT OPEN.
        ///      Funding shrinks every position on a side by the same factor —
        ///      this and the three amounts below alike — so each live figure is
        ///        atOpen * poolFundingIndex / fundingIndexAtOpen
        ///      and this registry deliberately does not track them — recording a
        ///      decaying number per position is exactly the per-position write
        ///      the index exists to avoid. Ask the pool: EXNIHILOPool.liveAmountsOf().
        uint256 lockedAmountAtOpen;
        /// @dev USDC notional at open, both sides
        uint256 usdcIn;
        /// @dev Long only: synthetic airUsd debt minted at open
        uint256 airUsdMinted;
        /// @dev Short only: synthetic airToken debt minted at open
        uint256 airTokenMinted;
        uint256 feesPaid;
        uint256 openedAt;
        /// @dev The pool's funding index for this position's side at the moment
        ///      it was minted, in RAY. The denominator of the decay ratio above.
        ///      Positions no longer expire, so this replaces what used to be the
        ///      deadline: the charge for holding is continuous rather than a
        ///      lease that has to be renewed.
        uint256 fundingIndexAtOpen;
    }

    /// @dev Live pool data resolved at tokenURI call time.
    struct LiveData {
        string tokenSymbol;   // underlying token symbol, e.g. "PEPE"
        bool   pnlReady;     // false if pool state unavailable
        bool   pnlPositive;
        uint256 pnlAbs;      // abs PnL in USDC 6-dec units (net of 1% close fee on profit)
        uint8  tokenDecimals; // underlying token decimals (for display formatting)
        uint256 locked;      // collateral still backing the position, net of funding
        uint256 debt;        // synthetic debt left, net of funding (airUsd long / airToken short)
        uint256 notional;    // USDC notional left, net of funding
        uint256 remainingBps; // all three as a fraction of what the position opened with
    }

    // ── State ──────────────────────────────────────────────────────────────────

    uint256 private _nextTokenId;
    mapping(uint256 => Position) private _positions;


    /// @notice The deployer address (used to authorize initFactory).
    address private immutable _deployer;

    /// @notice Factory that registers valid pools. When set, mintLong/mintShort
    ///         verify that msg.sender is a pool registered with this factory.
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

    /**
     * @notice Wire this NFT to a factory so that only registered pools may
     *         mint positions. Called once by the deployer after the factory
     *         contract is deployed.
     * @param factory_ Address of the EXNIHILOFactory.
     */
    function initFactory(address factory_) external {
        if (msg.sender != _deployer) revert OnlyDeployer();
        if (factory != address(0)) revert FactoryAlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactoryInitialized(factory_);
    }

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

    /**
     * @dev The trader's actual result: signed USDC, and the same number as a
     *      percent of what they staked. One helper for both so the figure and
     *      the percent can never disagree on the card.
     *
     *      The premium IS the cost basis. openLong / openShort pull only the
     *      fee from the trader and mint the notional synthetically, so what
     *      they staked is `feesPaid` and what they get back is the payout:
     *
     *          pnl = payout − premium        pct = pnl / premium
     *
     *      Two floors follow from the settlement rules, and both matter:
     *
     *      - `payout` floors at ZERO. A position below break-even cannot be
     *        closed and pays nothing when swept; the pool's reported shortfall
     *        is a notional gap, not a debt the trader owes. Carrying that gap
     *        into the display printed losses many times the premium — a
     *        position that risked $5 rendering as −$80.
     *      - `pnl` therefore floors at −premium, i.e. −100%. Losing everything
     *        staked is the worst case, which is the whole point of buying an
     *        option rather than taking on leverage.
     *
     *      Reporting the raw payout as "PnL" — as this contract used to — is
     *      the same error in the other direction: it omits the cost basis, so
     *      a position that returned $3 on a $5 premium read as a $3 gain when
     *      the trader is down $2.
     */
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
        // Build in chunks to stay within abi.encodePacked 16-arg limit
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
            // Both figures are net of the premium, so a marketplace sorting on
            // either one ranks positions the same way.
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

    // ── Mint ───────────────────────────────────────────────────────────────────

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

    // ── Release ────────────────────────────────────────────────────────────────

    function release(uint256 tokenId) external returns (Position memory position) {
        position = _positions[tokenId];
        if (position.pool == address(0)) revert PositionNotFound();
        if (msg.sender != position.pool) revert PositionNotFromPool();

        delete _positions[tokenId];
        _burn(tokenId);
    }

    // ── Live data reader ───────────────────────────────────────────────────────

    /**
     * @dev Reads token metadata and the live PnL quote from the pool.
     *      All external calls are wrapped in try/catch so tokenURI never
     *      reverts due to pool state issues.
     *
     *      PnL is delegated to EXNIHILOPool.quoteClose(), the single source
     *      of truth that mirrors the exact closeLong / closeShort settlement
     *      math — this contract no longer replicates any AMM formulas.
     */
    function _readLive(uint256 tokenId, Position memory pos) internal view returns (LiveData memory ld) {
        ld.tokenDecimals = 18; // safe default

        // Collateral, debt and notional net of funding. The registry stores only
        // the opening figures — see Position.lockedAmountAtOpen — so the live
        // ones have to come from the pool, which owns the index. Falling back to the opening
        // figure on a failed call would overstate the position, so the fallback
        // is the same best-effort shape as every other call here and the
        // remaining fraction reads 0 (unknown) rather than 10000 (untouched).
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

        // Token symbol + decimals (best-effort)
        try IEXNIHILOPool(pos.pool).underlyingToken() returns (address token) {
            try ITokenMeta(token).symbol() returns (string memory sym) {
                ld.tokenSymbol = sym;
            } catch { ld.tokenSymbol = "TOKEN"; }
            try ITokenMeta(token).decimals() returns (uint8 d) {
                ld.tokenDecimals = d;
            } catch {}
        } catch { ld.tokenSymbol = "TOKEN"; }

        // Live PnL quote (net of close fee on profit).
        //
        // `ready == false` means the pool cannot settle the position at all —
        // underwater past the point its debt can be bought back. That is a
        // loss, not an unknown, and the pool reports the estimated shortfall in
        // `pnl` so the certificate can show it. Only a reverting pool or a
        // genuinely zero quote still renders "N/A".
        try IEXNIHILOPool(pos.pool).quoteClose(tokenId) returns (bool ready, int256 pnl) {
            ld.pnlReady    = ready || pnl != 0;
            ld.pnlPositive = ready && pnl >= 0;
            ld.pnlAbs      = pnl >= 0 ? uint256(pnl) : uint256(-pnl);
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
            _svgChrome(tokenId, sc, sl, ld.tokenSymbol),
            pos.isLong ? _svgLongData(pos, ld) : _svgShortData(pos, ld),
            _svgPnl(pos, ld),
            _svgFooter(pos, ld),
            "</svg>"
        );
    }

    function _svgOpen() internal pure returns (bytes memory) {
        // CSS animations split across two encodePacked calls to stay within
        // the 16-argument limit.
        bytes memory styles = abi.encodePacked(
            "<defs><style>",
            ".f{font-family:'Courier New',Courier,monospace;}",
            // Sized for a card that is usually viewed at half its 800x450
            // canvas: 10px labels at #555 are unreadable there.
            ".lbl{font-size:13;letter-spacing:2;fill:#8a8a8a;}",
            ".val{font-size:20;fill:#e8e8e8;}",
            ".dat{font-size:16;fill:#999;}",
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

        // 800x450 — 16:9, the ratio X renders in-timeline without cropping.
        bytes memory chrome = abi.encodePacked(
            '<rect width="800" height="450" fill="#000"/>',
            '<rect x="1" y="1" width="798" height="448" fill="none" stroke="#1a1a1a"/>',
            '<polyline points="1,24 1,1 24,1"            fill="none" stroke="#00e5ff" stroke-width="1.5"/>',
            '<polyline points="776,1 799,1 799,24"       fill="none" stroke="#00e5ff" stroke-width="1.5"/>',
            '<polyline points="1,426 1,449 24,449"       fill="none" stroke="#00e5ff" stroke-width="1.5"/>',
            '<polyline points="776,449 799,449 799,426"  fill="none" stroke="#00e5ff" stroke-width="1.5"/>'
        );

        // Three-layer glitch title: cyan behind, red behind, white on top
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

        // Split across two calls to stay within encodePacked's 16-argument limit.
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

    function _svgLongData(Position memory pos, LiveData memory ld) internal pure returns (bytes memory) {
        // Columns 1-3 of the bottom stats strip; the footer adds 4-5.
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
        // Mirrors the long layout (SIZE | LOCKED collateral) so both sides
        // read the same. The airToken debt stays in the JSON attributes for
        // marketplace pricing — on the certificate it is noise.
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
            // Exactly break-even: the payout gives the premium back and no more.
            pnlColor = "#aaaaaa";
            pnlText  = "$0.00";
            caption  = "NET OF PREMIUM PAID";
        } else {
            // Colour tracks the RETURN, not the payout: a position can pay out
            // a positive number and still sit far below the premium that bought
            // it, and painting that green would sell a loss as a win.
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

        // Hero of the card — centred in the open space above the stats strip.
        // Figure and percent are both net of the premium, so the caption names
        // the one basis rather than reconciling two.
        return abi.encodePacked(
            '<text x="400" y="196" class="f lbl" text-anchor="middle" letter-spacing="4">EST. PnL</text>',
            '<text x="400" y="252" class="f" font-size="56" font-weight="bold" fill="', pnlColor, '" text-anchor="middle" letter-spacing="2">', pnlText, "</text>",
            '<text x="400" y="276" class="f" font-size="12" letter-spacing="2" fill="#8a8a8a" text-anchor="middle">', caption, "</text>"
        );
    }

    function _svgFooter(Position memory pos, LiveData memory ld) internal pure returns (bytes memory) {
        // Divider above the strip, columns 4-5, and the tagline.
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

    /**
     * @dev Format a token amount with up to 4 fractional digits, adapting to
     *      the token's actual decimal count (works for 18, 8, 6, etc.).
     */
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
