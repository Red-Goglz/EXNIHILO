// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/**
 * @title  LpNFT
 * @notice One transferable NFT per pool; its owner holds that pool's LP rights.
 *         Minted only by the factory.
 */
contract LpNFT is ERC721 {
    /// @notice The only address allowed to mint.
    address public immutable factory;

    uint256 private _nextTokenId;
    mapping(uint256 => address) private _poolOf;

    error OnlyFactory();
    error TokenNotFound();
    error ZeroAddress();

    constructor(address factory_) ERC721("EXNIHILO LP", "EXLP") {
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
    }

    /// @notice Pool governed by `tokenId`; reverts if unknown.
    function poolOf(uint256 tokenId) external view returns (address) {
        if (_poolOf[tokenId] == address(0)) revert TokenNotFound();
        return _poolOf[tokenId];
    }

    /// @notice Factory only: mint the LP NFT for `pool` to `to`.
    function mint(address to, address pool) external returns (uint256 tokenId) {
        if (msg.sender != factory) revert OnlyFactory();
        if (pool == address(0)) revert ZeroAddress();

        tokenId = _nextTokenId++;
        _poolOf[tokenId] = pool;
        _mint(to, tokenId);
    }
}
