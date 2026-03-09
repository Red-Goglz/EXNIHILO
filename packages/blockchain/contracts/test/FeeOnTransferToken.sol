// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title FeeOnTransferToken
 * @notice ERC-20 that silently deducts a 1 % fee on every transferFrom when
 *         feeEnabled is true. The caller sends `amount` but the recipient
 *         receives only 99 % of it, so a pool that checks
 *         balanceAfter - balanceBefore == amount will revert.
 *
 *         The fee is togglable so that initial pool setup (addLiquidity via
 *         factory) can succeed before the guard is exercised in tests.
 *
 *         Used ONLY in unit tests to exercise the FeeOnTransferNotSupported
 *         guard in EXNIHILOPool._transferIn. Must never be deployed live.
 */
contract FeeOnTransferToken is ERC20 {
    uint8 private immutable _dec;

    /// @notice When true, transferFrom delivers only 99 % of the requested amount.
    bool public feeEnabled;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        ERC20(name_, symbol_)
    {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) { return _dec; }

    function mint(address to, uint256 amount) external { _mint(to, amount); }

    function enableFee()  external { feeEnabled = true;  }
    function disableFee() external { feeEnabled = false; }

    /**
     * @dev When feeEnabled, spends the full allowance but delivers only 99 %
     *      of `amount` to `to` — simulating a fee-on-transfer token.
     */
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) public override returns (bool) {
        if (feeEnabled) {
            uint256 fee = amount / 100; // 1 % silently withheld
            _spendAllowance(from, msg.sender, amount);
            _transfer(from, to, amount - fee);
            return true;
        }
        return super.transferFrom(from, to, amount);
    }
}
