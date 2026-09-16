// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title  ReentrantToken
 * @notice Test-only ERC-20 whose transferFrom (and optionally transfer) calls
 *         `target` with `callData` once, bubbling up any revert.
 */
contract ReentrantToken is ERC20 {
    uint8 private immutable _dec;

    bool    public  reentrantEnabled;           // re-enter on transferFrom
    bool    public  reentrantOnTransferEnabled; // re-enter on transfer
    address public  target;
    bytes   public  callData;

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

    function setReentrantCall(address target_, bytes calldata callData_) external {
        target          = target_;
        callData        = callData_;
        reentrantEnabled = true;
    }

    function setReentrantTransferCall(address target_, bytes calldata callData_) external {
        target                     = target_;
        callData                   = callData_;
        reentrantOnTransferEnabled = true;
    }

    function disableReentrant() external {
        reentrantEnabled = false;
        reentrantOnTransferEnabled = false;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (reentrantOnTransferEnabled && target != address(0)) {
            reentrantOnTransferEnabled = false;
            (bool ok, bytes memory ret) = target.call(callData);
            if (!ok) {
                assembly { revert(add(ret, 32), mload(ret)) }
            }
        }
        return super.transfer(to, amount);
    }

    /// @dev Re-enters before the transfer, while the caller's lock is held.
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) public override returns (bool) {
        if (reentrantEnabled && target != address(0)) {
            reentrantEnabled = false; // one shot, no recursion
            (bool ok, bytes memory ret) = target.call(callData);
            if (!ok) {
                assembly { revert(add(ret, 32), mload(ret)) }
            }
        }
        return super.transferFrom(from, to, amount);
    }
}
