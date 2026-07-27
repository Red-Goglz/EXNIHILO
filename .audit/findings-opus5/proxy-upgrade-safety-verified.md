# Proxy & Upgrade Safety — Verified (Opus 5)

**Date:** 2026-07-27
**Scope:** all contracts in `packages/blockchain/contracts`

```
0 CRITICAL | 0 HIGH | 0 MEDIUM | 0 LOW
```

## Result: not applicable — no proxy surface exists

Evidence (whole-directory greps):

| Pattern | Occurrences |
|---|---|
| `delegatecall` / `DELEGATECALL` | **0** |
| `Initializable`, `UUPS`, `ERC1967`, `Beacon`, `Diamond`, `__gap`, `proxy` | **0** |

Every contract is deployed directly and initialized in its `constructor`
(`EXNIHILOPool`, `EXNIHILORouter`, `Faucet`, `LpNFT`, `PositionNFT`,
`EXNIHILOFactory`). `PoolDeployer` is stateless with no constructor.

Consequently none of the classes this pass exists to find can occur:
storage-layout collision, uninitialized implementation, function-selector
clash, delegatecall context confusion, or an unsafe upgrade path. There is no
implementation/proxy split and no admin able to change code.

## Note carried from the Nemesis pass

Immutability cuts both ways: because nothing is upgradeable, **any defect is
permanent for a deployed pool**. The only remediation path is deploying a new
factory and migrating liquidity. This raises the value of pre-deployment review
and is the reason PROCESS-001 (audits not matching deployed code) is treated as
the most serious finding of this round.

## One-time initialization to re-check on every deployment

`PositionNFT.initFactory` is a post-construction wiring step. Prior finding
NM-001 ("PositionNFT mint accessible before initFactory") remains open and is
re-confirmed as LOW: between deployment and `initFactory`, the mint path is not
yet gated on a factory-registered pool. `deployLocal.ts` and `deployFuji.ts`
both call it in the same script immediately after the factory is deployed, so
the window is one transaction wide and controlled by the deployer. Not
exploitable by a third party in the deployed flow.
