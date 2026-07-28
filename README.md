# EXNIHILO

**Permissionless "buy now pay later" trading on Avalanche.** Create a market for any token, go long or short and receive a tradable NFT position. No liquidations. 

---

## Overview

EXNIHILO is a Web3 app that lets anyone spin up a two-sided market for any ERC-20 token. Each market is an isolated pool with:

- **Swaps** — constant-product AMM between the token and a synthetic USDC
- **Long positions** — leveraged exposure to token price appreciation
- **Short positions** — leveraged exposure to token price decline
- **LP** — provide liquidity and earn 3% of all position fees

Positions are represented as ERC-721 NFTs (transferable) and settled against the pool's reserves.

## Monorepo Structure

```
packages/
├── blockchain/   Solidity contracts + Hardhat tests + deploy scripts
├── site/         React 19 frontend (Wagmi, Viem, React Router)
└── abis/         Shared ABI exports consumed by the frontend
```

## Contracts

| Contract | Description |
|---|---|
| `EXNIHILOPool` | Core AMM — swaps, long/short open/close/realize/liquidate |
| `EXNIHILOFactory` | Deploys pools, routes protocol fees to treasury |
| `PositionNFT` | ERC-721 representing open long/short positions |
| `LpNFT` | ERC-721 representing an LP's ownership of a pool |
| `AirToken` | ERC-20 used for synthetic tokens and synthetic USD |

**Target network:** Avalanche (mainnet chainId 43114 / Fuji testnet chainId 43113)

## Prerequisites

- Node.js 18+
- npm 10+ (workspaces)

## Installation

```bash
npm install
```

## Blockchain Package

### Setup

```bash
cp packages/blockchain/.env.example packages/blockchain/.env
```

Fill in `.env`:

```env
ACCOUNT_PRIVATE_KEY=   # deployer wallet private key (no 0x prefix)
SNOWTRACE_API_KEY=     # from https://snowtrace.io/myapikey
PROTOCOL_TREASURY=     # address that receives the 2% protocol fee
DEFAULT_SWAP_FEE_BPS=100  # swap fee in bps (100 = 1%)

# Optional RPC overrides
# AVALANCHE_RPC_URL=https://api.avax.network/ext/bc/C/rpc
# FUJI_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc
```

### Testing

```bash
cd packages/blockchain

npx hardhat test                    # all tests (~150 tests)
REPORT_GAS=true npx hardhat test   # with gas usage report
npx hardhat coverage               # full coverage report
```

### Local Development

Start a local Hardhat node and deploy all contracts with seed data:

```bash
# Terminal 1
npx hardhat node

# Terminal 2
npx hardhat run scripts/deployLocal.ts --network localhost
```

The deploy script prints all contract addresses. Copy them into `packages/site/src/contracts/addresses.ts`.

Local addresses after `deployLocal.ts`:

| Contract | Address |
|---|---|
| MockUSDC | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| EXNIHILOFactory | `0x95bD8D42f30351685e96C62EDdc0d0613bf9a87A` |
| PositionNFT | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |
| LpNFT | `0xef11D1c2aA48826D4c41e54ab82D1Ff5Ad8A64Ca` |

Deployer `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` (Hardhat signer[0]) receives 1,000,000 MockUSDC.

### Avalanche Mainnet Deployment

Live at factory `0xBe6Fb0e7b7d8EFD491FEbC436F737cE8B244F85a` (block 91,382,693).
Full address list: [docs/protocol/addresses](packages/docs/protocol/addresses.md).

```bash
cd packages/blockchain
# Rehearse against a mainnet fork first — nothing is spent:
FORK_AVALANCHE=1 DRY_RUN=1 MAINNET_PROTOCOL_TREASURY=0x... \
  npx hardhat run scripts/deployMainnet.ts

MAINNET_PROTOCOL_TREASURY=0x... \
  npx hardhat run scripts/deployMainnet.ts --network avalanche
```

Deploys the protocol only — PositionNFT, PoolDeployer, LpNFT, EXNIHILOFactory
and EXNIHILORouter against Circle's native USDC. No mocks, no faucet and **no
markets**: market creation is permissionless, so pools are created by users.

The factory's `usdc`, `protocolTreasury` and `defaultSwapFeeBps` are constructor
immutables and can never be changed, so the script refuses to guess them.

### Fuji Testnet Deployment

```bash
cd packages/blockchain
npx hardhat run scripts/deployFuji.ts --network avalancheFujiTestnet
```

Deploys MockUSDC, PositionNFT, LpNFT, EXNIHILOFactory, and five test token markets (ARENA, NOCHILL, RGOGLZ, BANDS, WAVAX). Writes deployed addresses to `packages/site/src/contracts/fujiAddresses.json` and prints Snowtrace verify commands.

## Site Package

### Setup

```bash
cp packages/site/.env.example packages/site/.env
```

Fill in `.env`:

```env
VITE_WC_PROJECT_ID=   # WalletConnect project ID (https://cloud.walletconnect.com)
```

### Development

```bash
npm run dev -w packages/site
```

App runs at `http://localhost:5173`. Supports MetaMask, WalletConnect, and any EIP-6963 injected wallet.

Configured chain: **Avalanche C-Chain mainnet** (chainId 43114) — the only network the app shows. Connect MetaMask to it; the app shows a chain switch prompt otherwise. To bring back Fuji or a local node, add an entry to `packages/site/src/lib/chains.ts` (that list drives the router, the wagmi config and the chain guard).

### Production Build

```bash
npm run build -w packages/site
```

### Pages

| Route | Description |
|---|---|
| `/` | Feed — swipe-style pool discovery |
| `/markets` | All pools with live price and TVL |
| `/markets/:poolAddr` | Trade page — swap, long/short, LP tabs |
| `/portfolio` | Open positions for connected wallet |
| `/create` | Create a new market |

## AMM Math

Three swap modes depending on position type:

| Mode | Reserves | Used for |
|---|---|---|
| SWAP-1 | `backedAirToken × backedAirUsd` | Regular swaps |
| SWAP-2 | `backedAirToken × airUsd.totalSupply()` | Open long |
| SWAP-3 | `airToken.totalSupply() × backedAirUsd` | Open short |

Spot price: `backedAirUsd / backedAirToken` (USDC per whole token).

## Fee Structure

| Fee | Amount | Destination |
|---|---|---|
| Open fee (base) | 5% of notional (min $0.05) | 3% LP claimable + 2% protocol treasury |
| Open fee (impact) | Dynamic: `1500 × N × (2×OI+N) / (2 × pool × 10000)` | LP claimable |
| Close fee | 1% of profit surplus | Protocol treasury |
| Swap fee | 100 bps = 1% (immutable per pool) | LP reserves |

## Tech Stack

| Layer | Technology |
|---|---|
| Contracts | Solidity 0.8.24, OpenZeppelin 5.4, Hardhat 2.22 |
| Testing | Chai, Hardhat Network Helpers, TypeChain |
| Frontend | React 19, TypeScript, Vite |
| Web3 | Wagmi 2, Viem 2 |
| Styling | Tailwind CSS 3.4 |
| Routing | React Router 6 |
| State | TanStack React Query 5 |
