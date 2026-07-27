# Risk Disclosure

::: danger
EXNIHILO is experimental software. Use at your own risk. Only trade with funds you can afford to lose.
:::

## Smart contract risk

The protocol has not undergone a formal security audit. While the codebase follows security best practices (ReentrancyGuard, CEI, SafeERC20, reserve invariants) and has ~400 tests, undiscovered vulnerabilities may exist.

## Loss of funds

- Your maximum loss on any position is 100% of the USDC fees or the full liquidity if you are LP provider
- Positions can lose value rapidly if the price moves against you
- There are no stop-losses or automated risk management tools

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
