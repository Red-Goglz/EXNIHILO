// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/**
 * @dev Minimal interface to EXNIHILOPool — only what the vault calls.
 */
interface ILockedPool {
    function claimFees(address to) external;
    function lpFeesAccumulated() external view returns (uint256);
    function underlyingUsdc() external view returns (address);
}

/**
 * @dev Minimal interface to LpNFT — used to verify the vault was pointed at the
 *      LP NFT that actually governs `pool`.
 */
interface ILockedLpNFT {
    function poolOf(uint256 tokenId) external view returns (address);
    function ownerOf(uint256 tokenId) external view returns (address);
}

/**
 * @title  LockedLpVault
 * @author EXNIHILO
 * @notice Permanent holder of an EXNIHILO LP NFT. Holding the NFT here is
 *         economically identical to burning it, except that the fee stream
 *         survives and can be split.
 *
 * ── Why not just burn the NFT ────────────────────────────────────────────────
 *
 *   LpNFT has no burn function, and ERC-721 rejects a transfer to address(0), so
 *   "burning" can only mean sending it to 0x…dEaD. That leaves ownerOf returning
 *   a dead address, which makes every onlyLpHolder function revert forever —
 *   including claimFees. Since the LP stream is 4 % of notional plus 100 % of
 *   impact fees, burning throws away the larger of the protocol's two revenue
 *   streams to achieve a lock this contract provides anyway.
 *
 * ── The guarantee ────────────────────────────────────────────────────────────
 *
 *   This contract contains NO code path that calls:
 *
 *       pool.removeLiquidity()      — liquidity can never be withdrawn
 *       pool.addLiquidity()         — reserves can never be changed from here
 *       pool.closePool()            — the market can never be wound down here
 *       lpNft.transferFrom / approve — the NFT can never leave
 *
 *   There is no owner, no admin, and no upgrade path. Every address is immutable.
 *   Anyone can verify from the deployed bytecode that the liquidity backing the
 *   market cannot be pulled out, by anyone, ever — which is the property a
 *   launchpad is actually buying when it says "LP burned".
 *
 *   Because swap fees are retained by *not* reducing the pool's backed reserve,
 *   a locked LP means spot volume permanently deepens the market rather than
 *   accruing to a withdrawable balance.
 *
 * ── Fee split ────────────────────────────────────────────────────────────────
 *
 *   pool.claimFees() is the vault's only income. It carries the base LP fee
 *   (4 % of notional on every open) and the whole impact fee. Funding is not
 *   included: it never becomes a claimable fee, it lands straight in the backed
 *   reserves, so the vault sees it as growth in the position rather than as yield
 *   to distribute.
 *   Protocol fees are not part of it — those go to the factory's own treasury.
 *
 *   Each harvest splits the amount received: `integratorBps` to the integrator
 *   (the launchpad that originated the market), the remainder to the LP (the
 *   project). Rounding dust favours the LP.
 *
 * ── Pull payments ────────────────────────────────────────────────────────────
 *
 *   Harvesting only *accrues*; it never pushes USDC to either party. This
 *   mirrors EXNIHILOPool, which is deliberately pull-only so that a recipient
 *   who cannot receive USDC (a blacklisted address) can never block an
 *   operation. Both claim functions take a destination, so a blocked party can
 *   still redirect their own balance.
 */
