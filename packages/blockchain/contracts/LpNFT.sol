// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/**
 * @title LpNFT
 * @notice Represents sole LP ownership of an EXNIHILO pool.
 *         One token is minted per pool at market creation and is fully
 *         transferable — transferring it passes all LP rights with it
 *         (liquidity add/withdraw, fee claims, position liquidation).
 *
 * All LP business logic lives in the Pool contract, which calls
 * ownerOf(lpNftId) to verify the caller's authority.  This contract
 * only needs to mint tokens and expose which pool each token belongs to.
 *
 * Access control
 * ──────────────
 * mint  →  only the factory that deployed this contract.
 */
contract LpNFT is ERC721 {
    // ── State ──────────────────────────────────────────────────────────────────

    /// @notice Factory that deployed this contract. Only it may call mint().
    address public immutable factory;

    uint256 private _nextTokenId;

    /// @notice Maps each LP token ID to the pool address it represents.
    mapping(uint256 => address) private _poolOf;

    // ── Errors ─────────────────────────────────────────────────────────────────

    error OnlyFactory();
    error TokenNotFound();
    error ZeroAddress();

    // ── Constructor ────────────────────────────────────────────────────────────

    /// @param factory_ The EXNIHILOFactory that will be the sole authorised minter.
    ///                 Must be non-zero; cannot be changed after deployment.
    constructor(address factory_) ERC721("EXNIHILO LP", "EXLP") {
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
    }

    // ── Views ──────────────────────────────────────────────────────────────────

    /**
     * @notice Returns the pool address associated with `tokenId`.
     * @dev Reverts if the token does not exist.
     */
    function poolOf(uint256 tokenId) external view returns (address) {
        if (_poolOf[tokenId] == address(0)) revert TokenNotFound();
        return _poolOf[tokenId];
    }

    // ── Factory-only mint ──────────────────────────────────────────────────────

    /**
     * @notice Mint one LP NFT for a newly created pool.
     *         Called by the factory once per pool deployment.
     *
     * @param to    Recipient — the market creator.
     * @param pool  The pool contract this LP NFT governs.
     * @return tokenId  The newly minted token ID.
     */
    function mint(address to, address pool) external returns (uint256 tokenId) {
        if (msg.sender != factory) revert OnlyFactory();
        if (pool == address(0)) revert ZeroAddress();

        tokenId = _nextTokenId++;
        _poolOf[tokenId] = pool;
        _safeMint(to, tokenId);
    }
}
