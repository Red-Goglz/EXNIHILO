---
description: "@exnihilio/sdk — a typed viem client for market discovery, quotes, trading, launchpad integration and integrator fee claims."
---

# SDK

`@exnihilio/sdk` is a TypeScript client over the protocol. It wraps the
contracts in typed functions, keeps every quote on-chain, and adds the
pre-flight checks that stop an integration failing in front of a user.

It is a thin layer on purpose. Fee maths, position caps and settlement pricing
all stay in the pool — the SDK never reimplements them, because the base fee has
a floor, the impact fee moves with open interest, and the renewal fee reprices
against a position's current mark. A client-side copy drifts the moment any of
those change.

## Install

```bash
npm install @exnihilio/sdk viem
```

`viem` is a peer dependency, so you control the version.

## Setup

```ts
import { createExnihilo } from "@exnihilio/sdk";
import { createPublicClient, createWalletClient, http, custom } from "viem";
import { avalanche } from "viem/chains";

const publicClient = createPublicClient({ chain: avalanche, transport: http() });
const walletClient = createWalletClient({ chain: avalanche, transport: custom(window.ethereum) });

const exnihilo = createExnihilo({
  publicClient,
  walletClient, // omit for a read-only client
  addresses: {
    factory:     "0x...",
    router:      "0x...",
    positionNFT: "0x...",
    lpNFT:       "0x...",
    usdc:        "0x...",
    preMarketFactory: "0x...", // optional; needed for launchpad flows
  },
});
```

Reads work without a `walletClient`. Anything that sends a transaction throws
`MissingWalletError` with the function name rather than failing deeper in.

Every method is also exported standalone, taking the context as a first
argument, if you would rather tree-shake or pass context explicitly.

## Markets

```ts
const pools = await exnihilo.listMarkets();
const market = await exnihilo.getMarket(pools[0]);
```

`getMarket` is one multicall returning the whole tradable state:

| Field | Meaning |
|---|---|
| `backedAirUsd` | USDC backing payouts. The side the position cap is a share of |
| `backedAirToken` | Underlying token backing the other side |
| `spotPrice` | USDC per whole token, 6 dec |
| `currentMaxPositionBps` | Position cap in bps — 100 at launch, 2000 after 24h |
| `effectiveLeverageCap` | That cap as a USDC notional. The largest position openable now |
| `createdAt` | Market creation time. Anchors the cap ramp |
| `currentPositionDuration` | Lifetime a position opened now would get — 1h → 8h → 24h → 7d → 30d by market age |
| `closeDate` | Non-zero once closure has begun; no new positions |

### Position caps

The cap is automatic — 1% of pool depth at creation, widening to 20% over 24
hours. See [Position Caps](/lp/position-caps).

```ts
const cap = await exnihilo.getPositionCap(pool, BigInt(Math.floor(Date.now() / 1000)));
// { bps, usdc, isRamping, rampEndsAt, secondsRemaining }
```

`nowSeconds` is a parameter rather than read from the host clock, so React
callers stay pure and server-side callers can pin it to a block timestamp.

To show a trader when a size becomes available, `projectPositionCapBps` computes
the ramp offline with no call:

```ts
const inSixHours = projectPositionCapBps(market.createdAt, now + 6n * 3600n);
```

### Position duration

Also automatic, and also a function of market age — 1 hour on a brand-new
market, stepping to 8 hours, 24 hours, 7 days, and 30 days once the market is a
week old. `getMarket` returns `currentPositionDuration`, and the same offline
projection is available:

```ts
const tomorrow = projectPositionDuration(market.createdAt, now + 86_400n);
```

