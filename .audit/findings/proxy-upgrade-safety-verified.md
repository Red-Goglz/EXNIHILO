# Proxy & Upgrade Safety Report — EXNIHILO

## Scope

- **Contracts:** EXNIHILOPool, PositionNFT, EXNIHILOFactory, EXNIHILORouter, LpNFT, AirToken

---

## Analysis

**No proxy or upgradeable patterns are used anywhere in the codebase.**

Confirmed via comprehensive search:
- Zero matches for: `delegatecall`, `proxy`, `Upgradeable`, `initializer` (the modifier), `IMPLEMENTATION_SLOT`, `beacon`, `EIP1967`, `proxiableUUID`, `diamondCut`, `__gap`
- Zero imports of any proxy or upgradeable library
- No `fallback()` functions with delegate forwarding in any core contract
- All contracts use standard `constructor()` — no `initialize()` pattern

### Architecture Summary

| Contract | Deployment | State | Upgradeable? |
|----------|-----------|-------|-------------|
| EXNIHILOPool | Deployed per-market by Factory via `new` | Mutable state vars | **No** — immutable code |
| PositionNFT | Deployed once, shared across pools | Mutable mappings | **No** |
| EXNIHILOFactory | Deployed once | Registry + immutables | **No** — immutables, no owner |
| EXNIHILORouter | Deployed once | Stateless | **No** — immutables only |
| LpNFT | Deployed once, shared | Mutable mappings | **No** |
| AirToken | Deployed per-market by Factory via `new` | Standard ERC-20 | **No** |

All contracts are **non-upgradeable** with direct deployment (`new`). The Factory itself has no admin functions beyond `setDeployer` (emergency role transfer). The Pool has no admin upgrade capability — its behavior is fixed at deployment.

---

## Checklist Results

- [x] Proxy storage collision: **N/A — no proxy**
- [x] Uninitialized implementation: **N/A — no proxy**
- [x] Function selector clashing: **N/A — no proxy admin functions**
- [x] Missing upgrade authorization: **N/A — no upgrade path**
- [x] Delegatecall context confusion: **N/A — no delegatecall**
- [x] Initialization front-running: **N/A — uses constructors, not initializers**

The `initPool()` (AirToken) and `initFactory()` (PositionNFT) are one-time wiring functions called by the Factory/deployer immediately after deployment. They are protected by deployer/factory checks and once-only guards, but they are NOT proxy initialization functions — they're post-deployment configuration.

---

## Summary

```
Final:  0 CRITICAL | 0 HIGH | 0 MEDIUM | 0 LOW | 0 INFO
```

**All five proxy vulnerability classes are inapplicable.** The EXNIHILO architecture uses direct deployment with immutable code. This eliminates the entire proxy/upgrade attack surface, which is a significant security advantage — proxy-related bugs account for a substantial portion of smart contract exploits.

The trade-off is that bugs cannot be fixed post-deployment; a new factory and pools must be deployed. This is mitigated by the permissionless market creation model — if a bug is found, new pools with fixed code can be deployed while the LP closes the old pool via `closePool()`.
