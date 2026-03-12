# What is EXNIHILO

EXNIHILO ("Out of Thin Air") is a permissionless leveraged trading protocol. It lets you go long or short on any ERC-20 token using a Buy Now, Pay Later model — no collateral, and no liquidations.

## How it's different

| Traditional Perps | EXNIHILO |
|---|---|
| Requires collateral + margin | Only open position fee |
| Liquidation engine force-closes positions | No liquidations — ever |
| Oracle-dependent pricing | Price derived from AMM curves |
| Admin-controlled markets | Anyone can create a market |
| Positions are account-bound | Positions are transferable NFTs |

## How it works in 30 seconds

1. **Pick a token** — Browse existing markets or create one for any ERC-20.
2. **Go long or short** — Enter your USDC amount. The protocol mints synthetic tokens via its three-curve AMM to give you leveraged exposure.
3. **Close when ready** — No margin calls, no liquidation risk. Close your position at any time and receive your USDC profit or opt for the tokens.

Your position is represented as an NFT with fully on-chain SVG artwork showing live P&L — you can transfer or sell it at any time.

## Where does the leverage come from?

EXNIHILO uses a novel three-curve constant-product AMM. When you open a position, the protocol mints *synthetic* (unbacked) tokens that inflate the AMM's virtual supply. This shifts the price curve, creating leveraged exposure without borrowing, margin, or oracles.

See [Key Concepts](./key-concepts) for a deeper explanation.

## Chains

EXNIHILO is currently deployed on **Avalanche** (Fuji testnet). Mainnet deployment is upcoming.
