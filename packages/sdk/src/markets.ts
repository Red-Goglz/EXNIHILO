import { exnihiloFactoryAbi, exnihiloPoolAbi, erc20Abi } from "@exnihilio/abis";
import type { Address } from "viem";
import type { Ctx } from "./client.js";
import { BPS_DENOM, CAP_MAX_BPS, CAP_RAMP_SECONDS, DURATION_STEPS, DURATION_MAX } from "./constants.js";

export interface MarketSummary {
  pool: Address;
  token: Address;
  usdc: Address;
  /** USDC (6 dec) backing payouts. The side the position cap is a share of. */
  backedAirUsd: bigint;
  /** Underlying token backing the other side, in the token's own decimals. */
  backedAirToken: bigint;
  /** USDC per whole token, 6 dec. */
  spotPrice: bigint;
  /** Current position cap in bps of `backedAirUsd`: 100 at launch → 2000. */
  currentMaxPositionBps: bigint;
  /** That cap as a USDC notional (6 dec). The largest position openable now. */
  effectiveLeverageCap: bigint;
  /** Market creation timestamp. Anchors the cap ramp. */
  createdAt: bigint;
  /**
   * Lifetime a position opened right now would receive, in seconds. Steps with
   * market age: 1h → 24h → 7d → 30d over the first week.
   */
  currentPositionDuration: bigint;
  /** Non-zero once closure has been initiated; no new positions can open. */
  closeDate: bigint;
  openPositionCount: bigint;
}

/** Every pool the factory has created, oldest first. */
export async function listMarkets(ctx: Ctx): Promise<Address[]> {
  const count = await ctx.publicClient.readContract({
    address: ctx.addresses.factory,
    abi: exnihiloFactoryAbi,
    functionName: "allPoolsLength",
  });

  const calls = Array.from({ length: Number(count) }, (_, i) => ({
    address: ctx.addresses.factory,
    abi: exnihiloFactoryAbi,
    functionName: "allPools" as const,
    args: [BigInt(i)] as const,
  }));

  const results = await ctx.publicClient.multicall({ contracts: calls });
  return results.map((r) => r.result as Address);
}

/** True if this pool came from the configured factory. */
export async function isMarket(ctx: Ctx, pool: Address): Promise<boolean> {
  return ctx.publicClient.readContract({
    address: ctx.addresses.factory,
    abi: exnihiloFactoryAbi,
    functionName: "isPool",
    args: [pool],
  }) as Promise<boolean>;
}

/** One round-trip snapshot of a market's tradable state. */
export async function getMarket(ctx: Ctx, pool: Address): Promise<MarketSummary> {
  const c = { address: pool, abi: exnihiloPoolAbi } as const;

  const results = await ctx.publicClient.multicall({
    contracts: [
      { ...c, functionName: "underlyingToken" },
      { ...c, functionName: "underlyingUsdc" },
      { ...c, functionName: "backedAirUsd" },
      { ...c, functionName: "backedAirToken" },
      { ...c, functionName: "spotPrice" },
      { ...c, functionName: "currentMaxPositionBps" },
      { ...c, functionName: "effectiveLeverageCap" },
      { ...c, functionName: "createdAt" },
      { ...c, functionName: "currentPositionDuration" },
      { ...c, functionName: "closeDate" },
      { ...c, functionName: "openPositionCount" },
    ],
    allowFailure: false,
  });

  return {
    pool,
    token: results[0] as Address,
    usdc: results[1] as Address,
    backedAirUsd: results[2] as bigint,
    backedAirToken: results[3] as bigint,
    spotPrice: results[4] as bigint,
    currentMaxPositionBps: results[5] as bigint,
    effectiveLeverageCap: results[6] as bigint,
    createdAt: results[7] as bigint,
    currentPositionDuration: results[8] as bigint,
    closeDate: results[9] as bigint,
    openPositionCount: results[10] as bigint,
  };
}

export interface PositionCapStatus {
  /** Current cap in bps of backedAirUsd. */
  bps: bigint;
  /** Current cap as a USDC notional (6 dec). */
  usdc: bigint;
  /** False once the ramp has reached its 20 % ceiling. */
  isRamping: boolean;
  /** Unix seconds at which the ramp completes. */
  rampEndsAt: bigint;
  /** Seconds until the ceiling, 0 once reached. Needs `nowSeconds`. */
  secondsRemaining: bigint;
}

/**
 * Position cap state, for showing a trader why their size is limited.
 *
 * @param nowSeconds Current unix time. Passed in rather than read from the
 *                   host clock so callers in a React render stay pure and
 *                   server-side callers can pin it to a block timestamp.
 */
export async function getPositionCap(
  ctx: Ctx,
  pool: Address,
  nowSeconds: bigint
): Promise<PositionCapStatus> {
  const c = { address: pool, abi: exnihiloPoolAbi } as const;

  const [bps, usdc, createdAt] = (await ctx.publicClient.multicall({
    contracts: [
      { ...c, functionName: "currentMaxPositionBps" },
      { ...c, functionName: "effectiveLeverageCap" },
      { ...c, functionName: "createdAt" },
    ],
    allowFailure: false,
  })) as [bigint, bigint, bigint];

  const rampEndsAt = createdAt + CAP_RAMP_SECONDS;
  const remaining = rampEndsAt > nowSeconds ? rampEndsAt - nowSeconds : 0n;

  return {
    bps,
    usdc,
    isRamping: bps < CAP_MAX_BPS,
    rampEndsAt,
    secondsRemaining: remaining,
  };
}

/**
 * Predict the position cap at some future time, without a call.
 *
 * Mirrors `EXNIHILOPool.currentMaxPositionBps` exactly. Useful for "you can open
 * this size in N hours" messaging. Note the USDC value also moves with pool
 * depth, so this predicts the *percentage* only.
 */
export function projectPositionCapBps(createdAt: bigint, atTime: bigint): bigint {
  const elapsed = atTime > createdAt ? atTime - createdAt : 0n;
  if (elapsed >= CAP_RAMP_SECONDS) return CAP_MAX_BPS;
  const start = 100n;
  return start + ((CAP_MAX_BPS - start) * elapsed) / CAP_RAMP_SECONDS;
}

/**
 * Predict the position lifetime at some future time, without a call.
 *
 * Mirrors `EXNIHILOPool.currentPositionDuration` exactly. Useful for telling a
 * trader when longer-dated positions become available on a young market.
 */
export function projectPositionDuration(createdAt: bigint, atTime: bigint): bigint {
  const age = atTime > createdAt ? atTime - createdAt : 0n;
  for (const step of DURATION_STEPS) {
    if (age < step.maxAge) return step.duration;
  }
  return DURATION_MAX;
}

/** Token metadata for display. Falls back gracefully on non-standard tokens. */
export async function getTokenInfo(ctx: Ctx, token: Address) {
  const results = await ctx.publicClient.multicall({
    contracts: [
      { address: token, abi: erc20Abi, functionName: "symbol" },
      { address: token, abi: erc20Abi, functionName: "decimals" },
    ],
  });

  return {
    address: token,
    symbol: (results[0].status === "success" ? results[0].result : "???") as string,
    decimals: (results[1].status === "success" ? results[1].result : 18) as number,
  };
}

/** Convenience: cap as a human percentage, e.g. 1400n bps → 14. */
export function bpsToPercent(bps: bigint): number {
  return Number((bps * 100n) / BPS_DENOM) / 100;
}
