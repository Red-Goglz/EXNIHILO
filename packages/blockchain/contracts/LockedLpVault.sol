// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface ILockedPool {
    function claimFees(address to) external;
    function lpFeesAccumulated() external view returns (uint256);
    function underlyingUsdc() external view returns (address);
}

interface ILockedLpNFT {
    function poolOf(uint256 tokenId) external view returns (address);
    function ownerOf(uint256 tokenId) external view returns (address);
}

/**
 * @title  LockedLpVault
 * @notice Permanent holder of an EXNIHILO LP NFT. No code path removes liquidity,
 *         closes the pool or moves the NFT, and there is no admin. The LP fee
 *         stream stays claimable, split between `lp` and `integrator` as pull
 *         payments.
 */
contract LockedLpVault is ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    uint256 private constant BPS_DENOM = 10_000;

    // ── Immutables ────────────────────────────────────────────────────────────

    ILockedPool public immutable pool;
    /// @notice The pool's USDC.
    IERC20 public immutable usdc;
    ILockedLpNFT public immutable lpNft;
    uint256 public immutable lpNftId;
    /// @notice Integrator's share of harvested fees in bps, fixed at creation.
    uint256 public immutable integratorBps;

    // ── Roles (each transferable only by its holder) ──────────────────────────

    /// @notice Receives the LP share.
    address public lp;
    /// @notice Receives the integrator share; zero only when integratorBps is zero.
    address public integrator;

    // ── State ─────────────────────────────────────────────────────────────────

    uint256 public lpAccrued;
    uint256 public integratorAccrued;
    uint256 public lpClaimedTotal;
    uint256 public integratorClaimedTotal;
    uint256 public harvestedTotal;

    // ── Errors ────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error InvalidBps();
    error PoolMismatch();
    error NotLp();
    error NotIntegrator();
    error NothingToClaim();

    // ── Events ────────────────────────────────────────────────────────────────

    event Harvested(uint256 amount, uint256 lpCut, uint256 integratorCut);
    /// @dev A non-strict harvest skipped a failing pool claim.
    event PoolClaimFailed();
    event LpFeesClaimed(address indexed to, uint256 amount);
    event IntegratorFeesClaimed(address indexed to, uint256 amount);
    event LpTransferred(address indexed from, address indexed to);
    event IntegratorTransferred(address indexed from, address indexed to);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(
        address pool_,
        address lpNft_,
        uint256 lpNftId_,
        address lp_,
        address integrator_,
        uint256 integratorBps_
    ) {
        if (pool_ == address(0) || lpNft_ == address(0)) revert ZeroAddress();
        if (lp_ == address(0)) revert ZeroAddress();
        if (integratorBps_ > BPS_DENOM) revert InvalidBps();
        if (integratorBps_ != 0 && integrator_ == address(0)) revert ZeroAddress();

        // The NFT arrives after deployment, but the id/pool pairing can be checked now.
        if (ILockedLpNFT(lpNft_).poolOf(lpNftId_) != pool_) revert PoolMismatch();

        pool          = ILockedPool(pool_);
        lpNft         = ILockedLpNFT(lpNft_);
        lpNftId       = lpNftId_;
        lp            = lp_;
        integrator    = integrator_;
        integratorBps = integratorBps_;

        usdc = IERC20(ILockedPool(pool_).underlyingUsdc());
    }

    // ── Harvest ───────────────────────────────────────────────────────────────

    /// @notice Pull the pool's LP fees and split everything unearmarked. Permissionless.
    function harvest() external nonReentrant returns (uint256 amount) {
        return _harvest(true);
    }

    /// @dev Splits the whole unearmarked balance, so USDC sent here directly is
    ///      shared rather than stranded. `strict` reverts on a failed pool claim;
    ///      claims pass strict only when nothing is banked, so a failing pool never
    ///      blocks paying out fees already held.
    function _harvest(bool strict) internal returns (uint256 amount) {
        // Always claimed to this contract: the split is measured from its balance.
        if (pool.lpFeesAccumulated() != 0) {
            if (strict) {
                pool.claimFees(address(this));
            } else {
                try pool.claimFees(address(this)) {
                } catch {
                    emit PoolClaimFailed();
                }
            }
        }

        amount = usdc.balanceOf(address(this)) - lpAccrued - integratorAccrued;

        if (amount == 0) return 0;

        uint256 integratorCut = (amount * integratorBps) / BPS_DENOM;
        uint256 lpCut         = amount - integratorCut; // dust favours the LP

        lpAccrued         += lpCut;
        integratorAccrued += integratorCut;
        harvestedTotal    += amount;

        emit Harvested(amount, lpCut, integratorCut);
    }

    // ── Claims ────────────────────────────────────────────────────────────────

    /// @notice Harvest, then send the LP's accrued share to `to`.
    function claimLpFees(address to) external nonReentrant returns (uint256 amount) {
        if (msg.sender != lp) revert NotLp();
        if (to == address(0)) revert ZeroAddress();

        _harvest(lpAccrued == 0);

        amount = lpAccrued;
        if (amount == 0) revert NothingToClaim();

        lpAccrued       = 0;
        lpClaimedTotal += amount;

        usdc.safeTransfer(to, amount);
        emit LpFeesClaimed(to, amount);
    }

    /// @notice Harvest, then send the integrator's accrued share to `to`.
    function claimIntegratorFees(address to) external nonReentrant returns (uint256 amount) {
        if (msg.sender != integrator) revert NotIntegrator();
        if (to == address(0)) revert ZeroAddress();

        _harvest(integratorAccrued == 0);

        amount = integratorAccrued;
        if (amount == 0) revert NothingToClaim();

        integratorAccrued       = 0;
        integratorClaimedTotal += amount;

        usdc.safeTransfer(to, amount);
        emit IntegratorFeesClaimed(to, amount);
    }

    // ── Role transfer ─────────────────────────────────────────────────────────

    /// @notice Transfer the LP role; the accrued balance moves with it.
    function setLp(address newLp) external {
        if (msg.sender != lp) revert NotLp();
        if (newLp == address(0)) revert ZeroAddress();

        emit LpTransferred(lp, newLp);
        lp = newLp;
    }

    /// @notice Transfer the integrator role; the accrued balance moves with it.
    function setIntegrator(address newIntegrator) external {
        if (msg.sender != integrator) revert NotIntegrator();
        if (newIntegrator == address(0)) revert ZeroAddress();

        emit IntegratorTransferred(integrator, newIntegrator);
        integrator = newIntegrator;
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /// @notice Each party's balance if harvested now.
    function pending() external view returns (uint256 lpPending, uint256 integratorPending) {
        uint256 unharvested = pool.lpFeesAccumulated()
            + (usdc.balanceOf(address(this)) - lpAccrued - integratorAccrued);
        uint256 integratorCut = (unharvested * integratorBps) / BPS_DENOM;

        lpPending         = lpAccrued + (unharvested - integratorCut);
        integratorPending = integratorAccrued + integratorCut;
    }

    /// @notice True once the LP NFT is held here.
    function isFunded() external view returns (bool) {
        return lpNft.ownerOf(lpNftId) == address(this);
    }

    /// @dev Accepts safeTransferFrom, so locking an NFT in never fails.
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
