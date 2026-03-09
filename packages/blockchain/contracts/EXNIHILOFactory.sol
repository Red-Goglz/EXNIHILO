// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "./AirToken.sol";
import "./EXNIHILOPool.sol";
import "./LpNFT.sol";

/**
 * @title  EXNIHILOFactory
 * @author EXNIHILO
 * @notice Permissionless factory that creates EXNIHILO meme/USDC trading markets.
 *
 *         Each call to createMarket deploys:
 *           - AirToken  (airMeme wrapper, decimals matching the meme token)
 *           - AirToken  (airUsd wrapper, 6 decimals, USDC-denominated)
 *           - EXNIHILOPool  (the AMM + leveraged-trading contract)
 *
 *         The factory also mints exactly one LP NFT per pool (via the shared
 *         LpNFT contract), seeds the pool with the caller's initial liquidity,
 *         and finally transfers the LP NFT to the market creator.
 *
 * ── Immutability ───────────────────────────────────────────────────────────────
 *
 *   The factory has no owner and no admin functions.  All constructor parameters
 *   are stored as immutables.  Once deployed the factory's behaviour cannot change.
 *
 * ── LP NFT ID prediction ───────────────────────────────────────────────────────
 *
 *   EXNIHILOPool records its LP NFT id as an immutable, so the id must be known
 *   before the pool is deployed.  LpNFT._nextTokenId is private, but because:
 *     1. LpNFT is deployed with this factory as its sole minter, and
 *     2. Each createMarket mints exactly one LP NFT,
 *   the next id equals allPools.length at any point in time (both start at 0
 *   and increment together by 1 per market).  No storage-slot reads or assembly
 *   are required.
 *
 * ── LP NFT seeding flow ────────────────────────────────────────────────────────
 *
 *   EXNIHILOPool.addLiquidity() requires msg.sender == ownerOf(lpNftId).
 *   The factory temporarily mints the LP NFT to itself, seeds the pool
 *   (as the NFT holder), then transfers the NFT to the market creator.
 *   This requires no changes to any existing contract.
 *
 * ── Security ───────────────────────────────────────────────────────────────────
 *
 *   - ReentrancyGuard on createMarket.
 *   - SafeERC20 for all token transfers (handles non-standard ERC-20s).
 *   - All constructor addresses validated non-zero.
 *   - maxPositionBps validated to 10–9900 when non-zero (mirrors pool validation).
 *   - Residual token approvals cleared after addLiquidity.
 *   - onERC721Received implemented so the factory can safely receive LP NFTs.
 */
