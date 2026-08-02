---
description: "Backed versus synthetic supply, and how airToken and airUsd accounting keeps positions solvent. The key to understanding the rest of the protocol."
---

# Reserve Accounting

Understanding the relationship between backed reserves and total supply is key to understanding EXNIHILO.

## Two accounting units

Each pool tracks two internal accounting units: **airToken** and **airUsd**. They are not ERC-20 tokens — each is fully described by supply counters inside the pool:

- **Backed supply** — units created 1:1 against real deposited collateral
- **Synthetic supply** — units created without collateral (from position opens)
- **Total supply** = backed + synthetic

## State variables

```solidity
uint256 public airTokenSupply;  // total airToken units (backed + synthetic + locked)
uint256 public airUsdSupply;    // total airUsd units
uint256 public backedAirToken;  // real token collateral
uint256 public backedAirUsd;   // real USDC collateral
```

These are the pool's core accounting variables. The backed reserves increase on LP deposits and swaps-in, and decrease on withdrawals and swaps-out. The supply counters are the SWAP-2/SWAP-3 virtual reserves.

## The invariant

After every operation:

```
backedAirToken ≤ airTokenSupply
backedAirUsd  ≤ airUsdSupply
```

This invariant is enforced by the contract. It guarantees that the pool never claims more collateral than actually exists.

## How reserves change

| Operation | backedAirToken | backedAirUsd | airTokenSupply | airUsdSupply |
|---|---|---|---|---|
| Add liquidity | ↑ | ↑ | ↑ | ↑ |
| Withdraw liquidity | ↓ | ↓ | ↓ | ↓ |
| Swap token → USDC | ↑ | ↓ | ↑ | ↓ |
| Swap USDC → token | ↓ | ↑ | ↓ | ↑ |
| Open long | — | ↑ | — | ↑↑ (synthetic) |
| Open short | ↑ | — | ↑↑ (synthetic) | — |
| Close long | — | ↓ | — | ↓↓ (burn synthetic) |
| Close short | ↓ | — | ↓↓ (burn synthetic) | — |

Note: "↑↑" means the supply counter increases more than backed (the extra is synthetic).

## Open interest tracking

The pool tracks aggregate open interest:
- `longOpenInterest` — incremented on open, decremented on close/expiry
- `shortOpenInterest` — same for shorts

These provide a quick view of total leveraged exposure without iterating positions.
