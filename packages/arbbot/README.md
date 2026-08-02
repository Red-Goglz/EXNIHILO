# `packages/arbbot` — EXNIHILO arbitrage scanner

Detects price dislocations between EXNIHILO pools and the wider Avalanche DEX
market, and prints them. **It never sends a transaction.** The process holds no
private key, imports no wallet client, and has no code path that builds a
transaction — executing the arb is a deliberate later step.

```bash
npm run arbbot:once        # one scan, then exit
npm run arbbot             # poll forever (POLL_INTERVAL_MS)
VERBOSE=true npm run arbbot:once   # also show why pools were skipped
```

Config is env-only — copy `.env.example` to `.env.local`. Defaults target the
Avalanche C-Chain mainnet factory and work with no setup at all.

---

## Why there is an arb at all

An EXNIHILO pool holds **real** reserves of a real ERC-20 against real USDC, and
prices `swap()` on a constant-product curve with **no oracle**. Nothing forces
that curve to agree with the rest of the market:

- the market creator picks the opening ratio out of thin air;
- after that, only trade flow moves it;
- every position open/close and LP action also perturbs the backed reserves.

So the pool price drifts from the global price, and closing that gap is the arb.
Both directions start and end in USDC, which makes profit a single unambiguous
number with no inventory risk:

| Direction | Leg 1 | Leg 2 |
|---|---|---|
| **POOL CHEAP** | USDC → token on EXNIHILO | token → USDC on the DEX |
| **POOL RICH** | USDC → token on the DEX | token → USDC on EXNIHILO |

Only `swap()` (SWAP-1) is used. The leverage machinery — `openLong`,
`openShort`, SWAP-2/SWAP-3 — runs against *synthetic* supply and is a different
game (see "Not covered" below).

---

## How pools are discovered

**The factory is the registry.** `EXNIHILOFactory` pushes every market it creates
into `allPools[]`, so the authoritative list is two calls deep — no indexer, no
subgraph, no event replay:

```
n = factory.allPoolsLength()
[factory.allPools(0) … factory.allPools(n-1)]     ← one multicall
```

Three alternatives were considered and rejected as the *source of truth*:

- **`MarketCreated` log replay** — same data, and it hands you the underlying
  token in the same pass. But it needs a `fromBlock`, chunked `eth_getLogs`
  against a rate-limited public RPC, and reorg handling. Worth it only to react
  to a new market within one block, which is what the optional
  `watchNewMarkets()` subscription in `pools.ts` is for. A freshly seeded pool is
  the single most likely place for a large gap to exist.
- **The Ponder indexer's `/metrics/pools`** — cheapest of all, but it adds a
  service dependency and lags the chain by its sync distance. A bot acting on
  stale reserves quotes a trade that no longer exists. The indexer is a fine
  accelerator and a poor source of truth. **This bot reads the chain.**
- **`token.balanceOf(pool)` for reserves** — wrong. The pool custodies collateral
  for open positions *on top of* its AMM reserves, so `balanceOf` overstates what
  swaps price against. The only correct inputs are the `backedAirToken` /
  `backedAirUsd` state variables.

Static per-pool data (`underlyingToken`, `tokenDecimals`, `swapFeeBps` — all
immutable) is cached for the process lifetime. Only reserves and the closing flag
are refetched, via `indexerState()`, which the pool bundles specifically so
off-chain consumers don't pay six `eth_call`s per pool per cycle. A steady-state
cycle is therefore **one multicall regardless of pool count**.

---

## How the external price is obtained

**Yes — a meta-DEX aggregator, and quoted for a concrete size, never a spot price.**

An EXNIHILO market can be created for *any* ERC-20, permissionlessly. The bot
cannot assume the underlying trades on Trader Joe, or on Pangolin, or in a WAVAX
pair, or that a direct USDC pair exists at all. Hard-coding a venue means
hard-coding which markets are arbable. An aggregator searches every Avalanche
venue plus multi-hop paths and returns the best executable output.

Three keyless providers, tried in order (`QUOTE_PROVIDERS`):

| Provider | Notes |
|---|---|
| **KyberSwap** | Primary. Best coverage, per-hop route breakdown, and its `routeSummary` is exactly what `/route/build` turns into calldata later. |
| **OpenOcean** | Fallback. Takes `amount` in *whole* units, which is lossy for high-decimal tokens — a reason to keep it second. |
| **LI.FI** | Fallback. Bridge aggregator pinned to same-chain. |

*(Odos was evaluated and dropped — its quote API returns `Service Ended`.)*

