# Glossary

| Term | Definition |
|---|---|
| **AirToken** | ERC-20 wrapper token deployed per market. Two per pool: airToken (wraps the underlying token) and airUsd (wraps USDC). Only the pool can mint/burn. |
| **Backed reserves** | The portion of AirToken supply that has real underlying collateral. `backedAirToken` and `backedAirUsd` track these amounts. |
| **BNPL** | Buy Now, Pay Later — the trading model where you only pay the fee based on trading amount, with no additional collateral or margin. |
| **Constant-product** | AMM formula `x * y = k` used for all three swap curves. |
| **EXNIHILOFactory** | Permissionless, immutable factory contract that deploys new markets. |
| **EXNIHILOPool** | The core AMM + trading contract. One per market. Handles swaps, position opens/closes, and LP operations. |
| **Force realize** | LP authority to settle an underwater open position early, by paying the trading amount, burning the position NFT and release the tokens to the position owner. |
| **LP NFT** | ERC-721 token representing sole ownership of a pool's liquidity. One per pool, fully transferable. |
| **Position NFT** | ERC-721 token representing an open long or short position. Custodies locked wrapper tokens. |
| **Spot price** | Current price of the underlying token in USDC, derived from the pool's backed reserves ratio. |
| **SWAP-1 / SWAP-2 / SWAP-3** | The three AMM curves used for different operations. See [Key Concepts](./key-concepts). |
| **Synthetic mint** | Minting AirTokens without depositing real collateral. Used to create leveraged exposure when opening positions. |
| **totalSupply** | Full supply of an AirToken, including both backed and synthetic (unbacked) tokens. |
| **TVL** | Total Value Locked — the combined USDC value of real collateral in a pool. |
