# EXNIHILO

A DeFi protocol frontend built as a React/Vite monorepo.

## Project Structure

```
packages/
  abis/        - Smart contract ABIs (ERC20, factory, pool, NFT)
  blockchain/  - Hardhat smart contract development environment
  site/        - React/Vite frontend application
```

## Frontend (packages/site)

- **Framework**: React 19 + Vite 7
- **Styling**: Tailwind CSS
- **Web3**: wagmi v2, viem, WalletConnect
- **Routing**: React Router v6
- **State**: TanStack Query v5

## Development

```bash
npm install                              # Install all workspace deps
npm run dev --workspace=packages/site   # Start dev server on port 5000
```

## Configuration

- Vite dev server: `0.0.0.0:5000`, all hosts allowed (Replit proxy compatible)
- WalletConnect Project ID: set `VITE_WC_PROJECT_ID` env var (get one at https://cloud.walletconnect.com)

## Deployment

Configured as a static site deployment:
- Build: `npm run build --workspace=packages/site`
- Public dir: `packages/site/dist`