**Quote for size, not spot.** This is the central decision. A mid price — from
pair reserves, a subgraph, or a price API like CoinGecko — tells you a gap exists
but not whether it survives the price impact of capturing it. On a thin token the
impact *is* the entire trade. Quoting the real size folds routing, fees, and
slippage into one number, and the same call later returns the calldata to execute
with.

A **negative cache** (`NO_ROUTE_TTL_MIN`) remembers tokens with no external
market. This matters more than it looks: a permissionless protocol accumulates
pools over tokens that never trade anywhere else — test tokens, dead memecoins,
tokens whose only liquidity *is* the EXNIHILO pool. Without it, each burns three
aggregator round trips every cycle forever, starving the pools that matter.

---

## The math

`src/exnihilo.ts` is an **exact bigint mirror** of the pool's `_cpAmountOut`,
including integer truncation, so a simulated fill matches on-chain to the wei.
A single float would silently drift from the contract.

**The fee model is not Uniswap's.** UniswapV2 takes its fee off the *input*.
EXNIHILO computes the raw constant-product output first, then subtracts a fee
equal to `swapFeeBps` of the input's **spot value**:

```
rawOut = amountIn * Ro / (Ri + amountIn)
fee    = amountIn * Ro * swapFeeBps / (Ri * 10000)
netOut = rawOut - fee                      (0 if rawOut <= fee)
```

Because spot value always exceeds realised output on a concave curve, this fee is
**harsher** than a UniV2 fee of the same bps, and the gap widens with trade size.
Modelling it as a flat 1% haircut would overstate profit on exactly the large
trades an arb bot cares about. The input ceiling
`Ri * (10000 - fee) / fee`, past which `swap()` reverts, is enforced too.

### Three stages, cheapest first

Aggregator calls are the scarce resource, so a pool has to earn each one.

1. **Band (free).** The marginal execution prices are `mid/(1-f)` to buy out of
   the pool and `mid*(1-f)` to sell into it. Any external price strictly inside
   that band cannot be arbed at **any** size, because price impact only widens
   the spread. This makes the rejection *exact* for the EXNIHILO leg, not a
   heuristic. The band is asymmetric, so each edge is tested against its own
   bound; `MIN_EDGE_BPS` pads for the DEX's own fee and gas.
2. **Probe (1 call).** One small quote establishes the external price and the
   direction — and is reused as the direction-B DEX leg.
3. **Ladder (N calls).** Simulate the full round trip at each candidate size,
   then golden-section refine around the winner.

### Why size is the whole problem

Profit is concave in size: the edge per dollar shrinks as both legs move against
you, while gas is fixed. Too small and gas eats it; too large and price impact
does. The answer is neither pool depth nor a fixed notional — it is the maximum
of a curve that must be *sampled*, because one leg (the aggregator) is a black
box with no closed form.

The ladder blends absolute rungs (`SIZE_LADDER_USDC`) with fractions of the
pool's own depth. Absolute rungs are what matter on a deep pool, but pools on a
young protocol are often seeded with tens of dollars — far below the smallest
configured rung — and filtering by depth alone would silently skip every one of
them no matter how wide the gap. Refinement uses **golden-section** search, which
unlike ternary search reuses an interior point each iteration, costing one
aggregator call per step instead of two.

Gas is priced live from the current base fee plus a WAVAX→USDC quote, so it
tracks both gas spikes and the AVAX price instead of hard-coding a number that
rots. On Avalanche a full arb currently costs well under a cent.

---

## What this does *not* cover

- **Leverage-side dislocation.** `longPrice()` (`airUsdSupply / backedAirToken`)
  and `shortPrice()` (`backedAirUsd / airTokenSupply`) can diverge from spot
  within a single pool. That is a genuine intra-protocol opportunity, but it
  requires *holding a position* with duration, renewal fees, and settlement risk
  rather than an atomic round trip — a different bot.
- **Multi-pool routing.** Two EXNIHILO pools over the same token would arb
  against each other directly; currently each is only compared to the DEX.
- **MEV.** No private mempool, no bundle submission, no sandwich protection.

## Before this can execute

Detection and execution are not the same problem. Minimum bar:

1. **Simulate on-chain.** Aggregator quotes are advisory HTTP responses — stale,
   optimistic, or simply wrong. `eth_call` the whole two-leg path against the
   same block before signing.
2. **Make it atomic.** Two separate transactions lose the race. This needs a
   contract that does both legs in one call and reverts unless the final USDC
   balance increased — which also makes the trade self-protecting rather than
   reliant on the slippage haircut.
3. **Set real `minAmountOut` on the pool leg.** `swap()` takes one; the sim
   passes intent, not protection.
4. **Fund and approve** USDC + the underlying to the pool and the aggregator
   router.
5. **Expect competition.** A visible gap on a public mempool is a race.
