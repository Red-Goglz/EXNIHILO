# Proxy & Upgrade Safety — EXNIHILO (4.7 re-audit)

## Scope

All contracts under `packages/blockchain/contracts/`:
`EXNIHILOPool.sol`, `PositionNFT.sol`, `EXNIHILOFactory.sol`, `EXNIHILORouter.sol`, `LpNFT.sol`, `AirToken.sol`, `PoolDeployer.sol`.

## Methodology

1. Grep for upgradeability primitives (`@openzeppelin/contracts-upgradeable`, `Initializable`, `UUPSUpgradeable`, `TransparentUpgradeableProxy`, `Proxy`, `delegatecall`, `Clones`, `CREATE2`).
2. Inspect every `init*` function for access control and single-call protection.
3. Inspect factory/deployer pattern for orphan-artifact potential.
4. Verify storage layout concerns (N/A if not upgradeable).
5. Grep for `delegatecall` anywhere.

## Results

- **No upgradeability primitives** — no `-upgradeable` imports, no `Initializable`, no `UUPSUpgradeable`, no proxy contracts, no `delegatecall` usage anywhere.
- **No storage-layout risk** — non-upgradeable contracts.
- **Factory/CREATE deployment** — `EXNIHILOFactory.createMarket` → `PoolDeployer.deploy` → `new EXNIHILOPool(...)`. Deterministic CREATE (not CREATE2), no pre-deployment front-running risk.

## Findings

### PU-001 — PoolDeployer.deploy has no access control (LOW, NEW)

**Location:** `PoolDeployer.sol:14`

`PoolDeployer.deploy(...)` is `external` with no `onlyFactory` guard. Any caller can invoke it and produce an `EXNIHILOPool` instance.

**Impact:** Orphan pools — not registered in `EXNIHILOFactory.isPool`, no `PositionNFT`/`LpNFT` wiring, no AirToken initialization. Zero fund-loss path, but:
- Pollutes on-chain state with spurious pool bytecode.
- Potential confusion if addresses are enumerated or indexed externally.

**Fix:** Add `require(msg.sender == factory)` or `onlyFactory` modifier to `PoolDeployer.deploy`.

### PU-002 — PositionNFT init window allows spurious mints (INFO)

**Location:** `PositionNFT.sol:227`, `PositionNFT.sol:259`

`mintLong`/`mintShort` guard: `require(msg.sender == pool && (factory == address(0) || !IEXNIHILOFactory(factory).isPool(pool) == false), "onlyPool")` — but when `factory == address(0)` (pre-`initFactory`), the sibling check short-circuits via `||`. Any address can satisfy `msg.sender == pool` by self-referencing from a pool-like contract.

**Impact:** Between `PositionNFT` construction and `initFactory(...)` being called, a prepared attacker could mint spurious NFTs. Deployment scripts close this window atomically (single tx constructor + initFactory), so operationally non-exploitable. No legitimate pool funds reachable.

**Fix:** Hoist `require(factory != address(0))` above the `msg.sender == pool` check, OR perform atomic constructor-set of `factory` with immutable storage.

## Delta vs 4.6

| Item | 4.6 | 4.7 | Change |
|------|-----|-----|--------|
| Upgradeability primitives | None | None | — |
| `delegatecall` usage | None | None | — |
| Findings (LOW) | 0 | 1 (PU-001) | +1 NEW |
| Findings (INFO) | 0 | 1 (PU-002) | +1 NEW |

The 4.6 audit concluded "no findings" which was correct at the architectural level (no upgradeability). This 4.7 re-audit catalogues two granular access-control gaps in the deployment flow — neither has a fund-loss path, but both are defensive-coding gaps worth closing.

**Conclusion:** Architecture remains non-upgradeable and inherently free of proxy/upgrade vulnerability classes. Two low-priority deployment hardening items noted.
