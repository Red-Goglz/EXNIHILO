# Reserve Accounting

Understanding the relationship between backed reserves and total supply is key to understanding EXNIHILO.

## Two types of tokens

Each pool has two AirTokens: **airToken** and **airUsd**. Each AirToken has:

- **Backed supply** — tokens minted 1:1 against real deposited collateral
- **Synthetic supply** — tokens minted without collateral (from position opens)
- **Total supply** = backed + synthetic

## State variables

```solidity
uint256 public backedAirToken;  // real token collateral
uint256 public backedAirUsd;   // real USDC collateral
```

These are the pool's core accounting variables. They increase on LP deposits and swaps-in, and decrease on withdrawals and swaps-out.

## The invariant

After every operation:

```
backedAirToken ≤ airToken.totalSupply()
backedAirUsd  ≤ airUsd.totalSupply()
```

This invariant is enforced by the contract. It guarantees that the pool never claims more collateral than actually exists.

## How reserves change

| Operation | backedAirToken | backedAirUsd | airToken supply | airUsd supply |
|---|---|---|---|---|
| Add liquidity | ↑ | ↑ | ↑ | ↑ |
| Withdraw liquidity | ↓ | ↓ | ↓ | ↓ |
| Swap token → USDC | ↑ | ↓ | ↑ | ↓ |
| Swap USDC → token | ↓ | ↑ | ↓ | ↑ |
| Open long | — | ↑ | — | ↑↑ (synthetic) |
| Open short | ↑ | — | ↑↑ (synthetic) | — |
| Close long | — | ↓ | — | ↓↓ (burn synthetic) |
| Close short | ↓ | — | ↓↓ (burn synthetic) | — |

Note: "↑↑" means totalSupply increases more than backed (the extra is synthetic).

## Open interest tracking

The pool tracks aggregate open interest:
- `longOpenInterest` — incremented on open, decremented on close/realize
- `shortOpenInterest` — same for shorts

These provide a quick view of total leveraged exposure without iterating positions.
