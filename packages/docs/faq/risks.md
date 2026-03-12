# Risk Disclosure

::: danger
EXNIHILO is experimental software. Use at your own risk. Only trade with funds you can afford to lose.
:::

## Smart contract risk

The protocol has not undergone a formal security audit. While the codebase follows security best practices (ReentrancyGuard, CEI, SafeERC20, reserve invariants) and has ~150 tests, undiscovered vulnerabilities may exist.

## Loss of funds

- Your maximum loss on any position is 100% of the USDC fees or the full liquidity if you are LP provider
- Positions can lose value rapidly if the price moves against you
- There are no stop-losses or automated risk management tools

## LP risk (force realize)

The LP NFT holder can force-realize underwater position at any time. When this happens:
- Locked tokens are sent to your address
- Your Position NFT is burned

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
