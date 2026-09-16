// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test-only factory stand-in for PositionNFT: registers arbitrary addresses as pools.
contract MockFactory {
    mapping(address => bool) public isPool;

    function setPool(address pool, bool registered) external {
        isPool[pool] = registered;
    }
}
