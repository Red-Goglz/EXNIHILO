# Signature & Replay Analysis Report — EXNIHILO

**Auditor:** claude-sonnet-4-6
**Date:** 2026-04-17
**Baseline:** `.audit/findings/signature-replay-verified.md` (claude-sonnet-4-5)

---

## Scope

- `EXNIHILOPool.sol`
- `PositionNFT.sol`
- `EXNIHILOFactory.sol`
- `EXNIHILORouter.sol`
- `LpNFT.sol`
- `AirToken.sol`

---

## Searches Performed

| Pattern | Tool | Result |
|---|---|---|
| `ecrecover` | grep -rn | 0 matches |
| `ECDSA` | grep -rn | 0 matches |
| `permit` | grep -rn | 0 matches |
| `EIP712` | grep -rn | 0 matches |
| `SignatureChecker` | grep -rn | 0 matches |
| `IERC1271` | grep -rn | 0 matches |
| `_hashTypedData` | grep -rn | 0 matches |
| `Domain` | grep -rn | 0 matches |
| `signature` (case-insensitive) | grep -rni | 0 matches |
| `recover` (case-insensitive) | grep -rni | 0 matches |
| `nonce` (case-insensitive) | grep -rni | 0 matches |
| `v, r, s` params / imports | grep -rn | 0 matches |

Note: `deadline` appears extensively in `EXNIHILOPool.sol` and `PositionNFT.sol` — this is a
position-expiry timestamp stored on-chain (e.g., `pos.deadline`, `extendDeadline()`), not
a signature expiry parameter. It carries no signature-replay relevance.

---

## Analysis

**No signature verification exists anywhere in the codebase.**

All six in-scope contracts contain zero off-chain cryptographic authorization. Authorization
is performed exclusively via on-chain identity:

- `msg.sender` checked against stored addresses (pool, factory, deployer roles)
- NFT ownership enforced via ERC-721 `ownerOf()` on `PositionNFT` and `LpNFT`
- No meta-transactions, no gasless relays, no permit flows

---

## Checklist Results

All items N/A — no signature surface exists:

| Check | Status |
|---|---|
| Same-chain replay (nonce) | N/A |
| Cross-chain replay (chainId in domain separator) | N/A |
| Cross-contract replay (verifyingContract) | N/A |
| Nonce ordering / skip attack | N/A |
| Signature deadline / expiry | N/A |
| `ecrecover` returns `address(0)` | N/A |
| ECDSA s-value upper-half malleability | N/A |
| v = 27/28 normalization | N/A |
| Domain separator fork-safety | N/A |
| ERC-1271 contract wallet support | N/A |

---

## Summary

```
Final:  0 CRITICAL | 0 HIGH | 0 MEDIUM | 0 LOW | 0 INFO
```

The entire signature-replay attack surface is absent. EXNIHILO uses exclusively on-chain
authorization with no off-chain cryptographic components.

---

## Delta vs 4.6

- **No change in findings:** both audits confirm zero signature-based mechanisms across all
  six contracts. Result remains 0 issues at every severity level.
- **Deadline clarification added:** this audit explicitly notes that `deadline` occurrences
  are on-chain position-expiry fields unrelated to signature replay, closing a potential
  false-positive ambiguity not addressed in the 4.6 baseline.
- **Search surface expanded:** 4.7 audit added case-insensitive sweeps for `signature`,
  `recover`, and `nonce` in addition to the exact-match patterns used by 4.6, with the same
  null result, strengthening confidence in the clean finding.
