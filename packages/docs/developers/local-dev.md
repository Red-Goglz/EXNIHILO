---
description: "Clone, install and run EXNIHILO locally — Hardhat contract tests with gas reporting and coverage, a local node, and deploying the contracts."
---

# Local Development

## Prerequisites

- Node.js 18+
- npm 9+

## Setup

```bash
git clone https://github.com/Red-Goglz/EXNIHILO.git
cd exnihilo
npm install
```

## Running smart contract tests

```bash
cd packages/blockchain

# Run all tests
npx hardhat test

# Run with gas reporting
REPORT_GAS=true npx hardhat test

# Run specific test file
npx hardhat test test/EXNIHILOPool.ts
npx hardhat test test/Coverage.ts

# Coverage report
npx hardhat coverage
```

## Local blockchain + deployment

Terminal 1 — start local Hardhat node:

```bash
cd packages/blockchain
npx hardhat node
```

Terminal 2 — deploy contracts:

```bash
cd packages/blockchain
npx hardhat run scripts/deployLocal.ts --network localhost
```

This deploys all contracts and outputs addresses. The deploy script uses nonce prediction to wire LpNFT ↔ Factory without bytecode patching.

## Running the frontend

```bash
npm run dev -w packages/site
```

Opens at `http://localhost:5000`. The frontend connects to the local Hardhat node by default when chain ID 31337 is configured in your wallet.

## Running the indexer

Price charts, LP APR and the analytics page are served by the indexer, not read
from chain. Without it the app still trades fine, but those are empty.

It needs Postgres:

```bash
docker run -d --name exnihilo-pg -p 5432:5432 \
  -e POSTGRES_USER=exnihilo -e POSTGRES_PASSWORD=exnihilo \
  -e POSTGRES_DB=exnihilo_indexer \
  -v exnihilo-pgdata:/var/lib/postgresql/data \
  --restart unless-stopped postgres:16-alpine
```

Copy `packages/indexer/.env.example` to `.env.local` and point it at the local
chain (the defaults target Avalanche mainnet), using the addresses
`deployLocal.ts` wrote to
`packages/site/src/contracts/localAddresses.json`:

```bash
PONDER_CHAIN_ID=31337
PONDER_START_BLOCK=0
PONDER_RPC_URL_31337=http://127.0.0.1:8545
PONDER_FACTORY_ADDRESS=0x98eDDadCfde04dC22a0e62119617e74a6Bc77313
PONDER_POSITION_NFT_ADDRESS=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
PONDER_LP_NFT_ADDRESS=0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
DATABASE_URL=postgresql://exnihilo:exnihilo@127.0.0.1:5432/exnihilo_indexer
```

Then:

```bash
npm run dev:indexer
```

Serves on `http://localhost:42069`. Point the frontend at it with
`VITE_INDEXER_URL_LOCAL` in `packages/site/.env`.

One instance indexes one chain — see [Indexer](./indexer) for running mainnet
and local side by side, and for the storage, RPC-budget and schema-migration
notes.

## Running the docs

```bash
npm run dev -w packages/docs
```

Opens at `http://localhost:5173`.

## Project structure

```
packages/
├── blockchain/         # Solidity contracts + Hardhat
│   ├── contracts/      # EXNIHILOPool, Factory, NFTs, Router, Faucet
│   ├── test/           # 414 tests
│   └── scripts/        # Deploy scripts (local, Fuji)
├── site/               # React 19 frontend
│   └── src/
│       ├── pages/      # Landing, Feed, Markets, Pool, Portfolio, Create, Analytics
│       ├── components/ # Trade panels, wallet, shared
│       ├── hooks/      # Chain, position, fee-quote, indexer hooks
│       ├── lib/        # AMM math, formatters, chain registry, indexer client
│       └── contracts/  # Address config
├── indexer/            # Ponder event indexer + Hono API
│   ├── src/            # Event handlers, chain config, HTTP routes
│   └── deploy/         # VPS provisioning + systemd unit
├── abis/               # Typed ABI exports (shared by site and indexer)
└── docs/               # VitePress documentation (this site)
```

## Environment variables

**`packages/blockchain/.env`** (copy from `.env.example`):

```
ACCOUNT_PRIVATE_KEY=    # For testnet deployments
FUJI_RPC_URL=           # Optional: custom Fuji RPC
SNOWTRACE_API_KEY=      # Optional: contract verification
PROTOCOL_TREASURY=      # Optional: defaults to the deployer
```

**`packages/site/.env`**:

```
VITE_WC_PROJECT_ID=          # WalletConnect project id
VITE_INDEXER_URL_LOCAL=      # e.g. http://localhost:42069
VITE_INDEXER_URL_AVALANCHE=  # Mainnet indexer (prod: https://indexer.exnihilo.markets)
VITE_RPC_AVALANCHE=          # Optional: overrides the public Avalanche RPC
VITE_FORMO_WRITE_KEY=        # Formo analytics; unset disables it
```

A chain with no indexer URL is simply never queried — the UI shows an
"unavailable" state rather than failing requests.

`VITE_FORMO_WRITE_KEY` is client-side by design — it ships in the bundle, so it
is not a secret. But Formo **origin-locks** it: a key issued for one domain is
rejected on another, and the failure is silent because every call site uses
`analytics?.track(...)`. If events stop arriving after a domain move, check this
first. Leave it unset locally so development traffic is not recorded.

**`packages/indexer/.env.local`** — see [Indexer](./indexer).

## After changing contracts

Nothing is upgradeable, so a contract change means a redeploy, and a redeploy
means new addresses. Update all of these or the app will silently read an
abandoned deployment:

1. `packages/site/src/contracts/addresses.ts`
2. `packages/indexer/src/chain.ts` — addresses **and** `START_BLOCK`
3. `packages/abis/*.ts` if any ABI changed
4. [Contract Addresses](/protocol/addresses)
