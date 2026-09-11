// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/**
 * @title  MisnumberingLpNFT
 * @notice LpNFT stand-in that hands back an id the factory did not predict.
 *         Test use only.
 *
 * @dev    EXNIHILOFactory predicts the LP NFT id as `allPools.length` and bakes
 *         it into the pool as an immutable BEFORE minting, because the pool
 *         needs it at construction. The prediction holds only while this
 *         factory is LpNFT's sole minter and mints exactly one NFT per market.
 *
 *         The real LpNFT cannot violate that while those conditions hold, which
 *         is precisely why the mismatch check went untested and sat as a prose
 *         claim for five audit rounds. The factory casts whatever address it is
 *         given to LpNFT without verifying the type, so this contract is enough
 *         to drive the guard from the outside.
 */
contract MisnumberingLpNFT {
    uint256 public immutable idToReturn;

    constructor(uint256 idToReturn_) {
        idToReturn = idToReturn_;
    }

    /// @dev Same selector as LpNFT.mint(address,address).
    function mint(address, address) external view returns (uint256) {
        return idToReturn;
    }
}
