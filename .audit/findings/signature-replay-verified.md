# Signature & Replay Analysis Report — EXNIHILO

## Scope

- **Contracts:** EXNIHILOPool, PositionNFT, EXNIHILOFactory, EXNIHILORouter, LpNFT, AirToken

---

## Analysis

**No signature verification exists anywhere in the codebase.**

Confirmed via comprehensive search — zero matches for: `ecrecover`, `ECDSA`, `recover(`, `signature`, `permit`, `EIP712`, `domainSeparator`, `v, r, s`.

All authorization is performed via on-chain identity:
- `msg.sender` checks against stored addresses (pool, factory, deployer)
- NFT ownership via `ownerOf()` (ERC-721 standard)
- No off-chain signed messages, meta-transactions, or gasless relays

---

## Checklist Results

All items N/A — no signature surface exists:

- Nonce for same-chain replay: N/A
- chainId for cross-chain replay: N/A
- address(this) for cross-contract replay: N/A
- Deadline/expiry: N/A
- ecrecover address(0) check: N/A
- s-value enforcement: N/A
- Domain separator fork safety: N/A
- ECDSA library usage: N/A
- ERC-1271 contract wallet support: N/A

---

## Summary

```
Final:  0 CRITICAL | 0 HIGH | 0 MEDIUM | 0 LOW | 0 INFO
```

The entire signature replay attack surface is absent. EXNIHILO uses exclusively on-chain authorization (`msg.sender`, NFT ownership) with no off-chain signature components.
