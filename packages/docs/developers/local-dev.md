# Local Development

## Prerequisites

- Node.js 18+
- npm 9+

## Setup

```bash
git clone https://github.com/exnihilo-finance/exnihilo.git
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

## Running the docs

```bash
npm run dev -w packages/docs
```

Opens at `http://localhost:5173`.

## Project structure

```
packages/
├── blockchain/         # Solidity contracts + Hardhat
│   ├── contracts/      # EXNIHILOPool, Factory, AirToken, NFTs
│   ├── test/           # ~150 tests
│   └── scripts/        # Deploy scripts (local, Fuji)
├── site/               # React 19 frontend
│   └── src/
│       ├── pages/      # Landing, Feed, Markets, Pool, Portfolio, Create
│       ├── components/ # Trade panels, wallet, shared
│       ├── lib/        # AMM math, formatters
│       └── contracts/  # Address config
├── abis/               # Typed ABI exports
└── docs/               # VitePress documentation (this site)
```

## Environment variables

Copy `packages/blockchain/.env.example` to `.env`:

```
ACCOUNT_PRIVATE_KEY=    # For testnet deployments
FUJI_RPC_URL=           # Optional: custom Fuji RPC
SNOWTRACE_API_KEY=      # Optional: contract verification
```
