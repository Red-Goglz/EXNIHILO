---
description: "EXNIHILO's security model — reentrancy guards, exact reserve invariants, the close-price clamp, immutability and its one privileged role — and the status of five AI audit rounds."
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

The balance checks count every obligation — LP reserves, collateral held for open positions,
unclaimed fees and credited payouts — so a leak of any of them reverts instead of passing unnoticed.
There are no `unchecked` blocks, so an accounting desync that would drive a counter negative reverts
rather than wrapping: the pool fails closed.

### Close-price clamp

A holder can move the price their own close settles against. So a close is priced against the worst
of the last 5 block opens wherever that is less favourable than live, with entries ageing out by
block. Pumping, closing and unwinding — in one transaction or across blocks — pays no more than an
honest close.

The cost is a delay. A price move that stands at any of those block opens also refuses a close
that is in profit at the live price, until it ages out. Anyone can cause that by pushing the price
at a block boundary and pulling it back, and can repeat it every 5 blocks: a holder close to
break-even can be kept from closing while funding runs. Nothing is taken, and the push has to
survive a block boundary exposed to arbitrage. `quoteCloseUnclamped` tells a held-back close from a
losing one. See [Closing Positions](/trading/closing-realizing#closing-right-after-a-price-move).

### Funding cannot be steered

No position is valued at accrual time, and accruing less often can only raise what a side is
charged, never lower it, so nobody gains by keeping a pool quiet. Only the holder can close a
position with value; the one third-party action, `sweepDust`, needs decay that only funding can
cause. A caller can still move the price so a dust position prices underwater and its holder
receives nothing, but by then it is worth at most its remaining collateral — 0.1% or less of what
it opened with.

### Tokens, outputs and slippage

- `SafeERC20` everywhere, and every inbound transfer checks the balance delta, rejecting
  fee-on-transfer and rebasing tokens.
- Opens and swaps that would return nothing revert instead of keeping the input.
- Every swap, open and close takes a minimum output.
- The swap fee is 1% of the input's spot value, rounded up, so no swap is free and a trade that
  moves the price pays on its full size rather than on its reduced output.

## Immutability and privileged roles

No proxies, no `delegatecall`, no owner on the factory, and every pool parameter is a constant.
`PositionNFT` is bound to its factory once, and only the owning pool can release a position. A
defect in a deployed pool is therefore permanent; the remedy is a new deployment.

There is no privileged role. Only a pool's own LP can call `closePool()`. Earlier versions let the
factory's `deployer` close any pool; that was removed, because a closure starts the wind-down —
after 7 days funding doubles daily and positions nobody closes decay away — and one key able to do
that to every market, launchpad markets included, was more than an emergency brake needs.

## Audit status

::: warning
Every audit round has been performed by AI models, not a human security firm, and every round has
found things its predecessors missed. None of them replaces a professional audit.
:::

### Round five — Claude Opus 5 R2 (2026-08-20)

The first round that was not clean: **2 Critical, 4 High, 4 Medium, 15 Low, 18 Info, 1 Process**,
all in code written after round four. [Full report →](./audit-report)

| Finding | Status |
|---|---|
| **C-1, H-1, M-4** — the settlement guard | Removed with the guard: positions no longer expire, so no third party settles a position with value |
| **C-2** — pre-market reserve buyable for $1 | Fixed 2026-08-21: the auction stops at 90% of its start price, and the buyout cost always rises with the reserve |
| **H-2** — holder sandwiches own close | Closed by the 5-block close-price clamp, in one transaction and across blocks |
| **H-3** — renewal stacking freezes LP exit | Removed with renewals; LP exit is bounded by the wind-down |
| **H-4** — buyout depends on the token's `transferFrom` | Documented — exempt the factory ([token compatibility](/markets/creating#token-compatibility)) |
| **M-1** — USDC as the project token bricks a pre-market | Fixed 2026-08-22: rejected at seed time |
| **M-3** — pre-markets have no refund path | By design; documented |
| Token-side reserve invariant too loose | Fixed: `totalLongCollateral` added |

::: danger Changes since round five are unaudited
The contracts these docs describe replaced expiry and renewals with continuous funding that shrinks
collateral and debt together. That redesign has not been through an audit round — nor has the fix,
on 2026-09-15, for a bug it introduced, where a profitable short closed inside the clamp window
could revert.
:::

### Earlier rounds

| Round | Date | Result | Notes |
|---|---|---|---|
| Claude Opus 5 | 2026-07-27 | 0 C / 0 H / 0 M / 6 L | Added short collateral to the invariant and the zero-output swap guard. Seven of its conclusions were corrected by round five |
| Claude Fable 5 | 2026-07-09 | 0 C / 0 H / 0 M / 4 L | Superseded: it wrongly assumed nothing value-moving had changed since the previous round |
| Claude Opus 4.7 | 2026-04-17 | 0 C / 0 H / 0 M / 4 L after fixes | Found a conditional High and four Mediums the first round missed; all fixed |
| Claude Opus 4.6 | 2026-04-04 | 0 C / 0 H / 1 M / 7 L | A blacklisted holder could block LP exit; fixed |

Per-pass reports for every round: [`.audit/`](https://github.com/Red-Goglz/EXNIHILO/tree/main/.audit).

## Tests

The contract suite has **630 tests**, including randomized interleavings that check the reserve
identities and aggregate bounds after every step, an attacker contract that sandwiches its own close
in one transaction, blacklisted-token resilience, and path-independence of funding accrual.
