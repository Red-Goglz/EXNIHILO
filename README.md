# EXNIHILO

**Permissionless "buy no pay later" trading on Avalanche.** Create a market for any token, go long or short with tradable NFT positions. No liquidation. 

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

### Fuji Testnet Deployment

```bash
cd packages/blockchain
npx hardhat run scripts/deployFuji.ts --network avalancheFujiTestnet
```

Deploys MockUSDC, PositionNFT, LpNFT, EXNIHILOFactory, and five test meme token markets (ARENA, NOCHILL, RGOGLZ, BANDS, WAVAX). Writes deployed addresses to `packages/site/src/contracts/fujiAddresses.json` and prints Snowtrace verify commands.

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

Configured chains: **Hardhat localhost** (chainId 31337) and **Avalanche Fuji** (chainId 43113). Connect MetaMask to one of these; the app shows a chain switch prompt otherwise.

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
| SWAP-1 | `backedAirMeme × backedAirUsd` | Regular swaps |
| SWAP-2 | `backedAirMeme × airUsd.totalSupply()` | Open long |
| SWAP-3 | `airMeme.totalSupply() × backedAirUsd` | Open short |

Spot price: `backedAirUsd / backedAirMeme` (USDC per whole meme token).

## Fee Structure

| Fee | Amount | Destination                            |
|---|---|----------------------------------------|
| Open fee | 5% of notional (min $0.05) | 3% LP claimable + 2% protocol treasury |
| Close fee | 1% of profit surplus | prtocol treasury                       |
| Swap fee | 100 bps = 1% (immutable per pool) | LP reserves                            |

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
