---
description: "What can go wrong: smart contract risk, the absence of a human audit, LP counterparty exposure, expiry loss and thin liquidity. Read before trading."
---

# Risk Disclosure

::: danger
EXNIHILO is experimental software. Use at your own risk. Only trade with funds you can afford to lose.
:::

## Smart contract risk

**The protocol has not been audited by a human security firm.** Four automated audit
rounds have been performed by AI models (most recently Claude Opus 5, 2026-07-27), each
across 11 independent analysis passes, with all findings and remediations published in
[`.audit/`](https://github.com/Red-Goglz/EXNIHILO/tree/main/.audit). Each round
independently surfaced findings its predecessors missed — which is itself evidence that
no round should be treated as exhaustive.

The codebase follows security best practices (ReentrancyGuard, CEI, SafeERC20, reserve
invariants) and has 414 tests. Undiscovered vulnerabilities may exist. See
[Security](/protocol/security) for the full pass-by-pass record.

## Loss of funds

**As a trader**, your maximum loss on any position is the fees you paid — the premium.
This is a hard bound enforced by the contract, not a policy.

**As an LP, your risk is materially different and much larger.** You are the counterparty
to every position in your pool. Trader profits are paid out of your liquidity, and your
maximum loss is your full deposited liquidity. Position caps and the impact fee exist to
bound this, but do not eliminate it — see
[Fee Earnings](/lp/fees#you-are-the-counterparty).

Additionally:
- Positions can lose value rapidly if the price moves against you
- There are no stop-losses or automated risk management tools
- **A losing position cannot be closed at all.** There is no salvage value — unlike an
  option you could sell back for remaining time value, an underwater EXNIHILO position
  either recovers before its deadline or settles for nothing.

## Position expiry

Every position has a deadline. If the position is not renewed before the deadline, anyone can settle it:
- **Profitable positions**: settled like a normal close — the profit minus 1% fee (and a 0.05 USDC keeper bounty) is credited to the holder's claimable balance
- **Underwater positions**: collateral returns to LP reserves, no payout to the holder

Renew before the deadline, or opt into **auto-renewal** — a keeper then renews the position at expiry, paying the fee from the position's own profit. Be aware of what that means: each auto-renewal raises your break-even (the fee is written against your position's equity), and a position that cannot cover the fee settles anyway. Auto-renewal keeps winners alive; it never spends your wallet and never props up losers.

## Price divergence

EXNIHILO pool prices are derived from the AMM's own reserves, not external oracles. Pool prices can diverge significantly from external market prices, especially in low-liquidity pools.

## Liquidity risk

- Small pools have high slippage on large trades
- If backed reserves approach zero, positions may settle unfavorably

## No upgradeability

The protocol is fully immutable. If a bug is discovered, contracts cannot be patched. New deployments would be required.

## Regulatory risk

DeFi protocols may be subject to evolving regulations in your jurisdiction. Users are responsible for understanding and complying with applicable laws.

## No guarantees

The protocol provides no guarantees of profit, liquidity, or availability. All interactions are at the user's sole risk.
