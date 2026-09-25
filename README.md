# EXNIHILO

**Long or short any ERC-20 on Avalanche. You pay a fee, not collateral — and that fee is the most you
can lose.** Create a market for any token, open a position, and hold it as a transferable NFT. No
liquidations, no expiry.

Full documentation: [exnihilo.markets/docs](https://exnihilo.markets/docs) (source in `packages/docs`).

## Overview

Each market is an isolated pool with a single LP, who is the counterparty to every position in it:

- **Swaps** — a constant-product AMM between the token and USDC
- **Longs and shorts** — opened for a fee, settled against the pool's curves, capped by pool size
- **Funding** — positions never expire; instead each side shrinks continuously, and the released
  collateral goes to the LP
- **LP income** — 4% of every open, the impact fee, funding and swap fees

## Monorepo structure

```
packages/
├── blockchain/   Solidity contracts, Hardhat tests and scripts
├── site/         React 19 app (wagmi / viem)
├── indexer/      Ponder indexer and Hono API
├── sdk/          @exnihilio/sdk — typed client
├── abis/         @exnihilio/abis — shared ABIs
├── arbbot/       Read-only arbitrage scanner
└── docs/         VitePress documentation
```

## Contracts

| Contract | Description |
|---|---|
| `EXNIHILOPool` | Swaps, positions, funding, liquidity and fees for one market |
| `EXNIHILOFactory` | Creates and seeds markets; no owner, no privileged role |
| `EXNIHILORouter` | One USDC approval for opens and swaps on every pool |
| `PoolDeployer` | Holds the pool bytecode for the factory |
| `PositionNFT` / `LpNFT` | ERC-721 position records (on-chain SVG) and pool ownership |
| `PreMarketFactory` / `PreMarket` | Launchpad: seed a token, auction the reserve, launch the market |
| `LockedLpVault` | Holds a launched market's LP NFT and splits its fees |

Solidity 0.8.24 (viaIR). No proxies, no owner, every pool parameter a constant.
See [Architecture](packages/docs/protocol/architecture.md) and [Security](packages/docs/protocol/security.md).

## Getting started

Requires Node.js 20.19+ (Vite 7) and npm 9+.

```bash
npm install

# Contracts
cd packages/blockchain
npx hardhat test                    # 673 tests
REPORT_GAS=true npx hardhat test
npx hardhat coverage

# Local chain (writes packages/site/src/contracts/localAddresses.json)
npx hardhat node
npx hardhat run scripts/deployLocal.ts --network localhost

# From the repo root
npm run dev                         # app — http://localhost:5000
npm run dev:indexer                 # indexer — http://localhost:42069
npm run dev -w packages/docs        # docs — http://localhost:5173
```

Copy each package's `.env.example` (`blockchain/.env`, `site/.env`, `indexer/.env.local`) before
deploying or running against mainnet. Details: [Local Development](packages/docs/developers/local-dev.md).

## Mainnet deployment

The app supports Avalanche C-Chain mainnet only (`packages/site/src/lib/chains.ts`). Deployed
addresses: [Contract Addresses](packages/docs/protocol/addresses.md).

```bash
cd packages/blockchain
# Rehearse against a mainnet fork first — nothing is spent:
FORK_AVALANCHE=1 DRY_RUN=1 MAINNET_PROTOCOL_TREASURY=0x... \
  npx hardhat run scripts/deployMainnet.ts

MAINNET_PROTOCOL_TREASURY=0x... \
  npx hardhat run scripts/deployMainnet.ts --network avalanche
```

This deploys the protocol only, against Circle's native USDC — no mocks and no markets, since market
creation is permissionless. `deployMainnet.ts` writes `mainnetAddresses.json`, which the site and the
indexer both read. Contract verification goes through Routescan; see `hardhat.config.ts`.

## Fees

| Fee | Amount | Destination |
|---|---|---|
| Open (base) | 5% of notional (min 0.05 USDC) | 4% LP, 1% protocol |
| Open (impact) | `15% × N × (2·OI + N) / (2 · backedAirUsd)` | LP |
| Funding | 10% + 20% × utilization per window (1 hour + market age, max 30 days) | LP, in reserves |
| Swap | 1% | LP, in reserves |
| Close | 1% of profit | Protocol |

Every rate is a contract constant. See [Fees](packages/docs/protocol/fees.md).
