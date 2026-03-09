// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title ReentrantToken
 * @notice Minimal mintable ERC-20 whose transferFrom re-enters a target contract.
 *         Used ONLY in unit tests to exercise the ReentrancyGuard "else" branch.
 *         Must never be deployed on a live network.
 */
contract ReentrantToken is ERC20 {
    uint8 private immutable _dec;

    /// @notice When true, transferFrom re-enters `target` with `data`.
    bool    public  reentrantEnabled;
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

    /**
     * @notice Configure the re-entrancy attack.
     * @param target_   Address to call back into.
     * @param callData_ ABI-encoded call to make during transferFrom.
     */
    function setReentrantCall(address target_, bytes calldata callData_) external {
        target          = target_;
        callData        = callData_;
        reentrantEnabled = true;
    }

    function disableReentrant() external {
        reentrantEnabled = false;
    }

    /**
     * @dev Override transferFrom to inject a re-entrant call when enabled.
     *      The call is made BEFORE completing the actual transfer so the
     *      pool sees the re-entry while its nonReentrant lock is held.
     *      The re-entrant call's revert (from the reentrancy guard) is bubbled
     *      up to ensure the outer transaction also reverts.
     */
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) public override returns (bool) {
        if (reentrantEnabled && target != address(0)) {
            // Disable before calling to prevent infinite recursion.
            reentrantEnabled = false;
            // Use a low-level call and bubble up any revert.
            (bool ok, bytes memory ret) = target.call(callData);
            if (!ok) {
                // Bubble up the revert from the re-entrant call.
                assembly { revert(add(ret, 32), mload(ret)) }
            }
        }
        return super.transferFrom(from, to, amount);
    }
}