contract LockedLpVault is ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    uint256 private constant BPS_DENOM = 10_000;

    // ── Immutables ────────────────────────────────────────────────────────────

    /// @notice The pool whose LP NFT this vault holds.
    ILockedPool public immutable pool;

    /// @notice USDC, read from the pool so the two can never disagree.
    IERC20 public immutable usdc;

    /// @notice Shared LpNFT contract.
    ILockedLpNFT public immutable lpNft;

    /// @notice The LP NFT id governing `pool`.
    uint256 public immutable lpNftId;

    /// @notice Integrator's share of the LP fee stream, in bps. Immutable —
    ///         the split is part of the deal struck at market creation, and
    ///         neither party can move it afterwards.
    uint256 public immutable integratorBps;

    // ── Roles ─────────────────────────────────────────────────────────────────
    //
    // The two claim addresses are transferable, each only by its own holder, so
    // a project or launchpad can rotate a compromised key or move to a multisig
    // without touching the market. Neither role can withdraw liquidity, change
    // the split, or affect the other side — they gate a claim destination and
    // nothing else.

    /// @notice Receives the LP share of every harvest. Typically the project.
    address public lp;

    /// @notice Receives `integratorBps` of every harvest. Typically the
    ///         launchpad that originated the market. Zero only when
    ///         `integratorBps` is zero.
    address public integrator;

    // ── State ─────────────────────────────────────────────────────────────────

    /// @notice USDC harvested and owed to `lp`, not yet claimed.
    uint256 public lpAccrued;

    /// @notice USDC harvested and owed to `integrator`, not yet claimed.
    uint256 public integratorAccrued;

    /// @notice Lifetime totals, for display and accounting.
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
    /// @dev The pool-side pull failed and was skipped. Emitted rather than
    ///      reverted so a claim of what is already held still goes through.
    event PoolClaimFailed();
    event LpFeesClaimed(address indexed to, uint256 amount);
    event IntegratorFeesClaimed(address indexed to, uint256 amount);
    event LpTransferred(address indexed from, address indexed to);
    event IntegratorTransferred(address indexed from, address indexed to);

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param pool_           EXNIHILOPool this vault will hold the LP NFT for.
     * @param lpNft_          Shared LpNFT contract.
     * @param lpNftId_        Token id governing `pool_`. Cross-checked against
     *                        lpNft.poolOf so a vault cannot be pointed at the
     *                        wrong market.
     * @param lp_             Receives the LP share. Must be non-zero.
     * @param integrator_     Receives the integrator share. May be zero only if
     *                        `integratorBps_` is zero.
     * @param integratorBps_  Integrator's cut of the LP fee stream (0–10000).
     */
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

        // The vault is normally deployed before the NFT arrives, so ownership
        // cannot be checked here — but the id/pool pairing can, and a mismatch
        // would silently create a vault that can never harvest anything.
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

    /**
     * @notice Pull the pool's accrued LP fees into this vault and split them.
     *         Permissionless — the proceeds can only ever reach `lp` and
     *         `integrator`, so anyone may trigger it (a keeper, either party, or
     *         a claim below).
     *
     * @return amount USDC harvested. Zero when the pool had nothing accrued.
     */
    function harvest() external nonReentrant returns (uint256 amount) {
        // Strict: an explicit harvest that cannot reach the pool has failed,
        // and the caller asked for exactly that call.
        return _harvest(true);
    }

    /**
     * @dev Harvestable is everything held that is not already earmarked, rather
     *      than the delta produced by claimFees. The difference matters: this
     *      contract has no admin and no rescue path, so USDC sent here directly
     *      would otherwise be stranded forever. Measuring the balance splits it
     *      to the two parties instead.
     */
    function _harvest(bool strict) internal returns (uint256 amount) {
        // claimFees reverts ZeroAmount when nothing has accrued, so only call it
        // when the pool actually holds something.
        //
        // `strict` decides whether a pool-side failure is fatal to this call.
        //
        // Both claim paths used to run this unconditionally and strictly, so one
        // reverting claimFees — a USDC blacklist on this vault, a paused token —
        // froze USDC that had ALREADY been harvested and was already sitting
        // here. A failure to collect NEW income became a failure to pay out OLD
        // income (audit IA-R2-7 / ECS-R2-3).
        //
        // The callers pass strict = "the balance is empty". With nothing banked
        // the whole claim depends on this pull, so its failure is the caller's
        // to see; with something banked, nothing about that money depends on
        // the pull and it must not be held hostage to it. Reverts are therefore
        // only ever swallowed in the case where they cost this call new fees
        // and nothing else — those stay in the pool for a later harvest.
        // claimFees takes a destination, and this deliberately always passes
        // address(this) rather than forwarding one (audit LOW-DOS-4). The hatch
        // is unusable here by construction: the split below is derived from
        // this contract's own USDC balance, so income routed anywhere else is
        // income this contract cannot see, cannot split, and cannot credit to
        // either party. Sending it to a rescue address would not rescue it — it
        // would leave it unattributed. The freeze that made the missing hatch
        // look load-bearing is handled above instead, by not requiring this
        // call to succeed before banked balances can be paid out.
        if (pool.lpFeesAccumulated() != 0) {
            if (strict) {
                pool.claimFees(address(this));
            } else {
                try pool.claimFees(address(this)) {
                    // Collected; the balance below now includes it.
                } catch {
                    emit PoolClaimFailed();
                }
            }
        }

        // Cannot underflow: accrued balances are only ever created by this
        // function from USDC already held, and a claim decrements both together.
        amount = usdc.balanceOf(address(this)) - lpAccrued - integratorAccrued;

        if (amount == 0) return 0;

        // Truncating division, so the sub-atom remainder goes to the LP rather
        // than being carried (audit IA-R2-6). Kept: the asymmetry is bounded by
        // one atom per harvest and only reachable by donating dust and
        // harvesting it, which costs the donor far more gas than the integrator
        // loses. Carrying it would add state to every harvest to move a
        // fraction of a cent.
        uint256 integratorCut = (amount * integratorBps) / BPS_DENOM;
        uint256 lpCut         = amount - integratorCut; // dust favours the LP

        lpAccrued         += lpCut;
        integratorAccrued += integratorCut;
        harvestedTotal    += amount;

        emit Harvested(amount, lpCut, integratorCut);
    }

    // ── Claims ────────────────────────────────────────────────────────────────

    /**
     * @notice Claim the LP's accrued share. Harvests first, so a caller never
     *         has to sequence two transactions to collect everything owed.
     *
     * @param to Destination. Separate from `lp` so a party that cannot receive
     *           USDC directly can still redirect its own balance.
     */
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

    /**
     * @notice Claim the integrator's accrued share. Harvests first.
     *
     * @param to Destination. See claimLpFees.
     */
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

    /**
     * @notice Hand the LP claim role to another address. Only the current holder
     *         may do this, and any balance already accrued goes with the role —
     *         claim first if that is not intended.
     *
     * @dev    Zero is rejected: the LP share is always non-zero unless the
     *         integrator takes 100 %, so an unset `lp` would strand it.
     */
    function setLp(address newLp) external {
        if (msg.sender != lp) revert NotLp();
        if (newLp == address(0)) revert ZeroAddress();

        emit LpTransferred(lp, newLp);
        lp = newLp;
    }

    /**
     * @notice Hand the integrator claim role to another address. Only the
     *         current holder may do this; accrued balance goes with it.
     */
    function setIntegrator(address newIntegrator) external {
        if (msg.sender != integrator) revert NotIntegrator();
        if (newIntegrator == address(0)) revert ZeroAddress();

        emit IntegratorTransferred(integrator, newIntegrator);
        integrator = newIntegrator;
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /**
     * @notice What each party would hold after harvesting right now — accrued
     *         balance plus their share of what is still sitting in the pool.
     */
    function pending() external view returns (uint256 lpPending, uint256 integratorPending) {
        // Mirrors _harvest: pool-side accruals plus anything already sitting
        // here unearmarked.
        uint256 unharvested = pool.lpFeesAccumulated()
            + (usdc.balanceOf(address(this)) - lpAccrued - integratorAccrued);
        uint256 integratorCut = (unharvested * integratorBps) / BPS_DENOM;

        lpPending         = lpAccrued + (unharvested - integratorCut);
        integratorPending = integratorAccrued + integratorCut;
    }

    /// @notice True once the LP NFT has actually been transferred in. Until then
    ///         harvesting reverts inside the pool's own onlyLpHolder check.
    function isFunded() external view returns (bool) {
        return lpNft.ownerOf(lpNftId) == address(this);
    }

    // ── ERC-721 receiver ──────────────────────────────────────────────────────

    /**
     * @dev PreMarket and EXNIHILOFactory both hand the NFT over with plain
     *      transferFrom, which needs no hook. This exists so a wallet moving the
     *      NFT in with safeTransferFrom cannot fail — the NFT is meant to be
     *      easy to lock and impossible to unlock.
     */
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
