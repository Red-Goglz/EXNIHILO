# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

EXNIHILO is an npm workspace monorepo for a Web3 dApp "Out of thin air" Trade Platform
It's a dapp where you can create permissionless pools, go long or short a token.
It has two packages:
- `packages/blockchain` — Solidity smart contracts with Hardhat
- `packages/site` — React 19 frontend with Wagmi/Viem for wallet integration

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

### Workspace-level

```bash
npm install                          # Install all workspace dependencies
npm run <script> -w packages/site    # Run script in a specific workspace
```

## Environment Setup

Copy `packages/blockchain/.env.example` to `packages/blockchain/.env` and populate:
- `INFURA_API_KEY` — for Linea Sepolia RPC connection
- `ACCOUNT_PRIVATE_KEY` — for contract deployments

## Architecture

### Blockchain Package

Follows standard Hardhat layout:
- `contracts/` — Solidity contracts (currently `Lock.sol`)
- `ignition/modules/` — Hardhat Ignition deployment modules
- `test/` — Chai/Hardhat tests using `loadFixture` and `time` helpers
- `hardhat.config.ts` — configured for Solidity 0.8.24, Linea Sepolia via Infura

### Site Package

- **Entry**: `index.html` → `src/main.tsx` wraps `<App>` with `WagmiProvider` and `QueryClientProvider`
- **Web3 config**: `src/providers/client.ts` (Wagmi client) + `wagmi.config.ts` (chain: Linea testnet, connector: MetaMask)
- **Styling**: Tailwind CSS + PostCSS
- **Build**: Vite with `tsc -b` type-checking before bundling

The only configured chain is **Linea Sepolia testnet**. Contract ABIs/addresses from the blockchain package need to be manually wired into the site after deployment.

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
