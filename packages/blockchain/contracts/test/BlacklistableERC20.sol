// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title BlacklistableERC20
 * @notice MockERC20 with a blacklist — simulates USDC/USDT-style token
 *         blacklisting behaviour.  Transfers to or from a blacklisted
 *         address revert.  Test use only.
 */
contract BlacklistableERC20 is ERC20 {
    uint8 private immutable _dec;
    mapping(address => bool) public blacklisted;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ERC20(name_, symbol_) {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function blacklist(address account) external {
        blacklisted[account] = true;
    }

    function unblacklist(address account) external {
        blacklisted[account] = false;
    }

    function _update(address from, address to, uint256 amount) internal override {
        require(!blacklisted[from], "BlacklistableERC20: sender blacklisted");
        require(!blacklisted[to],   "BlacklistableERC20: recipient blacklisted");
        super._update(from, to, amount);
    }
}
