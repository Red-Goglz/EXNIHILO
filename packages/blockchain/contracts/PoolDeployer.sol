// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "./EXNIHILOPool.sol";

/**
 * @title  PoolDeployer
 * @notice Deploys EXNIHILOPool for the factory, keeping the pool's creation code
 *         out of the factory (EIP-170 size limit).
 */
contract PoolDeployer {
    error FactoryMismatch();

    function deploy(
        address tokenAddress,
        address usdc,
        uint8   tokenDecimals,
        address positionNFT,
        address lpNftContract,
        uint256 lpNftId,
        address protocolTreasury,
        address factory
    ) external returns (address) {
        // A caller can only name itself as the pool's factory, so nobody can deploy
        // a pool that borrows the real factory's emergency deployer.
        if (msg.sender != factory) revert FactoryMismatch();

        EXNIHILOPool pool = new EXNIHILOPool(
            tokenAddress,
            usdc,
            tokenDecimals,
            positionNFT,
            lpNftContract,
            lpNftId,
            protocolTreasury,
            factory
        );
        return address(pool);
    }
}
