# Signature & Replay — Verified (Opus 5)

**Date:** 2026-07-27
**Scope:** all contracts in `packages/blockchain/contracts`

```
0 CRITICAL | 0 HIGH | 0 MEDIUM | 0 LOW
```

## Result: not applicable — no off-chain signature surface exists

Evidence (whole-directory greps):

| Pattern | Occurrences |
|---|---|
| `ecrecover` | **0** |
| `ECDSA`, `SignatureChecker`, `isValidSignature` (ERC-1271) | **0** |
| `EIP712`, `_domainSeparator` | **0** |
| `permit(`, `nonces` | **0** |

No function in the protocol accepts a signature, and no meta-transaction,
relayer, or gasless-approval path exists. Every authorization is a direct
`msg.sender` check:

- `onlyLpHolder` → `lpNftContract.ownerOf(lpNftId) != msg.sender`
- `onlyOwner` (Faucet, LpNFT) → `msg.sender == owner`
- `claimProtocolFees` → `msg.sender != protocolTreasury`
- `closeLong` / `closeShort` / `renewPosition` → `positionNFT.ownerOf(nftId) != msg.sender`
- `applyRenewal` (PositionNFT) → `msg.sender != pos.pool`

None of the five replay classes this pass targets (same-chain, cross-chain,
cross-contract, nonce-skip, expired-signature) has a surface to attack, and the
`ecrecover` edge cases (`address(0)` return, s-value malleability) cannot arise.

## Adjacent replay-shaped risk that DOES exist (and is handled)

Approval front-running via ERC-20 `approve` race is the nearest analogue. The
protocol's own approvals are set and cleared within a single transaction in
`EXNIHILORouter` (`forceApprove(pool, fee)` → call → `forceApprove(pool, 0)`),
so no standing allowance is left for a third party to race.

Prior finding **NM-002** ("Factory residual approvals not revoked after
addLiquidity") remains open and LOW: the factory may leave a residual allowance
to a pool it itself deployed. The spender is a protocol contract, not an
arbitrary address, so this is hygiene rather than an exploit.
