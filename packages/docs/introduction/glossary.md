# Glossary

| Term                        | Definition                                                                                                                                          |
|-----------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| **airToken / airUsd**       | The pool's two internal supply counters — **not** deployed tokens. `airTokenSupply` tracks synthetic exposure to the underlying, `airUsdSupply` tracks synthetic USDC. Both are plain `uint256` values inside `EXNIHILOPool`; nothing is minted, transferable, or holdable. |
| **Backed reserves**         | The portion of each supply counter covered by real collateral the pool actually holds. `backedAirToken` and `backedAirUsd` track these. The gap between a supply counter and its backed reserve **is** the outstanding synthetic debt. |
| **BNPL**                    | Buy Now, Pay Later — the trading model where you only pay the fee based on trading amount, with no additional collateral or margin.                 |
| **Premium**                 | The open fee (5% of notional + impact fee, minimum 0.05 USDC), paid upfront and non-refundable. It is the maximum a trader can lose on a position. See [Positions Are Options](./positions-are-options). |
| **Writer**                  | The pool's LP, in option terms. They are the counterparty to every position in their pool, collect the premium, and pay profitable settlements out of their liquidity. |
| **Expires worthless**       | An underwater position at its deadline: collateral returns to the LP, synthetic debt is cancelled, the holder receives nothing. The option analogue of expiry out-of-the-money. |
| **Roll**                    | Extending a position past its deadline via `renewPosition` or auto-renewal. Unlike an option premium paid once, EXNIHILO's premium recurs each period and is repriced on the position's current mark. |
| **Constant-product**        | AMM formula `x * y = k` used for all three swap curves.                                                                                             |
| **EXNIHILOFactory**         | Permissionless, immutable factory contract that deploys new markets.                                                                                |
| **EXNIHILOPool**            | The core AMM + trading contract. One per market. Handles swaps, position opens/closes, and LP operations.                                           |
| **LP NFT**                  | ERC-721 token representing sole ownership of a pool's liquidity. One per pool, fully transferable.                                                  |
| **Position NFT**            | ERC-721 token representing an open long or short position. Records the position's terms (`lockedAmount`, `airUsdMinted`, `airTokenMinted`, `feesPaid`, `deadline`); the pool holds the actual collateral. |
| **Spot price**              | Current price of the underlying token in USDC, derived from the pool's backed reserves ratio.                                                       |
| **SWAP-1 / SWAP-2 / SWAP-3** | The three AMM curves used for different operations. See [Key Concepts](./key-concepts).                                                             |
| **Synthetic mint**          | Increasing `airTokenSupply` or `airUsdSupply` without depositing matching collateral — how leveraged exposure is created at open. No ERC-20 is minted; only the counter moves. |
| **Supply counter**          | `airTokenSupply` / `airUsdSupply` — total synthetic exposure, backed plus unbacked. The pool asserts `backedAirToken <= airTokenSupply` and `backedAirUsd <= airUsdSupply` on every state change. |
| **Deadline**                | Timestamp after which a position can be closed by anyone. Set at open, extendable via `renewPosition`.                                              |
| **Position duration**       | Configurable per-pool time window (1 hour – 1 year, default 7 days) for each position period.                                                       |
| **renewPosition**           | Pay the dynamic renewal fee (repriced at current position value and open interest) to extend a position's deadline by one period. Holder only.      |
| **Auto-renewal**            | Opt-in (`PositionNFT.setAutoRenew`): at expiry, `settleExpired` renews the position from its own equity instead of closing it. Cleared on transfer. |
| **settleExpired**           | Settle an expired position — callable by anyone, pays the caller a flat 0.05 USDC keeper bounty. Tries auto-renewal first; otherwise closes. Profit is credited to the holder as a claimable balance; if underwater, collateral returns to the LP. |
| **closePositionAfterDeadline** | The bounty-free variant of `settleExpired`. Reverts with `AutoRenewActive` if the holder opted into auto-renewal, so it cannot be used to deny them a renewal. |
| **Keeper bounty**           | Flat 0.05 USDC paid to whoever calls `settleExpired`, carved from the settlement flow and clamped to what is actually available. Makes cleanup economically viable without ever overdrawing the position. |
| **Claimable balance**       | Pull payment. Third-party settlement credits `claimable[holder]` rather than pushing USDC, so a recipient that cannot receive tokens can never block cleanup. Withdraw with `claimPayout(to)`. |
| **TVL**                     | Total Value Locked — the combined USDC value of real collateral in a pool.                                                                          |
