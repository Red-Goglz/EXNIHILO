# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

EXNIHILO is an npm workspace monorepo for a Web3 dApp "Out of thin air" Trade Platform
It's a dapp where you can create permissionless pools, go long or short a token.
It has five packages:
- `packages/blockchain` — Solidity smart contracts with Hardhat
- `packages/site` — React 19 frontend with Wagmi/Viem for wallet integration
- `packages/indexer` — Ponder event indexer + Hono JSON API serving price history, pool/protocol metrics, and LP APR to the site
- `packages/abis` — shared contract ABIs (`@exnihilio/abis`), consumed by both the site and the indexer
- `packages/docs` — VitePress documentation site

## Commands

### Blockchain Package (`packages/blockchain`)

```bash
npx hardhat test                              # Run all smart contract tests
REPORT_GAS=true npx hardhat test             # Run tests with gas usage reporting
npx hardhat node                             # Start local Hardhat network
npx hardhat ignition deploy ./ignition/modules/Lock.ts  # Deploy contracts
```

### Site Package (`packages/site`)

```bash
npm run dev        # Start Vite dev server
npm run build      # TypeScript check + production build
npm run lint       # Run ESLint
npm run preview    # Preview production build
```

### Indexer Package (`packages/indexer`)

```bash
npm run dev:indexer     # Ponder dev server with hot reload (from repo root)
npm run start:indexer   # Production indexer + API
npm run codegen -w packages/indexer   # Regenerate ponder:schema / ponder:registry types
```

Serves on port 42069 by default. Requires `packages/indexer/.env.local` — copy
`packages/indexer/.env.example` and set `PONDER_RPC_URL_43114` (the suffix is the
indexed chain id, so it changes with `PONDER_CHAIN_ID`). `DATABASE_URL` is
optional locally (falls back to embedded PGlite) but required in production.

### Workspace-level

```bash
npm install                          # Install all workspace dependencies
npm run <script> -w packages/site    # Run script in a specific workspace
```

## Environment Setup

Copy `packages/blockchain/.env.example` to `packages/blockchain/.env` and populate:
- `ACCOUNT_PRIVATE_KEY` — for contract deployments
- `PROTOCOL_TREASURY` — fee recipient (testnet scripts fall back to the deployer;
  `deployMainnet.ts` requires `MAINNET_PROTOCOL_TREASURY` explicitly)
- `SNOWTRACE_API_KEY` — optional; **not** used for verification, see below

## Architecture

### Blockchain Package

Follows standard Hardhat layout:
- `contracts/` — Solidity contracts (currently `Lock.sol`)
- `ignition/modules/` — Hardhat Ignition deployment modules
- `test/` — Chai/Hardhat tests using `loadFixture` and `time` helpers
- `hardhat.config.ts` — Solidity 0.8.24 (evmVersion `cancun`, viaIR), networks
  `avalanche` (43114) and `avalancheFujiTestnet` (43113)

**Verification goes through Routescan, not Etherscan.** Snowtrace is operated by
Routescan, so `etherscan.apiKey` must stay an *object* (a plain string makes
hardhat-verify route to the Etherscan v2 endpoint and ignore `customChains`), and
the key is a placeholder — passing the real `rs_...` key makes Routescan answer
`result: null`, which surfaces as `Cannot read properties of null (reading 'startsWith')`.

Dry-run any mainnet script against a fork before spending:
`FORK_AVALANCHE=1 DRY_RUN=1 npx hardhat run scripts/deployMainnet.ts`

### Site Package

- **Entry**: `index.html` → `src/main.tsx` wraps `<App>` with `WagmiProvider` and `QueryClientProvider`
- **Web3 config**: `src/providers/client.ts` (Wagmi client) + `wagmi.config.ts`; chains come from `src/lib/chains.ts`
- **Styling**: Tailwind CSS + PostCSS
- **Build**: Vite with `tsc -b` type-checking before bundling

The only configured chain is **Avalanche C-Chain mainnet** (43114), declared in
`src/lib/chains.ts` — that list drives the router, the wagmi config, the nav and
the chain guard, so a chain left in it stays reachable by URL even if hidden.
Addresses live in `src/contracts/addresses.ts` and are wired in by hand after a
deploy (`deployMainnet.ts` writes `mainnetAddresses.json` as the source of truth).

### Indexer Package

- `ponder.config.ts` — contracts + networks. `EXNIHILOPool` is a `factory()` source derived
  from the factory's `MarketCreated` event, so new pools are picked up automatically.
  `chunkedHttp` splits `eth_getLogs` into 2000-block ranges for the public Avalanche RPC.
- `src/chain.ts` — **single source of truth** for the indexed chain id, contract addresses,
  and start block. Both `ponder.config.ts` and the API import from here; do not re-hardcode.
- `src/index.ts` — event handlers writing the tables in `ponder.schema.ts`.
- `src/api/index.ts` — Hono routes consumed by the site.

Fee splits are **never derived from bps constants** — the pool routes impact fees entirely
to LPs and takes a close fee on surplus, so the ratio is not fixed. Handlers read the pool's
`lpFeesAccumulated + lpFeesPaidTotal` / `protocolFeesAccumulated + protocolFeesPaidTotal`
and record the delta since the last event. See `syncFees` in `src/index.ts`.

The indexer follows **one chain per instance** (`INDEXED_CHAIN_ID`); requests carrying a
different `?chainId=` are rejected with 404. The site only calls chains whose registry entry
in `src/lib/chains.ts` has an `indexerUrl`.

## Agents & Skills

### Agent: `blockchain-developer`

Located at `.claude/agents/blockchain-developer.md`. Invoked automatically for smart contract, DeFi, and Web3 tasks. Covers Solidity patterns, security auditing, gas optimization, multi-chain deployment, oracle integration, and tokenomics.

### Skills

| Skill | Invoke | Purpose |
|---|---|---|
| `solidity-security` | `/solidity-security` | Vulnerability patterns (reentrancy, overflow, access control), CEI pattern, gas optimization, audit checklist |
| `defi-protocol-templates` | `/defi-protocol-templates` | Production templates: staking rewards, AMM, governance token, flash loans |
| `nft-standards` | `/nft-standards` | ERC-721/1155 implementations, on-chain metadata, royalties (EIP-2981), soulbound tokens |
| `web3-testing` | `/web3-testing` | Hardhat/Foundry test patterns, mainnet forking, fuzzing, coverage reporting |
| `frontend-design` | `/frontend-design` | Distinctive, production-grade UI — typography, motion, color systems, component design. Use when building or restyling React components, pages, or any web UI in `packages/site` |
| `web-artefacts-builder` | `/web-artefacts-builder` | Multi-component HTML artifacts using React, Tailwind CSS, and shadcn/ui. Use for complex self-contained artifacts requiring state management or routing |
