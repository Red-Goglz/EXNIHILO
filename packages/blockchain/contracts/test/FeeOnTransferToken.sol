// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title  FeeOnTransferToken
 * @notice Test-only ERC-20 whose transferFrom delivers 99 % of `amount` while
 *         feeEnabled (off by default, so setup can succeed first).
 */
contract FeeOnTransferToken is ERC20 {
    uint8 private immutable _dec;

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
