/**
 * The opportunity scanner.
 *
 * ── What "arbitrage" means for an EXNIHILO pool ────────────────────────────
 * A pool holds real reserves of a real ERC-20 against real USDC and prices
 * `swap()` on a constant product curve with NO oracle. Nothing forces that
 * curve to agree with the rest of the market — the creator picks the opening
 * ratio, and after that only trade flow moves it. Every position open/close
 * and every LP action also perturbs the backed reserves. So the pool's price
 * drifts from the global price, and closing that gap is the arb.
 *
 * Both directions start and end in USDC, which makes profit unambiguous — one
 * number, in one unit, no inventory risk to reason about:
 *
 *   A. POOL CHEAP   USDC → token on EXNIHILO,  token → USDC on the DEX
 *   B. POOL RICH    USDC → token on the DEX,   token → USDC on EXNIHILO
 *
 * ── Three stages, cheapest first ───────────────────────────────────────────
 * Aggregator calls are the scarce resource, so a pool has to earn each one:
 *
 *   1. BAND (free)    Compare the pool mid against the no-arb band derived
 *                     from its own swap fee. Pure arithmetic on data we
 *                     already fetched.
 *   2. PROBE (1 call) One small quote establishes the external price and the
 *                     direction. Also reused as the direction-B DEX leg.
 *   3. LADDER (N)     Simulate the full round trip at each candidate size,
 *                     then golden-section refine around the winner.
 *
 * ── Why size is the whole problem ──────────────────────────────────────────
 * Profit is concave in trade size: the edge per dollar shrinks as both legs
 * move against you, while gas is fixed. Too small and gas eats it; too large
 * and price impact does. The answer is neither the pool's depth nor a fixed
 * notional — it is the maximum of a curve that has to be sampled, because one
 * leg (the aggregator) is a black box with no closed form.
 */

import type { Address } from "viem";
import { CONFIG, BPS_DENOM, USDC_DECIMALS } from "./config.ts";
import {
  buyTokenWithUsdc,
  sellTokenForUsdc,
  midFloat,
  noArbBand,
  maxAmountIn,
  depthCapUsdc,
} from "./exnihilo.ts";
import type { PoolSnapshot } from "./pools.ts";
import { client } from "./pools.ts";
import { getQuote, type Quote } from "./quotes/index.ts";

export type Direction = "POOL_CHEAP" | "POOL_RICH";

export interface Leg {
  venue: string;
  amountIn: bigint;
  amountOut: bigint;
}

export interface Opportunity {
  pool: PoolSnapshot;
  direction: Direction;
  /** Optimal USDC notional found, 6 decimals. */
  sizeUsdc: bigint;
  /** Net USDC profit after both legs, slippage haircut, and gas. */
  profitUsdc: bigint;
  /** Net profit as a fraction of size, in bps. */
  profitBps: number;
  /** Gross round-trip return before gas, in bps. */
  grossBps: number;
  gasUsdc: bigint;
  exnihiloLeg: Leg;
  dexLeg: Leg;
  dexRoute: string;
  dexProvider: string;
  /** Pool mid price, USDC per whole token (float — see midFloat). */
  poolMid: number;
  /** Implied external price at the probe size, same units. */
  dexMid: number;
  /** Signed mid-to-mid gap, in bps. */
  gapBps: number;
}

/** Why a pool produced no opportunity — surfaced in verbose mode. */
export interface Skip {
  pool: PoolSnapshot;
  reason: string;
  gapBps?: number;
  bestProfitUsdc?: bigint;
}

export type ScanResult = Opportunity | Skip;

export function isOpportunity(r: ScanResult): r is Opportunity {
  return (r as Opportunity).direction !== undefined;
}

const ONE_TOKEN = (decimals: number) => 10n ** BigInt(decimals);

/** Below a dollar there is no edge large enough to clear even cheap gas. */
const MIN_SIZE_USDC = 1_000_000n;

