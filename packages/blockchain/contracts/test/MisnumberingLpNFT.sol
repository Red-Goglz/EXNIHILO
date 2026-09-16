// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @notice Test-only LpNFT stand-in whose mint returns a fixed id, to trigger
///         EXNIHILOFactory's LpNftIdMismatch check.
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
