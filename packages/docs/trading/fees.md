# Fees

EXNIHILO has three fee types plus a dynamic impact fee. All fees are deterministic and enforced on-chain.

## Position Open Fee — 5% base + impact fee

Applied to the USDC notional when opening a long or short:

| Recipient | Share | Description |
|---|---|---|
| LP | 3% + impact fee | Base 3% accumulated in `lpFeesAccumulated`, claimable via `claimFees()`. Impact fee also goes entirely to LP. |
| Protocol Treasury | 2% | Transferred immediately on open |

A minimum floor of **0.05 USDC** applies — if 5% of notional is less than this, the floor is used instead (split 3/5 LP, 2/5 protocol).

### Impact Fee (LP drain protection)

On top of the 5% base fee, a dynamic **impact fee** protects LPs from price-distortion attacks. The fee scales quadratically with position size and with cumulative open interest:

```
impactFee = 1500 × N × (2 × OI + N) / (2 × backedAirUsd × 10000)
```

Where:
- **N** = position notional in USDC
- **OI** = same-side open interest before this position (longOpenInterest or shortOpenInterest)
- **backedAirUsd** = pool's USDC reserves

**Key properties:**
- Small positions in deep pools pay near-zero impact fee (e.g. $100 in a $10K pool adds ~$0.08)
- Large positions relative to pool size pay significantly more
- **Split-proof:** the total fee is identical whether you open one $1,000 position or ten $100 positions, because the formula integrates over cumulative OI
- All impact fee revenue goes to the LP

## Swap Fee — Configurable (default 1%)

Applied to all three AMM curves (SWAP-1, SWAP-2, SWAP-3). The fee is computed on the spot value of the input and stays in the pool as passive LP yield.

The swap fee is set at pool creation and is immutable.

## Position Close Fee — 1% of profit

When closing a profitable position, 1% of the surplus is sent to the protocol treasury. If the position is at a loss, it can't be closed.

## Fee summary

| Action | Fee | Goes to |
|---|---|---|
| Open long/short | 5% base + impact fee | 3% + impact → LP, 2% → protocol |
| Swap | 1% (configurable) | Pool (LP yield) |
| Close (profit only) | 1% of profit | Protocol |
| Add/withdraw liquidity | 0% | — |
