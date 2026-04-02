// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "./AirToken.sol";
import "./EXNIHILOPool.sol";
import "./LpNFT.sol";

/**
 * @title  EXNIHILOFactory
 * @author EXNIHILO
 * @notice Permissionless factory that creates EXNIHILO token/USDC trading markets.
 *
 *         Each call to createMarket deploys:
 *           - AirToken  (airToken wrapper, decimals matching the underlying token)
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

    // ── Emergency admin ──────────────────────────────────────────────────────

    /// @notice Emergency deployer address. Can close any pool.
    ///         Set to msg.sender in the constructor. Updatable via setDeployer().
    address public deployer;

    // ── Registry state ────────────────────────────────────────────────────────

    /// @notice True if `pool` was created by this factory.
    mapping(address => bool) public isPool;

    /// @notice Ordered list of all pools created by this factory.
    address[] public allPools;


    // ── Custom errors ─────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error OnlyDeployer();

    // ── Events ────────────────────────────────────────────────────────────────

    event MarketCreated(
        address indexed pool,
        address indexed tokenAddress,
        address indexed creator,
        uint256 lpNftId
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
        positionNFT       = positionNFT_;
        lpNftContract     = LpNFT(lpNftContract_);
        usdc              = usdc_;
        protocolTreasury  = protocolTreasury_;
        defaultSwapFeeBps = defaultSwapFeeBps_;
        deployer          = msg.sender;
    }

    // ── Market creation ───────────────────────────────────────────────────────

    /**
     * @notice Create a new permissionless token/USDC trading market.
     *
     *         The caller determines the initial token:USDC price ratio by
     *         supplying both amounts.  Both tokens must be pre-approved for
     *         transfer to this factory before calling.
     *
     * ── createMarket flow ──────────────────────────────────────────────────────
     *
     *   1.  Validate all inputs.
     *   2.  Pull usdcAmount USDC and tokenAmount token from msg.sender.
     *   3.  Deploy AirToken (airToken) — name/symbol: "air<symbol>", token decimals.
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
     * @param tokenAddress    ERC-20 underlying token to create a market for. Must not be zero.
     * @param usdcAmount      Initial USDC liquidity (6 dec). Must be > 0.
     * @param tokenAmount     Initial underlying token liquidity. Must be > 0.
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
        uint256 maxPositionBps,
        uint256 positionDuration,
        string calldata airTokenName,
        string calldata airUsdName,
        uint8 tokenDecimals
    ) external nonReentrant returns (address pool, uint256 lpNftId) {
        // ── 1. Input validation ───────────────────────────────────────────────

        if (usdcAmount   == 0)          revert ZeroAmount();
        if (tokenAmount  == 0)          revert ZeroAmount();

        // ── 2. Pull tokens from caller ────────────────────────────────────────
        //    Fee-on-transfer tokens are rejected by the pool's own _transferIn guard.

        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcAmount);
        IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), tokenAmount);

        // ── 3. Deploy AirToken for the token wrapper ───────────────────────────

        AirToken airToken = new AirToken(airTokenName, airTokenName, tokenDecimals);

        // ── 4. Deploy AirToken for the USDC wrapper ───────────────────────────

        AirToken airUsdToken = new AirToken(airUsdName, airUsdName, 6);

        // ── 5. Deploy EXNIHILOPool ───────────────────────────────────────────

        EXNIHILOPool deployedPool = new EXNIHILOPool(
            address(airToken),
            address(airUsdToken),
            tokenAddress,
            usdc,
            positionNFT,
            address(lpNftContract),
            allPools.length,    // lpNftId_ — equals LpNFT._nextTokenId
            protocolTreasury,
            maxPositionUsd,
            maxPositionBps,
            defaultSwapFeeBps,
            positionDuration,
            address(this)       // factory address for emergency deployer lookup
        );

        pool = address(deployedPool);

        // ── 7. Wire AirTokens to the pool ────────────────────────────────────

        // initPool can only be called once per AirToken and only by its factory
        // (the deploying address, which is this contract).
        airToken.initPool(pool);
        airUsdToken.initPool(pool);

        // ── 8. Mint LP NFT to factory (temporary holder for seeding) ──────────

        // LpNFT.mint() increments _nextTokenId and returns tokenId = _nextTokenId++.
        // The returned id must equal our prediction; if not, something is wrong
        // with the factory's LP NFT accounting invariant.
        lpNftId = lpNftContract.mint(address(this), pool);

        // ── 9. Seed the pool via addLiquidity (factory is the LP NFT holder) ──

        IERC20(tokenAddress).forceApprove(pool, tokenAmount);
        IERC20(usdc).forceApprove(pool, usdcAmount);

        deployedPool.addLiquidity(tokenAmount, usdcAmount);

        // ── 10. Transfer LP NFT to market creator ─────────────────────────────

        IERC721(address(lpNftContract)).transferFrom(address(this), msg.sender, lpNftId);

        // ── 12. Registry update and event ─────────────────────────────────────

        isPool[pool] = true;
        allPools.push(pool);

        emit MarketCreated(pool, tokenAddress, msg.sender, lpNftId);
    }

    // ── Emergency admin ────────────────────────────────────────────────────────

    /**
     * @notice Transfer the deployer (emergency admin) role to a new address.
     *         Only callable by the current deployer.
     * @param newDeployer  New deployer address. Must not be zero.
     */
    function setDeployer(address newDeployer) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        deployer = newDeployer;
    }


}
