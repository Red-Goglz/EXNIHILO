---
description: "EXNIHILO's four fee types plus the dynamic impact fee — and why a 5% open fee is an option premium rather than a taker fee, since it replaces collateral."
---

# Fees

EXNIHILO has four fee types plus a dynamic impact fee. All fees are deterministic and enforced on-chain.

::: tip Compare it to a premium, not to a taker fee
5% looks enormous next to a perp's 0.05% taker fee, but they are not the same kind of
charge. A perp taker fee sits *on top of* collateral you must also post and can lose
entirely. EXNIHILO's open fee **is** an option premium: it replaces collateral, and it
is the whole of your downside. The right comparison is to what an at-the-money option on
a volatile token costs — where 5% of notional for a 7-day term is cheap.
See [Positions Are Options](/introduction/positions-are-options).
:::

## Position Open Fee — 5% base + impact fee

Applied to the USDC notional when opening a long or short:

| Recipient | Share | Description |
|---|---|---|
| LP | 3% + impact fee | Base 3% accumulated in `lpFeesAccumulated`, claimable via `claimFees()`. Impact fee also goes entirely to LP. |
| Protocol Treasury | 2% | Accumulated in `protocolFeesAccumulated`, claimable via `claimProtocolFees()` (pull payment) |

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

## Renewal Fee — dynamic

Extending a position's deadline costs a fee **repriced at the position's
current state**: 5% of the mark value (original notional + current profit,
floored at the original notional) plus the position's slice of the impact fee
at current open interest and reserves. A fresh or flat position pays roughly
the old flat 5%; deep winners and positions renewing through crowded open
interest pay proportionally more. Quote it with `quoteRenewFee(nftId)`; the
full formula is in [Protocol Fees](/protocol/fees#position-renewal-fee-dynamic).

Renewals stack — each call adds one period. With
[auto-renewal](/positions/expiry#auto-renewal-opt-in) enabled, the fee (plus a
0.05 USDC keeper bounty) is paid from the position's own profit instead of
your wallet.

## Swap Fee — Configurable (default 1%)

Applied to all three AMM curves (SWAP-1, SWAP-2, SWAP-3). The fee is computed on the spot value of the input and stays in the pool as passive LP yield.

The swap fee is set at pool creation and is immutable.

## Position Close Fee — 1% of profit

When closing a profitable position, 1% of the surplus is sent to the protocol treasury. If the position is at a loss, it can't be closed.

## Fee summary

| Action | Fee | Goes to |
|---|---|---|
| Open long/short | 5% base + impact fee | 3% + impact → LP, 2% → protocol |
| Renew / extend | Dynamic: 5% of mark + OI slice | 3/5 of base → LP, 2/5 → protocol; slice → LP |
| Swap | 1% (configurable) | Pool (LP yield) |
| Close (profit only) | 1% of profit | Protocol |
| Expired-position settlement | 0.05 USDC flat bounty | Whoever calls `settleExpired` |
| Add/withdraw liquidity | 0% | — |
