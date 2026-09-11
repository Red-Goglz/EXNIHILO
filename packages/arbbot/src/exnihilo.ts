/**
 * Exact off-chain mirror of the EXNIHILO pool's SWAP-1 AMM.
 *
 * Correctness here is the whole bot. Every function below reproduces the
 * Solidity in `EXNIHILOPool.sol` **including integer truncation**, so a
 * simulated fill matches the on-chain result to the wei. All arithmetic is
 * bigint; a single float would silently drift from the contract.
 *
 * ── What SWAP-1 is ─────────────────────────────────────────────────────────
 * `swap()` is a plain constant-product market between the pool's *backed*
 * reserves. The leverage machinery (openLong / openShort, SWAP-2 and SWAP-3)
 * runs against synthetic supply and does not touch this path, so from an
 * arbitrageur's seat an EXNIHILO pool is an ordinary x*y=k pool with an
 * unusual fee model.
 *
 * ── Reserves are NOT balanceOf ─────────────────────────────────────────────
 * The pool custodies collateral for open positions on top of its AMM
 * reserves. `token.balanceOf(pool)` therefore overstates what swaps price
 * against. The only correct inputs are the `backedAirToken` / `backedAirUsd`
 * state variables (bundled by `indexerState()`).
 *
 * ── The fee model is not Uniswap's ─────────────────────────────────────────
 * UniswapV2 takes its fee off the *input*. EXNIHILO computes the raw
 * constant-product output first, then subtracts a fee equal to `swapFeeBps`
 * of the input's SPOT value (`amountIn * Ro / Ri`):
 *
 *     rawOut = amountIn * Ro / (Ri + amountIn)
 *     fee    = amountIn * Ro * swapFeeBps / (Ri * 10000)
 *     netOut = rawOut - fee                        (0 if rawOut <= fee)
 *
 * Because spot value always exceeds the realised output on a concave curve,
 * this fee is *harsher* than a UniV2 fee of the same bps, and the gap widens
 * with trade size. Modelling it as a flat 1% haircut would overstate profit on
 * exactly the large trades an arb bot cares about.
 */

import { BPS_DENOM } from "./config.ts";

export interface PoolState {
  /** SWAP-1 token reserve, in the underlying token's own decimals. */
  backedAirToken: bigint;
  /** SWAP-1 USDC reserve, 6 decimals. */
  backedAirUsd: bigint;
  swapFeeBps: bigint;
  tokenDecimals: number;
}

/**
 * Verbatim port of `EXNIHILOPool._cpAmountOut`.
 * Division order and floor semantics are load-bearing — do not "simplify".
 */
export function cpAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  swapFeeBps: bigint,
): bigint {
  if (reserveIn === 0n || reserveOut === 0n || amountIn <= 0n) return 0n;

  const rawOut = (amountIn * reserveOut) / (reserveIn + amountIn);
  const fee = (amountIn * reserveOut * swapFeeBps) / (reserveIn * BPS_DENOM);

  if (rawOut <= fee) return 0n;
  return rawOut - fee;
}

/**
 * Largest input the pool will accept before the spot-value fee swallows the
 * whole output and `swap()` reverts with InsufficientOutput.
 * Mirrors the bound documented above `_cpAmountOut`:
 *     reserveIn * (BPS_DENOM - swapFeeBps) / swapFeeBps
 */
export function maxAmountIn(reserveIn: bigint, swapFeeBps: bigint): bigint {
  if (swapFeeBps === 0n) return reserveIn * 1_000_000n;
  return (reserveIn * (BPS_DENOM - swapFeeBps)) / swapFeeBps;
}

/** USDC in → underlying token out (`swap(amountIn, _, tokenToUsdc=false, _)`). */
export function buyTokenWithUsdc(usdcIn: bigint, p: PoolState): bigint {
  return cpAmountOut(usdcIn, p.backedAirUsd, p.backedAirToken, p.swapFeeBps);
}

/** Underlying token in → USDC out (`swap(amountIn, _, tokenToUsdc=true, _)`). */
export function sellTokenForUsdc(tokenIn: bigint, p: PoolState): bigint {
  return cpAmountOut(tokenIn, p.backedAirToken, p.backedAirUsd, p.swapFeeBps);
}

/**
 * Mid price: USDC (6 dec) per ONE whole token. Matches `spotPrice()`.
 * This is the fee-free mid — actual fills sit on either side of it.
 */
export function spotPrice(p: PoolState): bigint {
  if (p.backedAirToken === 0n) return 0n;
  return (p.backedAirUsd * 10n ** BigInt(p.tokenDecimals)) / p.backedAirToken;
}

/**
 * The pool's no-arb band, as a float multiple of the mid price.
 *
 * For an infinitesimal trade the fee is exactly `swapFeeBps` of spot value, so
 * the marginal execution prices are:
 *
 *     buying token from the pool   →  mid / (1 - f)     (you pay a premium)
 *     selling token to the pool    →  mid * (1 - f)     (you receive a discount)
 *
 * Any external price strictly inside [mid*(1-f), mid/(1-f)] cannot be arbed at
 * ANY size against this pool, because price impact only widens the spread
 * further. That makes this an exact, not heuristic, rejection test — the
 * cheap gate in `arb.ts` is this band plus a margin for the DEX's own fee.
 */
export function noArbBand(p: PoolState): { lower: number; upper: number; mid: number } {
  const mid = midFloat(p);
  const f = Number(p.swapFeeBps) / 10_000;
  return { lower: mid * (1 - f), upper: mid / (1 - f), mid };
}

/**
 * Pool mid as a float: USDC per whole token, at full precision.
 *
 * `spotPrice()` is the contract's own representation — a 6-decimal integer —
 * and must stay that way to match on-chain reads. But that scale collapses for
 * micro-priced tokens: a token worth $0.0000011 quantises to the integer `1`,
 * a single significant digit and a ~10 % error. Comparing two such values
 * against each other reports a zero gap no matter how far apart they actually
 * are, silently hiding real dislocations.
 *
 * Anything that compares the pool against an external price must use this.
 */
export function midFloat(p: PoolState): number {
  if (p.backedAirToken === 0n) return 0;
  const usd = Number(p.backedAirUsd) / 1e6;
  const tokens = Number(p.backedAirToken) / 10 ** p.tokenDecimals;
  return tokens === 0 ? 0 : usd / tokens;
}

/**
 * Cap the probe size at a share of the pool's USDC depth. Sizes beyond this
 * are arithmetically valid but economically pointless: EXNIHILO price impact
 * grows faster than any realistic external edge.
 */
export function depthCapUsdc(p: PoolState, maxPoolDepthBps: number): bigint {
  return (p.backedAirUsd * BigInt(Math.round(maxPoolDepthBps))) / BPS_DENOM;
}
