---
description: "EXNIHILO's security model — reentrancy guards, exact reserve invariants, the close-price clamp and immutability with no privileged role — and the status of five AI audit rounds and a follow-up review."
---

# Security

## Protections in the code

### Reentrancy and ordering

Every pool and factory function that moves tokens is `nonReentrant`, and state is written before
any external call.

### Reserve invariant

After every operation that touches the reserves, the pool reverts unless:

```
backedAirToken ≤ airTokenSupply
backedAirUsd   ≤ airUsdSupply

token balance  ≥ backedAirToken + totalLongCollateral
USDC balance   ≥ backedAirUsd + totalShortCollateral
               + lpFeesAccumulated + protocolFeesAccumulated + totalClaimable
```

The balance checks count every obligation, so a leak of any of them reverts. There are no
`unchecked` blocks: an accounting desync that would drive a counter negative reverts rather than
wrapping, and the pool fails closed.

### Close-price clamp

A close is priced against the worst of the last 5 block opens wherever that is less favourable
than live. Pumping, closing and unwinding — in one transaction or across blocks — pays no more than
an honest close.

The cost is a delay: a move that stands at any of those block opens also refuses a close that is in
profit at the live price, until it ages out. Anyone can cause that by pushing the price at a block
boundary, every 5 blocks, holding a near-break-even close back while funding runs. Nothing is taken,
and each push has to survive a block boundary exposed to arbitrage. `quoteCloseUnclamped` tells a
held-back close from a losing one. See
[Closing Positions](/trading/closing-realizing#closing-right-after-a-price-move).

### Funding cannot be steered

No position is valued at accrual time, and accruing less often can only raise what a side is
charged, so nobody gains by keeping a pool quiet. The one third-party action, `sweepDust`, needs
decay only funding can cause. A caller can still move the price so a dust position prices
underwater and its holder gets nothing, but by then it holds 0.1% or less of its opening collateral.

### Tokens, outputs and slippage

- `SafeERC20` everywhere, and every inbound transfer reverts if less arrives than was sent. That is
  a check per transfer: a token that rebases or is seized *afterwards* passes it and then breaks the
  reserve invariant, so elastic-supply tokens are
  [unsupported](/markets/creating#rebasing-and-elastic-supply) rather than rejected.
- Token decimals must be 6–18; coarser units make funding's rounding residue worth trading against.
- Opens and swaps that would return nothing revert instead of keeping the input.
- Every swap, open and close takes a minimum output.
- The swap fee is 1% of the input's spot value, rounded up, so no swap is free and a price-moving
  trade pays on its full size.

## Immutability and privileged roles

No proxies, no `delegatecall`, no owner on the factory, and every pool parameter is a constant.
`PositionNFT` is bound to its factory once, and only the owning pool can release a position. A
defect in a deployed pool is permanent; the remedy is a new deployment.

There is no privileged role: only a pool's own LP can call `closePool()`. The contracts on mainnet
today predate this — see [Contract Addresses](/protocol/addresses).

## Audit status

::: warning
Every audit round has been performed by AI models, not a human security firm, and every round has
found things its predecessors missed. None of them replaces a professional audit.
:::

### Follow-up review — Opus 5 R3 (2026-09-15)

A single pass over the move from expiry to continuous funding, not a full round: **0 Critical,
1 High, 0 Medium, 4 Low, 3 Info**. The High — a rounding residue froze a side's funding clock, and the next opener was billed
for the frozen time — is fixed, and the four Lows are fixed or documented.
[Report →](https://github.com/Red-Goglz/EXNIHILO/tree/main/.audit/findings-opus5-r3)

::: danger Unaudited
The contract fixes of 2026-09-23 — funding-index rounding and resolution, the 6–18 decimals rule,
the exact short buyback, `sweepDustBatch` and the claim-path invariant checks — have not been
reviewed.
:::

### Round five — Opus 5 R2 (2026-08-20)

The first round that was not clean: **2 Critical, 4 High, 4 Medium, 15 Low, 18 Info, 1 Process**,
all in code written after round four. [Full report →](./audit-report)

| Finding | Status |
|---|---|
| **C-1, H-1, M-4** — the settlement guard | Removed with the guard: positions no longer expire, so no third party settles a position with value |
| **C-2** — pre-market reserve buyable for $1 | Fixed: the auction stops at 90% of its start price, and the buyout cost always rises with the reserve |
| **H-2** — holder sandwiches own close | Closed by the 5-block close-price clamp |
| **H-3** — renewal stacking freezes LP exit | Removed with renewals; LP exit is bounded by the wind-down |
| **H-4** — buyout depends on the token's `transferFrom` | Documented — exempt the factory ([token compatibility](/markets/creating#token-compatibility)) |
| **M-1** — USDC as the project token bricks a pre-market | Fixed: rejected at seed time |
| **M-3** — pre-markets have no refund path | By design; documented |
| Token-side reserve invariant too loose | Fixed: `totalLongCollateral` added |

### Earlier rounds

| Round | Date | Result | Notes |
|---|---|---|---|
| Claude Opus 5 | 2026-07-27 | 0 C / 0 H / 0 M / 6 L | Added short collateral to the invariant and the zero-output swap guard. Seven of its conclusions were corrected by round five |
| Claude Fable 5 | 2026-07-09 | 0 C / 0 H / 0 M / 4 L | Superseded: it wrongly assumed nothing value-moving had changed since the previous round |
| Claude Opus 4.7 | 2026-04-17 | 0 C / 0 H / 0 M / 4 L after fixes | Found a conditional High and four Mediums the first round missed; all fixed |
| Claude Opus 4.6 | 2026-04-04 | 0 C / 0 H / 1 M / 7 L | A blacklisted holder could block LP exit; fixed |

Per-pass reports for every round: [`.audit/`](https://github.com/Red-Goglz/EXNIHILO/tree/main/.audit).

## Tests

The contract suite has **673 tests**, including randomized interleavings that check the reserve
identities after every step, an attacker contract that sandwiches its own close, blacklisted-token
resilience, and funding charged under different accrual schedules.
