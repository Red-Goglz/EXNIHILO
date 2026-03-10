# Fees

EXNIHILO has three fee types. All fees are deterministic and enforced on-chain.

## Position Open Fee — 5%

Applied to the USDC notional when opening a long or short:

| Recipient | Share | Description |
|---|---|---|
| LP | 3% | Accumulated in `lpFeesAccumulated`, claimable via `claimFees()` |
| Protocol Treasury | 2% | Transferred immediately on open |

A minimum floor of **0.05 USDC** applies — if 5% of notional is less than this, the floor is used instead (split 3/5 LP, 2/5 protocol).

## Swap Fee — Configurable (default 1%)

Applied to all three AMM curves (SWAP-1, SWAP-2, SWAP-3). The fee is computed on the spot value of the input and stays in the pool as passive LP yield.

The swap fee is set at pool creation and is immutable.

## Position Close Fee — 1% of profit

When closing a profitable position, 1% of the surplus is sent to the protocol treasury. If the position is at a loss, no close fee is charged.

## Fee summary

| Action | Fee | Goes to |
|---|---|---|
| Open long/short | 5% of notional | 3% LP + 2% protocol |
| Swap | 1% (configurable) | Pool (LP yield) |
| Close (profit only) | 1% of profit | Protocol |
| Close (at loss) | 0% | — |
| Add/withdraw liquidity | 0% | — |
