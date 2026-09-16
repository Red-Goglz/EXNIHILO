---
description: "Deployed EXNIHILO contract addresses on Avalanche C-Chain mainnet (chain ID 43114), the local development addresses, and what to update after a redeploy."
---

# Contract Addresses

## Avalanche C-Chain mainnet (chain ID 43114)

Source of truth: `packages/site/src/contracts/mainnetAddresses.json`, written by
`scripts/deployMainnet.ts`. Values below were read back from chain.

| Contract | Address |
|---|---|
| EXNIHILOFactory | `0xBe6Fb0e7b7d8EFD491FEbC436F737cE8B244F85a` |
| PoolDeployer | `0xCC2dF79E5B67874ceeBDB09225aCd62dE2C9CA44` |
| PositionNFT | `0xa08E20fb4c157cf8E46c67A41250F54c1b53adfd` |
| LpNFT | `0x71a6802e1b1313822014D29c5Fe43Dd441a4dB9a` |
| EXNIHILORouter | `0xCeDaa217205975a7a86322FEe13b9ee223F98B15` |
| USDC (native, Circle) | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` |
| Treasury | `0x10b17CC3cb1BB186D30e430495371b61B497dD37` |
| Deployer | `0xE15405a36fdbB3197e1B690E87303CCFcd038e97` |

The factory was deployed at block **91,382,693**, the indexer's start block. Markets are created
by users with `createMarket`; there are no official ones. USDC is Circle's native 6-decimal USDC,
not bridged `USDC.e`.

::: warning Immutable
The factory has no owner. `usdc` and `protocolTreasury` are constructor immutables and every pool
parameter is a contract constant, so changing any of them means deploying a new protocol. The
contracts listed here still carry one privileged role, `deployer` — currently the deploying EOA
above — which can call `closePool` on any pool. The next deployment removes it: its factory has no
role at all, and only a pool's own LP can close it.
:::

Each market is one `EXNIHILOPool`, emitted in `MarketCreated` and listed by
`factory.allPools(i)` / `factory.allPoolsLength()`.

## Local Hardhat node (chain ID 31337)

`scripts/deployLocal.ts` starts with `hardhat_reset` and writes
`packages/site/src/contracts/localAddresses.json`. On a fresh node the core addresses are
deterministic:

| Contract | Address |
|---|---|
| USDC (mock) | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| PositionNFT | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |
| LpNFT | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |
| EXNIHILOFactory | `0x98eDDadCfde04dC22a0e62119617e74a6Bc77313` |
| ARENA (test token) | `0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9` |
| Treasury | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |
| Deployer | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |

The local script does not deploy `EXNIHILORouter`.

## After a redeploy

Nothing is upgradeable, so every contract change is a redeploy with new addresses:

1. `deployMainnet.ts` rewrites `mainnetAddresses.json`, which the indexer reads directly.
2. Update `packages/site/src/contracts/addresses.ts` by hand.
3. Bump the indexer's Ponder schema (`--schema` in `packages/indexer/package.json`) — Ponder does
   not migrate a schema in place.
4. Update this page.

A mismatch is silent: the app simply shows an abandoned deployment.