A position keeps the lifetime it was opened under; the step never retroactively
extends anyone. A *renewal* uses the step current at renewal time, so an old
position on an aged market extends by 30 days rather than by its original
lifetime. See [Expiry & Renewal](/positions/expiry#position-duration).

## Quotes

All three proxy to the pool.

```ts
const fee   = await exnihilo.quoteOpenFee(pool, notional, true); // isLong
const renew = await exnihilo.quoteRenewFee(pool, tokenId);
const close = await exnihilo.quoteClose(pool, tokenId);          // { ready, pnl }
```

When `close.ready` is false the position cannot be settled at current reserves
and `pnl` is a display-only estimate of the shortfall.

## Trading

Opens route through the router, so a user approves USDC once rather than per
pool. Closes and renewals are holder-gated and go straight to the pool.

```ts
await exnihilo.openLong({ pool, notional: 100_000000n, minAmountOut });
await exnihilo.openShort({ pool, notional: 100_000000n, minAmountOut });
await exnihilo.closePosition(pool, tokenId, isLong, minUsdcOut);
await exnihilo.renewPosition(pool, tokenId, maxFee);
await exnihilo.swap(pool, amountIn, tokenToUsdc, minAmountOut);
await exnihilo.claimPayout(pool, to);
```

### Pre-flight

`preflightOpen` catches the failures that actually happen — over the cap, or
short on allowance or balance — with a message you can show verbatim:

```ts
const check = await exnihilo.preflightOpen(pool, notional, true, account, routerAddress);
if (!check.ok) return showError(check.reason);
// check.fee, check.totalRequired, check.cap
```

Note `totalRequired` is notional **plus** fee. That is what must be approved.

### Renewal fees move

The renewal fee is priced from live reserves, PnL and open interest, so it
genuinely changes between blocks. Quote it immediately before sending and pass
the result as `maxFee` — that argument exists to protect the holder from the
fee moving under them.

## Positions

```ts
const state = await exnihilo.getPositionState(tokenId, nowSeconds);
// position fields + owner, close: { ready, pnl }, isExpired, secondsToExpiry

const { enabled, maxFee } = await exnihilo.getAutoRenew(tokenId);
```

Auto-renew is funded from a position's own equity, so a profitable position can
roll without its holder sending USDC.

## Launchpad integration

For a bonding curve that quotes in something other than USDC. A `PreMarket`
opens as a plain token/quote AMM, runs a descending-price auction on the quote
reserve alongside it, and when someone buys that reserve out for USDC it creates
the real market at whatever ratio trading has arrived at. No oracle anywhere.

If your curve bonded in **USDC**, pass it as `quote` and skip the whole auction —
see [Already bonded in USDC](#already-bonded-in-usdc) below. See
[Creating a Market](/markets/creating) for seeding a market yourself instead.

### Plan first

```ts
const plan = exnihilo.planPreMarket({
  token, tokenAmount,
  quote, quoteAmount,
  quoteSpotPriceUsdc,      // honest spot price of one whole quote unit
  lpOwner,                 // claims the LP half of the fee stream
  integrator,              // claims the integrator half
});
// plan.startPrice, plan.secondsToBreakeven, ...
```

`planPreMarket` sends nothing. It validates the parameters, applies the +1%
markup and returns exactly what would be submitted.

::: warning Get the spot quote right
`quoteSpotPriceUsdc` is the one input that cannot be checked on-chain, and the
error is asymmetric. **Too high** only delays the fill — roughly 30 seconds per
1% at the default 2%/minute decay. **Too low** and the quote reserve is bought
out at your number almost immediately, with no band to absorb it.

Pass the honest spot price; the SDK adds the markup. Do not pre-mark it up.
:::

### Launch

```ts
await exnihilo.approvePreMarketSeed(token, tokenAmount, quote, quoteAmount);
const { hash, plan } = await exnihilo.createPreMarket({ /* same args */ });
```

`createPreMarket` simulates before sending, so a misconfiguration surfaces as a
decoded error rather than a failed transaction during a live bond.

::: danger Seeding is irreversible
There is no withdrawal, refund or expiry path. The only way the assets move
again is a buyout, which locks the LP NFT in a `LockedLpVault`. Verify the plan
before sending.
:::

::: warning Check the token's transfer policy first
The buyout hands the entire token reserve to `EXNIHILOFactory` and then into the
new pool, so a token with a whitelist, blacklist, `maxTxAmount` or pause switch
must exempt the factory address before you seed. If it blocks the handoff the
buyout reverts for everyone, permanently — and there is no refund path to fall
back on. Two token designs cannot be made to work at all.

See [Token compatibility](/markets/creating#token-compatibility) for the exact
transfers, the address to exempt, and the shapes to avoid.
:::

### Already bonded in USDC

The auction exists to answer one question: what is the bonded quote leg worth in
USDC? If you bonded in USDC you have already answered it, so there is nothing to
run. Pass USDC as `quote` and `createPreMarket` opens the real market in the same
transaction:

```ts
const plan = exnihilo.planPreMarket({
  token, tokenAmount,
  quote: usdcAddress,      // the chain's USDC
  quoteAmount,             // becomes the market's opening USDC leg, as seeded
  lpOwner,
  integrator,
});
plan.directLaunch; // true — no auction will run

await exnihilo.approvePreMarketSeed(token, tokenAmount, usdcAddress, quoteAmount);
const { hash } = await exnihilo.createPreMarket({ /* same args */ });
```

`quoteSpotPriceUsdc` is not required here, and `startPrice` / `decayBpsPerMinute`
are ignored if you pass them — a launchpad using one code path for every quote
asset does not have to special-case its own. Both are recorded on-chain as zero.

The premarket that comes back is already `launched`, with `launchedPool` and
`lpVault` set, and its `directLaunch()` is `true`. It never trades: `swap` and
`buyout` both revert. The market opens at exactly the ratio you seeded, with the
LP NFT locked in a `LockedLpVault` the same way a buyout would lock it. The $100
minimum on the seeded value still applies, measured directly in USDC.

::: tip Why not just run the auction anyway
It would sell USDC for USDC at a price that decays to 90% of par. A bidder who
waits five minutes takes a tenth of the reserve for nothing, and the market opens
that much thinner. Skipping it is not a convenience — it closes a giveaway.
:::

### While the auction runs

```ts
const pm = await exnihilo.getPreMarket(preMarketAddress);
// currentPrice, buyoutCostUsdc, buyoutQuoteOut, launched, launchedPool, lpVault

await exnihilo.swapPreMarket(preMarketAddress, amountIn, tokenToQuote, minOut);
await exnihilo.buyout(preMarketAddress, maxUsdc, minQuoteOut);
```

Trading the premarket AMM is what keeps its ratio honest while the auction
decays, so the real market opens at a current price rather than a stale one.

**Always set `maxUsdc` on a buyout.** The cost is
`max(currentPrice() × quoteReserve, $1)` — a product, and only the first term
falls. The reserve *grows* every time someone buys the token, since that is what
a quote-in swap does, and it is the main thing a premarket is there for.

So the figure you read from `buyoutCost()` can be higher by the time your
transaction lands. At the default 2%/minute decay the price drops about 0.067%
per block, so any quote-in swap larger than that fraction of the reserve pushes
the cost up over that interval. `maxUsdc` is what protects you between quote and
execution.

**The auction has a reserve price.** `currentPrice()` decays to **90% of
`startPrice`** and stops — five minutes at the default 2%/minute — so a premarket
nobody buys sits unfilled rather than continuing to discount. That bound is what
makes the buyout cost strictly increasing in `quoteReserve` at every point of the
decay.

It used to decay to 1 unit with only a flat $1 total as a backstop, which was
[C-2](/protocol/audit-report#the-two-critical-findings): because that total did
not depend on `quoteReserve`, a bidder could swap borrowed quote in, buy the
whole reserve back for $1 — their own deposit included — and keep the token
reserve. Fixed 2026-08-21.

There is no longer a flat minimum on the total. If the quote reserve is ever
drawn down far enough to price to nothing, `buyout` reverts `BuyoutNotPriceable`
rather than clamping up to a floor — the condition is temporary, and **any**
quote-in swap clears it. Clamping instead would have let that moment be locked in
as a permanent launch over a near-empty market, since `launched` is one-way.

`createPreMarket` requires the seeded quote reserve to be worth at least $100.

**The token cannot be USDC, and cannot be the quote asset.** Both are rejected at
seed time. `EXNIHILOFactory.createMarket` rejects them too, but only at buyout —
and by then the seed is in custody with no path that returns it, so seeding used
to succeed and then brick the buyout permanently. Fixed 2026-08-22.

**The quote asset must implement `decimals()`.** A quote whose `decimals()`
reverts is rejected with `QuoteDecimalsUnavailable` rather than assumed to be 18.
The value is not cosmetic here the way it is for the project token: it divides
every buyout price and the $100 seed check, so guessing 18 for a 6-decimal quote
misjudges the bonded reserve by a factor of 10^12. A quote token without the
optional metadata extension has to be wrapped before it can be bonded.

## Integrator fees

A launched market's LP NFT lives in a `LockedLpVault`. The vault has no code
path that withdraws liquidity, so holding the NFT there is economically
identical to burning it — but unlike a burn, the fee stream survives and is
split between the project and the launchpad.

The vault's only income is the pool's LP fee stream: **4% of notional** on every
open and renewal, plus the whole impact fee. Protocol fees go to the treasury
and are not part of this. Swap fees stay in the pool's reserves, so with a
locked LP they permanently deepen the market rather than becoming claimable.

```ts
const info = await exnihilo.getVault(vaultAddress);
// lp, integrator, integratorBps, lpAccrued, integratorAccrued, harvestedTotal, isFunded

const pending = await exnihilo.getPendingFees(vaultAddress);
await exnihilo.claimIntegratorFees(vaultAddress, to);
```

::: tip Show `pending`, not `integratorAccrued`
Fees only move into the vault when someone harvests, so `integratorAccrued`
understates what is owed. `getPendingFees` adds the share still sitting
unclaimed in the pool — that is the number to put in front of an integrator.
:::

Both claim functions harvest first, so one call collects everything. `harvest`
on its own is permissionless and rarely needed directly.

### Rotating addresses

```ts
await exnihilo.setIntegrator(vaultAddress, newAddress); // current integrator only
await exnihilo.setLp(vaultAddress, newAddress);         // current lp only
```

For key rotation or moving to a multisig. **Any balance already accrued goes
with the role** — claim first if that is not what you want. Neither role can
withdraw liquidity, change the split, or affect the other side; they gate a
claim destination and nothing else. `integratorBps` is immutable.

## Keeper operations

Not part of the partner surface, but shipped because someone has to run them.

```ts
if (await exnihilo.canSettleNow(pool)) {
  await exnihilo.settleExpired(pool, tokenId, minPayout);
}
```

`settleExpired` is permissionless and clears expired positions. This matters
more than it looks: open interest only decrements on settlement, and the impact
fee is priced off open interest — so **an unswept market becomes progressively
more expensive to trade**.

With the LP NFT locked in a vault, nobody has a natural incentive to do it. Fee
recipients are, if anything, mildly better off with inflated open interest, and
the cost lands on traders as slow decay. Whoever operates a market should run
this.

Poll `settlementGuardedUntilBlock` rather than discovering the window through a
revert: a swap moving ≥1% of pool depth arms a 5-block guard that blocks
third-party settlement, so nobody can settle a position at a price they just
moved. Position holders are never blocked, so this only affects keepers.

## Constants

`constants.ts` mirrors the contract's `constant` values — fee splits, cap ramp
bounds, guard parameters — for display and estimation.

```ts
import { LP_FEE_BPS, CAP_MAX_BPS, INTEGRATOR_SHARE_BPS } from "@exnihilio/sdk";
```

::: warning
These are duplicated, not read from chain, and can drift. Anything that decides
a transaction must quote the pool: `quoteOpenFee`, `quoteRenewFee`,
`effectiveLeverageCap`.
:::

## Errors

| Error | Cause |
|---|---|
| `MissingWalletError` | A write was called on a read-only client, or the wallet has no account |
| `MissingAddressError` | A launchpad function was called without `preMarketFactory` configured |
| `PreFlightError` | `planPreMarket` rejected the parameters before sending |

On-chain reverts surface as viem `ContractFunctionRevertedError` with the
decoded custom error — `LeverageCapExceeded`, `InsufficientOutput`,
`SettlementGuardActive` and so on. See [Contract Reference](/developers/reference).
