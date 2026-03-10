// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title AirToken
 * @notice ERC-20 wrapper token used inside an EXNIHILO pool.
 *         Deployed twice per market: once as airToken, once as airUsd.
 *         Only the owning pool may mint or burn tokens.
 *
 * Deployment flow (handled by Factory):
 *   1. Factory deploys AirToken  →  factory address stored as immutable.
 *   2. Factory deploys Pool.
 *   3. Factory calls initPool(poolAddress) to wire the two contracts.
 *   After initPool, only the pool can mint/burn; initPool cannot be called again.
 */
contract AirToken is ERC20 {
    /// @notice The pool contract that owns this token. Set once via initPool().
    address public pool;

    /// @notice The factory that deployed this token. Only it may call initPool().
    address public immutable factory;

    uint8 private immutable _decimals;

    // ── Errors ────────────────────────────────────────────────────────────────

    error OnlyPool();
    error OnlyFactory();
    error PoolAlreadySet();
    error ZeroAddress();

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyPool() {
        if (msg.sender != pool) revert OnlyPool();
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param name_     Token name  (e.g. "airPEPE" or "airPEPEUsd")
     * @param symbol_   Token symbol (same convention as name)
     * @param decimals_ Decimals matching the underlying asset (18 for token, 6 for USDC)
     */
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ERC20(name_, symbol_) {
        factory = msg.sender;
        _decimals = decimals_;
    }

    // ── Initialisation ────────────────────────────────────────────────────────

    /**
     * @notice Wire this token to its pool. Called once by the factory after
     *         the pool contract is deployed.
     * @param pool_ Address of the owning pool contract.
     */
    function initPool(address pool_) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (pool != address(0)) revert PoolAlreadySet();
        if (pool_ == address(0)) revert ZeroAddress();
        pool = pool_;
    }

    // ── Pool-only mint / burn ─────────────────────────────────────────────────

    /**
     * @notice Mint `amount` tokens to `to`. Only callable by the pool.
     */
    function mint(address to, uint256 amount) external onlyPool {
        _mint(to, amount);
    }

    /**
     * @notice Burn `amount` tokens from `from`. Only callable by the pool.
     */
    function burn(address from, uint256 amount) external onlyPool {
        _burn(from, amount);
    }

    // ── ERC-20 overrides ──────────────────────────────────────────────────────

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}
