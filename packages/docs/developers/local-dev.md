---
description: "Clone, install and run EXNIHILO locally — contract tests, a local Hardhat node, the frontend, the indexer and the docs."
---

# Local Development

Requires Node.js 18+ and npm 9+.

```bash
git clone https://github.com/Red-Goglz/EXNIHILO.git
cd EXNIHILO
npm install
```

## Contracts

```bash
cd packages/blockchain
npx hardhat test                        # the full suite
npx hardhat test test/Funding.ts        # one file
REPORT_GAS=true npx hardhat test        # with gas reporting
npx hardhat coverage
```

For a local chain, run `npx hardhat node`, then in a second terminal
`npx hardhat run scripts/deployLocal.ts --network localhost`. It writes the addresses to
`packages/site/src/contracts/localAddresses.json` — see
[Contract Addresses](/protocol/addresses#local-hardhat-node-chain-id-31337).

`npx hardhat run scripts/fundingExamples.ts` prints measured funding tables against a throwaway
market. Dry-run any mainnet script against a fork before spending:
`FORK_AVALANCHE=1 DRY_RUN=1 npx hardhat run scripts/deployMainnet.ts`.

`packages/blockchain/.env` needs `ACCOUNT_PRIVATE_KEY` to deploy. The treasury comes from
`PROTOCOL_TREASURY` (testnet scripts fall back to the deployer), and `deployMainnet.ts` requires
`MAINNET_PROTOCOL_TREASURY` explicitly.

## Frontend

```bash
npm run dev          # from the repo root — http://localhost:5000
```

The app supports Avalanche mainnet only: `packages/site/src/lib/chains.ts` drives the router,
wallet config and chain guard. To point it at a local node, add a chain entry there and matching
addresses in `packages/site/src/contracts/addresses.ts`.

`packages/site/.env`:

```bash
VITE_WC_PROJECT_ID=          # WalletConnect project id; injected wallets work without it
VITE_INDEXER_URL_AVALANCHE=  # e.g. https://indexer.exnihilo.markets
VITE_RPC_AVALANCHE=          # optional; overrides the public RPC
VITE_FORMO_WRITE_KEY=        # optional analytics key — origin-locked; leave unset locally
```

## Indexer

Price charts, LP APR and analytics come from the indexer; trading works without it.

```bash
npm run dev:indexer  # from the repo root — http://localhost:42069
```

Configuration, including following a local node, is on [Indexer](./indexer).

## Docs

```bash
npm run dev -w packages/docs     # http://localhost:5173
```

## Repository layout

```
packages/
├── blockchain/   Solidity contracts, Hardhat tests and scripts
├── site/         React 19 app (wagmi / viem)
├── indexer/      Ponder indexer and Hono API
├── sdk/          @exnihilio/sdk — typed client
├── abis/         @exnihilio/abis — shared ABIs
├── arbbot/       Arbitrage bot between pools and other venues
└── docs/         This site
```

## After changing contracts

Nothing is upgradeable, so a contract change means a redeploy with new addresses. Follow
[After a redeploy](/protocol/addresses#after-a-redeploy), and regenerate `packages/abis` if an
interface changed — otherwise the app silently reads an abandoned deployment.