/**
 * Candidate trade sizes for a pool, blending two ladders.
 *
 * The absolute rungs from config are what matters on a deep pool. But a young
 * protocol's pools are often seeded with only tens of dollars — far below the
 * smallest configured rung — and filtering by depth alone would silently skip
 * every one of them no matter how wide the price gap. Mixing in fractions of
 * the pool's own depth keeps small pools scannable and costs nothing on large
 * ones, where the absolute rungs dominate anyway.
 */
function buildLadder(depthCap: bigint): bigint[] {
  const absolute = CONFIG.sizeLadderUsdc.map((s) => BigInt(Math.round(s * 1e6)));
  const fractional = [10n, 25n, 50n, 100n].map((pctOfCap) => (depthCap * pctOfCap) / 100n);

  return [...new Set([...absolute, ...fractional])]
    .filter((s) => s >= MIN_SIZE_USDC && s <= depthCap)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Apply the configured slippage haircut to an aggregator's optimistic output. */
function haircut(amount: bigint): bigint {
  return (amount * (BPS_DENOM - BigInt(CONFIG.slippageBps))) / BPS_DENOM;
}

/**
 * Cost of one full arb transaction, denominated in USDC.
 * Priced from the live base fee and a WAVAX→USDC quote so it tracks both gas
 * spikes and the AVAX price instead of hard-coding a number that rots.
 */
export async function estimateGasCostUsdc(): Promise<bigint> {
  const gasPrice = await client.getGasPrice().catch(() => 0n);
  if (gasPrice === 0n) return 0n;

  const avaxQuote = await getQuote(
    {
      tokenIn: CONFIG.wavax,
      tokenOut: CONFIG.usdc,
      amountIn: 10n ** 18n,
      decimalsIn: 18,
      decimalsOut: USDC_DECIMALS,
    },
    CONFIG.wavax,
  );
  if (!avaxQuote) return 0n;

  const weiSpent = gasPrice * CONFIG.gasUnits;
  return (weiSpent * avaxQuote.amountOut) / 10n ** 18n;
}

/**
 * Simulate one complete round trip at a given USDC size.
 * Returns null when the aggregator has no route for this leg.
 */
async function evaluate(
  p: PoolSnapshot,
  direction: Direction,
  usdcIn: bigint,
  gasUsdc: bigint,
): Promise<{ profit: bigint; exnihiloLeg: Leg; dexLeg: Leg; quote: Quote } | null> {
  if (usdcIn <= 0n) return null;

  if (direction === "POOL_CHEAP") {
    // Leg 1: USDC → token inside the pool (exact, no network call).
    const tokenOut = buyTokenWithUsdc(usdcIn, p);
    if (tokenOut === 0n) return null;

    // Leg 2: token → USDC on the open market.
    const quote = await getQuote(
      {
        tokenIn: p.token,
        tokenOut: CONFIG.usdc,
        amountIn: tokenOut,
        decimalsIn: p.tokenDecimals,
        decimalsOut: USDC_DECIMALS,
      },
      p.token,
    );
    if (!quote) return null;

    const usdcBack = haircut(quote.amountOut);
    return {
      profit: usdcBack - usdcIn - gasUsdc,
      exnihiloLeg: { venue: "EXNIHILO", amountIn: usdcIn, amountOut: tokenOut },
      dexLeg: { venue: quote.route, amountIn: tokenOut, amountOut: usdcBack },
      quote,
    };
  }

  // POOL_RICH — Leg 1: USDC → token on the open market.
  const quote = await getQuote(
    {
      tokenIn: CONFIG.usdc,
      tokenOut: p.token,
      amountIn: usdcIn,
      decimalsIn: USDC_DECIMALS,
      decimalsOut: p.tokenDecimals,
    },
    p.token,
  );
  if (!quote) return null;

  const tokenOut = haircut(quote.amountOut);
  if (tokenOut === 0n) return null;

  // Leg 2: token → USDC inside the pool. Guard the pool's own input ceiling,
  // beyond which the spot-value fee exceeds the output and swap() reverts.
  if (tokenOut >= maxAmountIn(p.backedAirToken, p.swapFeeBps)) return null;

  const usdcBack = sellTokenForUsdc(tokenOut, p);
  if (usdcBack === 0n) return null;

  return {
    profit: usdcBack - usdcIn - gasUsdc,
    exnihiloLeg: { venue: "EXNIHILO", amountIn: tokenOut, amountOut: usdcBack },
    dexLeg: { venue: quote.route, amountIn: usdcIn, amountOut: tokenOut },
    quote,
  };
}

/**
 * Golden-section search for the profit-maximising size.
 *
 * Profit(size) is unimodal, so this converges without derivatives — and unlike
 * a plain ternary search it reuses one interior point per iteration, costing a
 * single aggregator call per step instead of two.
 */
async function refine(
  p: PoolSnapshot,
  direction: Direction,
  lo: bigint,
  hi: bigint,
  gasUsdc: bigint,
  steps: number,
) {
  const INV_PHI = 0.6180339887;
  const span = () => hi - lo;
  const at = (frac: number) => lo + BigInt(Math.round(Number(span()) * frac));

  let x1 = at(1 - INV_PHI);
  let x2 = at(INV_PHI);
  let r1 = await evaluate(p, direction, x1, gasUsdc);
  let r2 = await evaluate(p, direction, x2, gasUsdc);

  let best = (r1?.profit ?? -1n) >= (r2?.profit ?? -1n) ? r1 : r2;
  let bestSize = (r1?.profit ?? -1n) >= (r2?.profit ?? -1n) ? x1 : x2;

  for (let i = 0; i < steps; i++) {
    if (hi - lo < 1_000_000n) break; // converged to within $1

    if ((r1?.profit ?? -1n) < (r2?.profit ?? -1n)) {
      lo = x1;
      x1 = x2;
      r1 = r2;
      x2 = at(INV_PHI);
      r2 = await evaluate(p, direction, x2, gasUsdc);
      if (r2 && r2.profit > (best?.profit ?? -1n)) [best, bestSize] = [r2, x2];
    } else {
      hi = x2;
      x2 = x1;
      r2 = r1;
      x1 = at(1 - INV_PHI);
      r1 = await evaluate(p, direction, x1, gasUsdc);
      if (r1 && r1.profit > (best?.profit ?? -1n)) [best, bestSize] = [r1, x1];
    }
  }

  return best ? { result: best, size: bestSize } : null;
}

/** Scan a single pool end to end. */
export async function scanPool(p: PoolSnapshot, gasUsdc: bigint): Promise<ScanResult> {
  // ── Stage 0: the pool must actually be able to quote a swap ───────────────
  if (p.backedAirToken === 0n || p.backedAirUsd === 0n) {
    return { pool: p, reason: "empty reserves" };
  }

  const poolMid = midFloat(p);
  if (poolMid === 0) return { pool: p, reason: "unpriceable reserves" };

  // ── Stage 1: probe the external market ───────────────────────────────────
  // The smallest ladder rung, so the probe reflects a near-mid price rather
  // than one already distorted by our own impact.
  const depthCap = depthCapUsdc(p, CONFIG.maxPoolDepthBps);
  const probeUsdc = (() => {
    const smallest = BigInt(Math.round(CONFIG.sizeLadderUsdc[0] * 1e6));
    return smallest < depthCap ? smallest : depthCap;
  })();
  if (probeUsdc <= 0n) return { pool: p, reason: "pool too shallow to probe" };

  const probe = await getQuote(
    {
      tokenIn: CONFIG.usdc,
      tokenOut: p.token,
      amountIn: probeUsdc,
      decimalsIn: USDC_DECIMALS,
      decimalsOut: p.tokenDecimals,
    },
    p.token,
  );
  if (!probe) return { pool: p, reason: "no external market for token" };

  // Implied external price, as a float for the same precision reason.
  const dexMid =
    probeUsdc === 0n || probe.amountOut === 0n
      ? 0
      : Number(probeUsdc) / 1e6 / (Number(probe.amountOut) / 10 ** p.tokenDecimals);

  const gapBps = ((dexMid - poolMid) / poolMid) * 10_000;

  // ── Stage 2: the no-arb band gate ────────────────────────────────────────
  // Inside the band NO size is profitable, because price impact only ever
  // widens the spread — so for the EXNIHILO leg this rejection is exact rather
  // than heuristic. MIN_EDGE_BPS pads it for the DEX's own fee and for gas.
  //
  // The band is asymmetric: buying out of the pool costs mid/(1-f) while
  // selling into it receives mid*(1-f), so each edge is tested against its own
  // bound rather than a single |gap|.
  //
  // This compares MID prices deliberately. Comparing realised fills instead
  // (pool tokens-out vs DEX tokens-out for the same input) looks more direct
  // but is size-dependent: the probe is capped by pool depth, so on a shallow
  // pool it is a large fraction of the reserve and pool slippage — not the
  // dislocation — dominates the comparison, which can invert the detected
  // direction. Mids have no such dependency.
  const band = noArbBand(p);
  const edge = CONFIG.minEdgeBps / 10_000;
  const cheapThreshold = band.upper * (1 + edge); // pool cheap: DEX must be above
  const richThreshold = band.lower * (1 - edge); // pool rich:  DEX must be below

  if (dexMid < cheapThreshold && dexMid > richThreshold) {
    return {
      pool: p,
      reason: `inside no-arb band (fee ${Number(p.swapFeeBps) / 100}% + ${
        CONFIG.minEdgeBps
      } bps)`,
      gapBps,
    };
  }

  const direction: Direction = dexMid >= cheapThreshold ? "POOL_CHEAP" : "POOL_RICH";

  // ── Stage 3: size ladder ─────────────────────────────────────────────────
  const sizes = buildLadder(depthCap);

  if (sizes.length === 0) {
    return { pool: p, reason: "pool depth below $1 minimum trade", gapBps };
  }

  let best: Awaited<ReturnType<typeof evaluate>> = null;
  let bestSize = 0n;
  let bestIdx = -1;

  for (let i = 0; i < sizes.length; i++) {
    const r = await evaluate(p, direction, sizes[i], gasUsdc);
    if (!r) continue;
    if (!best || r.profit > best.profit) {
      best = r;
      bestSize = sizes[i];
      bestIdx = i;
    }
    // Concavity: once profit turns down, larger sizes only get worse.
    if (best && r.profit < best.profit && i > bestIdx + 1) break;
  }

  if (!best) return { pool: p, reason: "no route for round trip", gapBps };

  // ── Stage 3b: refine around the winning rung ─────────────────────────────
  if (CONFIG.refineSteps > 0 && bestIdx >= 0) {
    const lo = bestIdx > 0 ? sizes[bestIdx - 1] : sizes[0] / 2n;
    const hi = bestIdx < sizes.length - 1 ? sizes[bestIdx + 1] : sizes[bestIdx] * 2n;
    const capped = hi < depthCap ? hi : depthCap;

    if (capped > lo) {
      const refined = await refine(p, direction, lo, capped, gasUsdc, CONFIG.refineSteps);
      if (refined && refined.result.profit > best.profit) {
        best = refined.result;
        bestSize = refined.size;
      }
    }
  }

  const minProfit = BigInt(Math.round(CONFIG.minProfitUsdc * 1e6));
  if (best.profit < minProfit) {
    return {
      pool: p,
      reason: `best round trip below MIN_PROFIT_USDC`,
      gapBps,
      bestProfitUsdc: best.profit,
    };
  }

  const grossProfit = best.profit + gasUsdc;

  return {
    pool: p,
    direction,
    sizeUsdc: bestSize,
    profitUsdc: best.profit,
    profitBps: (Number(best.profit) / Number(bestSize)) * 10_000,
    grossBps: (Number(grossProfit) / Number(bestSize)) * 10_000,
    gasUsdc,
    exnihiloLeg: best.exnihiloLeg,
    dexLeg: best.dexLeg,
    dexRoute: best.quote.route,
    dexProvider: best.quote.provider,
    poolMid,
    dexMid,
    gapBps,
  };
}

export type { Address };
