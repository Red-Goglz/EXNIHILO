// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "./LpNFT.sol";

interface IPoolDeployer {
    function deploy(
        address tokenAddress, address usdc, uint8 tokenDecimals,
        address positionNFT, address lpNftContract,
        uint256 lpNftId, address protocolTreasury,
        address factory
    ) external returns (address);
}

interface IPoolAddLiquidity {
    function addLiquidity(uint256 tokenAmount, uint256 usdcAmount) external;
}

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/**
 * @title  EXNIHILOFactory
 * @notice Permissionless, ownerless factory for token/USDC markets. createMarket
 *         deploys a pool, mints its LP NFT, seeds it and hands the NFT to the caller.
 * @dev    The pool stores its LP NFT id as an immutable, so the id is predicted as
 *         allPools.length (sole minter, one mint per market) and checked on mint.
 */
contract EXNIHILOFactory is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Constants ─────────────────────────────────────────────────────────────

    /// @notice Supported token precision. Covers USDC-like 6 through the usual 18.
    uint8 public constant MIN_TOKEN_DECIMALS = 6;
    uint8 public constant MAX_TOKEN_DECIMALS = 18;

    // ── Immutables ────────────────────────────────────────────────────────────

    address public immutable positionNFT;
    LpNFT  public immutable lpNftContract;
    address public immutable usdc;
    /// @notice Receives protocol fees from every pool.
    address public immutable protocolTreasury;
    IPoolDeployer public immutable poolDeployer;

    // ── Registry ──────────────────────────────────────────────────────────────

    mapping(address => bool) public isPool;
    address[] public allPools;

    // ── Errors ────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error TokenIsUsdc();
    error LpNftIdMismatch();
    error UnsupportedDecimals();

    // ── Events ────────────────────────────────────────────────────────────────

    event MarketCreated(
        address indexed pool,
        address indexed tokenAddress,
        address indexed creator,
        uint256 lpNftId
    );

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(
        address positionNFT_,
        address lpNftContract_,
        address usdc_,
        address protocolTreasury_,
        address poolDeployer_
    ) {
        if (positionNFT_      == address(0)) revert ZeroAddress();
        if (lpNftContract_    == address(0)) revert ZeroAddress();
        if (usdc_             == address(0)) revert ZeroAddress();
        if (protocolTreasury_ == address(0)) revert ZeroAddress();
        if (poolDeployer_     == address(0)) revert ZeroAddress();

        positionNFT       = positionNFT_;
        lpNftContract     = LpNFT(lpNftContract_);
        usdc              = usdc_;
        protocolTreasury  = protocolTreasury_;
        poolDeployer      = IPoolDeployer(poolDeployer_);
    }

    // ── Market creation ───────────────────────────────────────────────────────

    /// @notice Create a market seeded with pre-approved `usdcAmount` USDC and
    ///         `tokenAmount` tokens; the caller receives the LP NFT.
    function createMarket(
        address tokenAddress,
        uint256 usdcAmount,
        uint256 tokenAmount
    ) external nonReentrant returns (address pool, uint256 lpNftId) {
        if (tokenAddress == address(0)) revert ZeroAddress();
        if (tokenAddress == usdc) revert TokenIsUsdc();
        if (usdcAmount == 0 || tokenAmount == 0) revert ZeroAmount();

        // Fee-on-transfer tokens fail the pool's own _transferIn check below.
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcAmount);
        IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), tokenAmount);

        // Funding rounds per unit of collateral, so a coarse unit is a valuable
        // one: below MIN_TOKEN_DECIMALS the sub-unit residue is worth trading
        // against. A token that will not answer is assumed to be the usual 18.
        uint8 tokenDecimals;
        try IERC20Decimals(tokenAddress).decimals() returns (uint8 d) {
            tokenDecimals = d;
        } catch {
            tokenDecimals = 18;
        }
        if (tokenDecimals < MIN_TOKEN_DECIMALS || tokenDecimals > MAX_TOKEN_DECIMALS) {
            revert UnsupportedDecimals();
        }

        uint256 predictedLpNftId = allPools.length;

        pool = poolDeployer.deploy(
            tokenAddress,
            usdc,
            tokenDecimals,
            positionNFT,
            address(lpNftContract),
            predictedLpNftId,
            protocolTreasury,
            address(this)
        );

        // Minted to the factory so it can seed the pool as LP holder.
        lpNftId = lpNftContract.mint(address(this), pool);

        // The pool already stores the predicted id; never seed a mismatched market.
        if (lpNftId != predictedLpNftId) revert LpNftIdMismatch();

        IERC20(tokenAddress).forceApprove(pool, tokenAmount);
        IERC20(usdc).forceApprove(pool, usdcAmount);

        IPoolAddLiquidity(pool).addLiquidity(tokenAmount, usdcAmount);

        IERC20(tokenAddress).forceApprove(pool, 0);
        IERC20(usdc).forceApprove(pool, 0);

        IERC721(address(lpNftContract)).transferFrom(address(this), msg.sender, lpNftId);

        isPool[pool] = true;
        allPools.push(pool);

        emit MarketCreated(pool, tokenAddress, msg.sender, lpNftId);
    }

    function allPoolsLength() external view returns (uint256) {
        return allPools.length;
    }
}
