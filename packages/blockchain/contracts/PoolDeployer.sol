// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "./EXNIHILOPool.sol";

/**
 * @title  PoolDeployer
 * @notice Stateless deployer that creates EXNIHILOPool instances on behalf of
 *         EXNIHILOFactory.  Extracting the `new EXNIHILOPool(...)` call into a
 *         separate contract keeps the Factory under the 24 576-byte EIP-170
 *         code-size limit (the Pool's creation bytecode is embedded here instead).
 */
contract PoolDeployer {
    function deploy(
        address airToken,
        address airUsdToken,
        address tokenAddress,
        address usdc,
        address positionNFT,
        address lpNftContract,
        uint256 lpNftId,
        address protocolTreasury,
        uint256 maxPositionUsd,
        uint256 maxPositionBps,
        uint256 defaultSwapFeeBps,
        uint256 positionDuration,
        address factory
    ) external returns (address) {
        EXNIHILOPool pool = new EXNIHILOPool(
            airToken,
            airUsdToken,
            tokenAddress,
            usdc,
            positionNFT,
            lpNftContract,
            lpNftId,
            protocolTreasury,
            maxPositionUsd,
            maxPositionBps,
            defaultSwapFeeBps,
            positionDuration,
            factory
        );
        return address(pool);
    }
}
