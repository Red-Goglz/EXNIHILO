---
description: "Create a permissionless market for any ERC-20 token. What you need to seed the pool, what the factory deploys, how deep to seed, and which token transfer restrictions a market can and cannot live with."
---

# Creating a Market

Anyone can create a market for any ERC-20 token — no approvals, no governance vote.

## What you need

- **A token** that meets the [compatibility rules](#token-compatibility) below.
- **Token and USDC liquidity.** The ratio you seed sets the opening price:
  `spotPrice = usdcAmount / tokenAmount`.

Nothing else. Position caps and funding are automatic and identical on every market.

## What happens

`createMarket(tokenAddress, usdcAmount, tokenAmount)` on `EXNIHILOFactory`, in one transaction:

1. Reads the token's decimals (18 if unavailable), rejects anything outside 6–18 with
   `UnsupportedDecimals`, and deploys an `EXNIHILOPool`
2. Mints the LP NFT to you
3. Seeds your liquidity into the pool
4. Emits `MarketCreated`

You are then the pool's sole LP — see [Running a Pool](/lp/ownership).

## Seed deep enough to trade

The [position cap](/lp/position-caps) is a share of your USDC seed — 1% at creation, 20% after 24
hours:

| USDC seed | Max position, day one | After 24h |
|---|---|---|
| $1,000 | $10 | $200 |
| $10,000 | $100 | $2,000 |
| $50,000 | $500 | $10,000 |

The cap cannot be raised, so **seeding deeper is the only way to allow larger trades**. A new
market is also expensive to hold positions on, by design — see
[Funding](/positions/funding#the-rate).

## Token compatibility

Nothing vets your token beyond its decimals and rejecting fee-on-transfer at the moment it is
pulled. Everything below that those two checks do not catch is on you: if the token does not work,
the failure is not a rejected transaction — it is liquidity that cannot move.

### Hard requirements

- **Standard ERC-20** `transfer`, `transferFrom` and `approve`.
- **No fee-on-transfer.** The factory and pool compare balances around every pull and revert
  `FeeOnTransferNotSupported` if less arrived than was sent.
- **A correct `decimals()`, between 6 and 18.** It is fixed into the pool at creation; a wrong
  value makes a permanently mispriced market, and anything outside that range is rejected with
  `UnsupportedDecimals`. Below 6, one unit of collateral is valuable enough that the sub-unit
  residue funding leaves behind is worth trading against.
- **A fixed balance.** A holder's balance must change only when that holder sends or receives.
  Rebasing, elastic-supply and seizable tokens are **not supported** — see below.

### Rebasing and elastic supply

The fee-on-transfer check is a check **per transfer**, not a property of the token. It compares
balances around each pull and rejects a token that credits less than it was told to. It cannot
see what the token does afterwards.

A token whose balances move on their own breaks the pool's central invariant — that its real
balance covers its backed reserves, locked collateral, unclaimed fees and credited payouts:

- **A balance that falls** (negative rebase, slashing, seizure, burn-from) puts the pool below
  what it owes. Every reserve-touching call then reverts: swaps, opens, closes, sweeps, adding
  and removing liquidity. The pool holds no admin key and has no recovery function, so that state
  is **permanent** — holders cannot exit their positions and the LP cannot withdraw. `closePool`
  still runs but achieves nothing, because the wind-down needs accruals that can no longer happen.
- **A balance that rises** (positive rebase, reflection, or a plain donation to the pool address)
  is never counted. `removeLiquidity` pays out the nominal backed reserves only, so the excess
  stays in the contract and nothing can retrieve it.

Neither case is detectable at creation, so nothing rejects such a market — it simply does not
work. Do not seed one.

### Transfer restrictions

Whitelists, blacklists, anti-whale caps, `maxTxAmount` and pause switches can all work — but they
must be configured **before** you seed, because seeding is irreversible.

**Exempt the factory:**

| Network | EXNIHILOFactory |
|---|---|
| Avalanche C-Chain | `0xBe6Fb0e7b7d8EFD491FEbC436F737cE8B244F85a` |

Your token seed moves in two hops inside one transaction — `transferFrom(seeder → factory)`, then
`transferFrom(factory → pool)` — so one exemption on the factory clears both under the usual
`if (!exempt[from] && !exempt[to])` pattern.

::: warning The pool cannot be allowlisted in advance
The pool is deployed in the same transaction with plain `CREATE`, and its address depends on a
nonce that moves whenever anyone creates a market. Two token designs therefore cannot work at all:
**default-deny allowlists**, and **exemptions keyed only on `from`**. Do not seed a market with
either.
:::

For the life of the market, never blacklist the pool or the factory and never pause transfers —
every open, close and swap moves tokens.

| Token behaviour | Outcome |
|---|---|
| Plain ERC-20 | Works |
| Blacklist, default-allow | Works — never blacklist the factory or the pool |
| `maxTxAmount` / anti-whale with either-party exemption | Works — exempt the factory |
| Pausable | Works while unpaused |
| Fee-on-transfer / reflection | Rejected at creation |
| Fewer than 6 or more than 18 decimals | Rejected at creation |
| Rebasing / elastic supply / seizable balances | Cannot work — a fall freezes the pool permanently |
| Default-deny allowlist, or `from`-only exemption | Cannot work |

### Pre-market launches

A [pre-market](/developers/sdk#launchpad-integration) buyout sends its reserves through the same
factory on the same two hops, so the same exemption covers it. But a pre-market has **no refund
path**: if the token blocks the handoff, the buyout reverts for everyone, permanently, stranding
both reserves. Test the token against the factory address before seeding.