contract EXNIHILOFactory is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Immutables ────────────────────────────────────────────────────────────

    /// @notice Shared PositionNFT contract (deployed once, passed at construction).
    address public immutable positionNFT;

    /// @notice Shared LpNFT contract (deployed once, passed at construction).
    LpNFT  public immutable lpNftContract;

    /// @notice USDC token (6 decimals). Used as the quote / collateral asset.
    address public immutable usdc;

    /// @notice Receives the 2 % protocol fee from every pool on position opens.
    address public immutable protocolTreasury;

    /// @notice Default swap fee in bps applied to all newly created pools (e.g. 200 = 2 %).
    uint256 public immutable defaultSwapFeeBps;

    // ── Registry state ────────────────────────────────────────────────────────

    /// @notice True if `pool` was created by this factory.
    mapping(address => bool) public isPool;

    /// @notice Ordered list of all pools created by this factory.
    address[] public allPools;

    /**
     * @notice Maps a meme token address to the first pool created for that token.
     *         Subsequent pools for the same meme token are recorded in allPools
     *         but do NOT overwrite this entry (first-pool-wins).
     */
    mapping(address => address) public poolForToken;

    // ── Custom errors ─────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error InvalidMaxPositionBps(uint256 bps);
    error LpNftIdMismatch(uint256 expected, uint256 actual);

    // ── Events ────────────────────────────────────────────────────────────────

    /**
     * @notice Emitted once per successfully created market.
     *
     * @param pool            The newly deployed EXNIHILOPool address.
     * @param tokenAddress    The meme ERC-20 used as the base asset.
     * @param usdcAmount      Initial USDC liquidity seeded by the creator.
     * @param tokenAmount     Initial meme token liquidity seeded by the creator.
     * @param lpNftId         LP NFT token ID minted for the creator.
     * @param creator         Address that called createMarket.
     * @param maxPositionUsd  Hard per-position USDC cap (0 = disabled).
     * @param maxPositionBps  Per-position cap as % of backedAirUsd in bps (0 = disabled).
     */
    event MarketCreated(
        address indexed pool,
        address indexed tokenAddress,
        uint256 usdcAmount,
        uint256 tokenAmount,
        uint256 lpNftId,
        address indexed creator,
        uint256 maxPositionUsd,
        uint256 maxPositionBps
    );

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param positionNFT_       Global PositionNFT contract (deployed separately).
     * @param lpNftContract_     Global LpNFT contract (deployed separately).
     * @param usdc_              USDC token address (6 decimals).
     * @param protocolTreasury_  Receives the 2 % protocol fee from all pools.
     * @param defaultSwapFeeBps_ Default swap fee for pools (e.g. 200 = 2 %).
     */
    constructor(
        address positionNFT_,
        address lpNftContract_,
        address usdc_,
        address protocolTreasury_,
        uint256 defaultSwapFeeBps_
    ) {
        if (positionNFT_      == address(0)) revert ZeroAddress();
        if (lpNftContract_    == address(0)) revert ZeroAddress();
        if (usdc_             == address(0)) revert ZeroAddress();
        if (protocolTreasury_ == address(0)) revert ZeroAddress();

        positionNFT       = positionNFT_;
        lpNftContract     = LpNFT(lpNftContract_);
        usdc              = usdc_;
        protocolTreasury  = protocolTreasury_;
        defaultSwapFeeBps = defaultSwapFeeBps_;
    }

    // ── Market creation ───────────────────────────────────────────────────────

    /**
     * @notice Create a new permissionless meme/USDC trading market.
     *
     *         The caller determines the initial meme:USDC price ratio by
     *         supplying both amounts.  Both tokens must be pre-approved for
     *         transfer to this factory before calling.
     *
     * ── createMarket flow ──────────────────────────────────────────────────────
     *
     *   1.  Validate all inputs.
     *   2.  Pull usdcAmount USDC and tokenAmount meme from msg.sender.
     *   3.  Deploy AirToken (airMeme) — name/symbol: "air<symbol>", meme decimals.
     *   4.  Deploy AirToken (airUsd)  — name/symbol: "air<symbol>Usd", 6 decimals.
     *   5.  Predict the next LP NFT id (= allPools.length, see contract header).
     *   6.  Deploy EXNIHILOPool with all parameters, passing the predicted LP NFT id.
     *   7.  Wire both AirTokens to the pool via initPool().
     *   8.  Mint LP NFT to factory (factory is temporary LP holder for seeding).
     *   9.  Approve pool to pull factory's tokens; call pool.addLiquidity().
     *  10.  Revoke residual approvals.
     *  11.  Transfer LP NFT from factory to msg.sender.
     *  12.  Update registry and emit MarketCreated.
     *
     * @param tokenAddress    ERC-20 meme token to create a market for. Must not be zero.
     * @param usdcAmount      Initial USDC liquidity (6 dec). Must be > 0.
     * @param tokenAmount     Initial meme token liquidity. Must be > 0.
     * @param maxPositionUsd  Hard per-position USDC cap (0 = disabled).
     * @param maxPositionBps  Per-position cap as % of backedAirUsd in bps
     *                        (valid range when non-zero: 10–9900). 0 = disabled.
     *
     * @return pool    Address of the newly deployed EXNIHILOPool.
     * @return lpNftId LP NFT token ID transferred to the caller.
     */
    function createMarket(
        address tokenAddress,
        uint256 usdcAmount,
        uint256 tokenAmount,
        uint256 maxPositionUsd,
        uint256 maxPositionBps
    ) external nonReentrant returns (address pool, uint256 lpNftId) {
        // ── 1. Input validation ───────────────────────────────────────────────

        if (tokenAddress == address(0)) revert ZeroAddress();
        if (usdcAmount   == 0)          revert ZeroAmount();
        if (tokenAmount  == 0)          revert ZeroAmount();

        // Mirror the pool's own constructor guard so we fail early with a clear
        // error before spending gas on deploying any child contracts.
        if (maxPositionBps != 0 && (maxPositionBps < 10 || maxPositionBps > 9900)) {
            revert InvalidMaxPositionBps(maxPositionBps);
        }

        // ── 2. Pull tokens from caller ────────────────────────────────────────

        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcAmount);
        IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), tokenAmount);

        // ── 3. Deploy AirToken for the meme wrapper ───────────────────────────

        string memory memeSymbol  = _safeSymbol(tokenAddress);
        uint8         memeDecimals = _safeDecimals(tokenAddress);

        // Name and symbol follow the convention: "air" + memeSymbol.
        string memory airMemeName   = string.concat("air", memeSymbol);
        string memory airUsdName    = string.concat("air", memeSymbol, "Usd");

        AirToken airMemeToken = new AirToken(airMemeName, airMemeName, memeDecimals);

        // ── 4. Deploy AirToken for the USDC wrapper ───────────────────────────

        AirToken airUsdToken = new AirToken(airUsdName, airUsdName, 6);

        // ── 5. Predict the next LP NFT id ─────────────────────────────────────
        //
        //   LpNFT._nextTokenId starts at 0 and is incremented exactly once per
        //   call to lpNftContract.mint(), which only this factory can invoke.
        //   Each createMarket mints exactly one LP NFT.
        //   Therefore: _nextTokenId == allPools.length at any moment.
        //
        //   We capture it now, before pushing to allPools, so the predicted id
        //   is consistent with what mint() will actually assign.

        uint256 predictedLpNftId = allPools.length;

        // ── 6. Deploy EXNIHILOPool ───────────────────────────────────────────

        EXNIHILOPool deployedPool = new EXNIHILOPool(
            address(airMemeToken),
            address(airUsdToken),
            tokenAddress,
            usdc,
            positionNFT,
            address(lpNftContract),
            predictedLpNftId,   // lpNftId_ — must match what mint() will return
            protocolTreasury,
            maxPositionUsd,
            maxPositionBps,
            defaultSwapFeeBps
        );

        pool = address(deployedPool);

        // ── 7. Wire AirTokens to the pool ────────────────────────────────────

        // initPool can only be called once per AirToken and only by its factory
        // (the deploying address, which is this contract).
        airMemeToken.initPool(pool);
        airUsdToken.initPool(pool);

        // ── 8. Mint LP NFT to factory (temporary holder for seeding) ──────────

        // LpNFT.mint() increments _nextTokenId and returns tokenId = _nextTokenId++.
        // The returned id must equal our prediction; if not, something is wrong
        // with the factory's LP NFT accounting invariant.
        lpNftId = lpNftContract.mint(address(this), pool);

        if (lpNftId != predictedLpNftId) {
            revert LpNftIdMismatch(predictedLpNftId, lpNftId);
        }

        // ── 9. Seed the pool via addLiquidity (factory is the LP NFT holder) ──

        // addLiquidity uses safeTransferFrom(msg.sender, ...) so the factory
        // must approve the pool to pull the tokens it currently holds.
        IERC20(tokenAddress).forceApprove(pool, tokenAmount);
        IERC20(usdc).forceApprove(pool, usdcAmount);

        // Factory is ownerOf(lpNftId) → onlyLpHolder passes.
        deployedPool.addLiquidity(tokenAmount, usdcAmount);

        // ── 10. Revoke residual approvals (defence-in-depth) ──────────────────

        IERC20(tokenAddress).forceApprove(pool, 0);
        IERC20(usdc).forceApprove(pool, 0);

        // ── 11. Transfer LP NFT to market creator ─────────────────────────────

        // Use safeTransferFrom so the recipient's onERC721Received hook is called
        // if the creator is a contract.  The factory itself implements the hook
        // to handle the temporary custody above.
        IERC721(address(lpNftContract)).safeTransferFrom(address(this), msg.sender, lpNftId);

        // ── 12. Registry update and event ─────────────────────────────────────

        isPool[pool] = true;
        allPools.push(pool);

        // Record the first pool for this meme token only (first-pool-wins).
        if (poolForToken[tokenAddress] == address(0)) {
            poolForToken[tokenAddress] = pool;
        }

        emit MarketCreated(
            pool,
            tokenAddress,
            usdcAmount,
            tokenAmount,
            lpNftId,
            msg.sender,
            maxPositionUsd,
            maxPositionBps
        );
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /**
     * @notice Returns the total number of pools created by this factory.
     */
    function allPoolsLength() external view returns (uint256) {
        return allPools.length;
    }

    // ── ERC-721 receiver ──────────────────────────────────────────────────────

    /**
     * @dev Required by IERC721Receiver so LpNFT._safeMint can transfer to this
     *      contract.  Only the LP NFT is expected to be sent to the factory
     *      (temporarily, during pool seeding).
     */
    function onERC721Received(
        address, /* operator */
        address, /* from     */
        uint256, /* tokenId  */
        bytes calldata /* data */
    ) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /**
     * @dev Attempt to read the ERC-20 symbol from `token`.  Returns "TOKEN" if
     *      the call reverts or the contract does not expose symbol() (e.g. some
     *      non-standard ERC-20s).
     */
    function _safeSymbol(address token) internal view returns (string memory) {
        try IERC20Metadata(token).symbol() returns (string memory sym) {
            // Guard against an empty string response.
            if (bytes(sym).length == 0) return "TOKEN";
            return sym;
        } catch {
            return "TOKEN";
        }
    }

    /**
     * @dev Attempt to read the ERC-20 decimals from `token`.  Returns 18 if
     *      the call reverts (safe default matching most meme tokens).
     */
    function _safeDecimals(address token) internal view returns (uint8) {
        try IERC20Metadata(token).decimals() returns (uint8 dec) {
            return dec;
        } catch {
            return 18;
        }
    }
}
