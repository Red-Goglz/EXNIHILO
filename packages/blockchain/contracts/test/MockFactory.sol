// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @dev Minimal factory stand-in for PositionNFT unit tests. Lets a test
 *      register arbitrary addresses as "pools" so mintLong/mintShort's
 *      registered-pool check can be satisfied without deploying the full
 *      factory + pool system.
 */
contract MockFactory {
    mapping(address => bool) public isPool;

    function setPool(address pool, bool registered) external {
        isPool[pool] = registered;
    }
}
