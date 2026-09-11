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
    /// @dev The caller named a factory other than itself.
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
        // The caller must name ITSELF as the pool's factory.
        //
        // This is deliberately not an `onlyFactory` allowlist. A fixed factory
        // address cannot go in the constructor — the factory takes this
        // contract's address in ITS constructor, so this one is deployed first
        // — and the alternative, an initFactory hop, would put a mandatory
        // extra step in every deployment path for no additional protection:
        // a pool this contract creates for anyone else is already inert.
        // PositionNFT gates minting on IEXNIHILOFactory(factory).isPool(pool)
        // and LpNFT.mint on msg.sender == factory, so an unregistered pool can
        // mint neither positions nor an LP NFT.
        //
        // What was genuinely missing is the tie between the caller and the
        // factory the pool will name. Without it anyone could deploy a pool
        // pointing at the REAL factory — one that calls factory.deployer() for
        // its emergency-close authority (EXNIHILOPool.closePool) while the
        // factory has never heard of it. Now a forged pool can only ever name
        // its own creator, which is the address that already controls it
        // (audit PU-001).
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
