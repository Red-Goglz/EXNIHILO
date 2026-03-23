import { ponder } from "ponder:registry";
import {
  priceSnapshot,
  poolMetrics,
  protocolMetrics,
  userActivity,
  dailyMetrics,
} from "ponder:schema";
import { exnihiloPoolAbi } from "../EXNIHILOPool.js";

// ── Fee constants (match contract) ───────────────────────────────────────────
const PROTOCOL_FEE_BPS = 200n;
const LP_FEE_BPS = 300n;
const TOTAL_FEE_BPS = PROTOCOL_FEE_BPS + LP_FEE_BPS; // 500 = 5%

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as `0x${string}`;

function dayTimestamp(ts: bigint): bigint {
  return (ts / 86400n) * 86400n;
}

// ── Snapshot prices ──────────────────────────────────────────────────────────

async function snapshotPrices(
  context: any,
  poolAddress: `0x${string}`,
  event: any,
  eventType: string
) {
  const [backedAirToken, backedAirUsd, longPriceVal, shortPriceVal] =
    await Promise.all([
      context.client.readContract({ abi: exnihiloPoolAbi, address: poolAddress, functionName: "backedAirToken" }),
      context.client.readContract({ abi: exnihiloPoolAbi, address: poolAddress, functionName: "backedAirUsd" }),
      context.client.readContract({ abi: exnihiloPoolAbi, address: poolAddress, functionName: "longPrice" }),
      context.client.readContract({ abi: exnihiloPoolAbi, address: poolAddress, functionName: "shortPrice" }),
    ]);

  const spotPrice = backedAirToken > 0n
    ? (backedAirUsd * 10n ** 18n) / backedAirToken
    : 0n;

  await context.db.insert(priceSnapshot).values({
    id: `${poolAddress}-${event.block.number}-${event.log.logIndex}`,
    pool: poolAddress,
    blockNumber: BigInt(event.block.number),
    timestamp: BigInt(event.block.timestamp),
    backedAirToken,
    backedAirUsd,
    spotPrice,
    longPrice: longPriceVal,
    shortPrice: shortPriceVal,
    eventType,
  });
}

// ── Update pool metrics ──────────────────────────────────────────────────────

async function updatePoolMetrics(
  context: any,
  pool: `0x${string}`,
  timestamp: bigint,
  updates: {
    swapVolume?: bigint;
    positionVolume?: bigint;
    totalFees?: bigint;
    lpFees?: bigint;
    protocolFees?: bigint;
    swapCount?: number;
    longCount?: number;
    shortCount?: number;
    closeCount?: number;
  }
) {
  await context.db
    .insert(poolMetrics)
    .values({
      address: pool,
      swapVolume: updates.swapVolume ?? 0n,
      positionVolume: updates.positionVolume ?? 0n,
      totalFees: updates.totalFees ?? 0n,
      lpFees: updates.lpFees ?? 0n,
      protocolFees: updates.protocolFees ?? 0n,
      swapCount: updates.swapCount ?? 0,
      longCount: updates.longCount ?? 0,
      shortCount: updates.shortCount ?? 0,
      closeCount: updates.closeCount ?? 0,
      lastUpdated: timestamp,
    })
    .onConflictDoUpdate((row: any) => ({
      swapVolume: row.swapVolume + (updates.swapVolume ?? 0n),
      positionVolume: row.positionVolume + (updates.positionVolume ?? 0n),
      totalFees: row.totalFees + (updates.totalFees ?? 0n),
      lpFees: row.lpFees + (updates.lpFees ?? 0n),
      protocolFees: row.protocolFees + (updates.protocolFees ?? 0n),
      swapCount: row.swapCount + (updates.swapCount ?? 0),
      longCount: row.longCount + (updates.longCount ?? 0),
      shortCount: row.shortCount + (updates.shortCount ?? 0),
      closeCount: row.closeCount + (updates.closeCount ?? 0),
      lastUpdated: timestamp,
    }));
}

// ── Update protocol-wide metrics ─────────────────────────────────────────────

async function updateProtocolMetrics(
  context: any,
  timestamp: bigint,
  updates: {
    swapVolume?: bigint;
    positionVolume?: bigint;
    fees?: bigint;
    lpFees?: bigint;
    protocolFees?: bigint;
    swaps?: number;
    positions?: number;
    closes?: number;
    newPool?: boolean;
  }
) {
  await context.db
    .insert(protocolMetrics)
    .values({
      id: "global",
      totalSwapVolume: updates.swapVolume ?? 0n,
      totalPositionVolume: updates.positionVolume ?? 0n,
      totalFees: updates.fees ?? 0n,
      totalLpFees: updates.lpFees ?? 0n,
      totalProtocolFees: updates.protocolFees ?? 0n,
      totalSwaps: updates.swaps ?? 0,
      totalPositions: updates.positions ?? 0,
      totalCloses: updates.closes ?? 0,
      poolCount: updates.newPool ? 1 : 0,
      lastUpdated: timestamp,
    })
    .onConflictDoUpdate((row: any) => ({
      totalSwapVolume: row.totalSwapVolume + (updates.swapVolume ?? 0n),
      totalPositionVolume: row.totalPositionVolume + (updates.positionVolume ?? 0n),
      totalFees: row.totalFees + (updates.fees ?? 0n),
      totalLpFees: row.totalLpFees + (updates.lpFees ?? 0n),
      totalProtocolFees: row.totalProtocolFees + (updates.protocolFees ?? 0n),
      totalSwaps: row.totalSwaps + (updates.swaps ?? 0),
      totalPositions: row.totalPositions + (updates.positions ?? 0),
      totalCloses: row.totalCloses + (updates.closes ?? 0),
      poolCount: row.poolCount + (updates.newPool ? 1 : 0),
      lastUpdated: timestamp,
    }));
}

// ── Track user activity ──────────────────────────────────────────────────────

async function trackUser(
  context: any,
  user: `0x${string}`,
  timestamp: bigint,
  updates: {
    swapCount?: number;
    longCount?: number;
    shortCount?: number;
    volume?: bigint;
    feesPaid?: bigint;
  }
) {
  await context.db
    .insert(userActivity)
    .values({
      address: user,
      firstSeen: timestamp,
      lastSeen: timestamp,
      swapCount: updates.swapCount ?? 0,
      longCount: updates.longCount ?? 0,
      shortCount: updates.shortCount ?? 0,
      totalVolume: updates.volume ?? 0n,
      totalFeesPaid: updates.feesPaid ?? 0n,
    })
    .onConflictDoUpdate((row: any) => ({
      lastSeen: timestamp,
      swapCount: row.swapCount + (updates.swapCount ?? 0),
      longCount: row.longCount + (updates.longCount ?? 0),
      shortCount: row.shortCount + (updates.shortCount ?? 0),
      totalVolume: row.totalVolume + (updates.volume ?? 0n),
      totalFeesPaid: row.totalFeesPaid + (updates.feesPaid ?? 0n),
    }));
}

// ── Update daily metrics ─────────────────────────────────────────────────────

async function updateDaily(
  context: any,
  pool: `0x${string}`,
  timestamp: bigint,
  volume: bigint,
  fees: bigint,
  swaps: number,
  positions: number,
) {
  const day = dayTimestamp(timestamp);

  // Per-pool daily
  await context.db
    .insert(dailyMetrics)
    .values({
      id: `${pool}-${day}`,
      pool,
      dayTimestamp: day,
      volume,
      fees,
      swapCount: swaps,
      positionCount: positions,
      uniqueUsers: 1,
    })
    .onConflictDoUpdate((row: any) => ({
      volume: row.volume + volume,
      fees: row.fees + fees,
      swapCount: row.swapCount + swaps,
      positionCount: row.positionCount + positions,
      uniqueUsers: row.uniqueUsers + 1, // approximate — counts events, not distinct
    }));

  // Global daily
  await context.db
    .insert(dailyMetrics)
    .values({
      id: `global-${day}`,
      pool: ZERO_ADDR,
      dayTimestamp: day,
      volume,
      fees,
      swapCount: swaps,
      positionCount: positions,
      uniqueUsers: 1,
    })
    .onConflictDoUpdate((row: any) => ({
      volume: row.volume + volume,
      fees: row.fees + fees,
      swapCount: row.swapCount + swaps,
      positionCount: row.positionCount + positions,
      uniqueUsers: row.uniqueUsers + 1,
    }));
}

// ── Event handlers ───────────────────────────────────────────────────────────

ponder.on("EXNIHILOPool:Swap", async ({ event, context }) => {
  const pool = event.log.address;
  const ts = BigInt(event.block.timestamp);
  const volume = event.args.amountIn; // USDC amount in

  await snapshotPrices(context, pool, event, "swap");

  await updatePoolMetrics(context, pool, ts, { swapVolume: volume, swapCount: 1 });
  await updateProtocolMetrics(context, ts, { swapVolume: volume, swaps: 1 });
  await trackUser(context, event.args.caller, ts, { swapCount: 1, volume });
  await updateDaily(context, pool, ts, volume, 0n, 1, 0);
});

ponder.on("EXNIHILOPool:LongOpened", async ({ event, context }) => {
  const pool = event.log.address;
  const ts = BigInt(event.block.timestamp);
  const volume = event.args.usdcIn;
  const totalFee = event.args.feesPaid;
  const lpFee = (totalFee * LP_FEE_BPS) / TOTAL_FEE_BPS;
  const protocolFee = totalFee - lpFee;

  await snapshotPrices(context, pool, event, "longOpened");

  await updatePoolMetrics(context, pool, ts, {
    positionVolume: volume, totalFees: totalFee, lpFees: lpFee, protocolFees: protocolFee, longCount: 1,
  });
  await updateProtocolMetrics(context, ts, {
    positionVolume: volume, fees: totalFee, lpFees: lpFee, protocolFees: protocolFee, positions: 1,
  });
  await trackUser(context, event.args.holder, ts, { longCount: 1, volume, feesPaid: totalFee });
  await updateDaily(context, pool, ts, volume, totalFee, 0, 1);
});

ponder.on("EXNIHILOPool:ShortOpened", async ({ event, context }) => {
  const pool = event.log.address;
  const ts = BigInt(event.block.timestamp);
  const volume = event.args.airUsdLocked; // USDC equivalent
  const totalFee = event.args.feesPaid;
  const lpFee = (totalFee * LP_FEE_BPS) / TOTAL_FEE_BPS;
  const protocolFee = totalFee - lpFee;

  await snapshotPrices(context, pool, event, "shortOpened");

  await updatePoolMetrics(context, pool, ts, {
    positionVolume: volume, totalFees: totalFee, lpFees: lpFee, protocolFees: protocolFee, shortCount: 1,
  });
  await updateProtocolMetrics(context, ts, {
    positionVolume: volume, fees: totalFee, lpFees: lpFee, protocolFees: protocolFee, positions: 1,
  });
  await trackUser(context, event.args.holder, ts, { shortCount: 1, volume, feesPaid: totalFee });
  await updateDaily(context, pool, ts, volume, totalFee, 0, 1);
});

ponder.on("EXNIHILOPool:LongClosed", async ({ event, context }) => {
  const pool = event.log.address;
  const ts = BigInt(event.block.timestamp);

  await snapshotPrices(context, pool, event, "longClosed");
  await updatePoolMetrics(context, pool, ts, { closeCount: 1 });
  await updateProtocolMetrics(context, ts, { closes: 1 });
  await trackUser(context, event.args.holder, ts, {});
});

ponder.on("EXNIHILOPool:ShortClosed", async ({ event, context }) => {
  const pool = event.log.address;
  const ts = BigInt(event.block.timestamp);

  await snapshotPrices(context, pool, event, "shortClosed");
  await updatePoolMetrics(context, pool, ts, { closeCount: 1 });
  await updateProtocolMetrics(context, ts, { closes: 1 });
  await trackUser(context, event.args.holder, ts, {});
});

ponder.on("EXNIHILOPool:LiquidityAdded", async ({ event, context }) => {
  const pool = event.log.address;
  const ts = BigInt(event.block.timestamp);

  await snapshotPrices(context, pool, event, "liquidityAdded");
  await updatePoolMetrics(context, pool, ts, {});
  await updateProtocolMetrics(context, ts, { newPool: true }); // first liquidity = new pool
  await trackUser(context, event.args.provider, ts, {});
});

ponder.on("EXNIHILOPool:LiquidityRemoved", async ({ event, context }) => {
  const pool = event.log.address;
  const ts = BigInt(event.block.timestamp);

  await snapshotPrices(context, pool, event, "liquidityRemoved");
  await trackUser(context, event.args.provider, ts, {});
});

ponder.on("EXNIHILOPool:LongRealized", async ({ event, context }) => {
  const pool = event.log.address;
  const ts = BigInt(event.block.timestamp);

  await snapshotPrices(context, pool, event, "longRealized");
  await updatePoolMetrics(context, pool, ts, { closeCount: 1 });
  await updateProtocolMetrics(context, ts, { closes: 1 });
  await trackUser(context, event.args.holder, ts, {});
});

ponder.on("EXNIHILOPool:ShortRealized", async ({ event, context }) => {
  const pool = event.log.address;
  const ts = BigInt(event.block.timestamp);

  await snapshotPrices(context, pool, event, "shortRealized");
  await updatePoolMetrics(context, pool, ts, { closeCount: 1 });
  await updateProtocolMetrics(context, ts, { closes: 1 });
  await trackUser(context, event.args.holder, ts, {});
});

ponder.on("EXNIHILOPool:PositionForceRealized", async ({ event, context }) => {
  const pool = event.log.address;
  const ts = BigInt(event.block.timestamp);

  await snapshotPrices(context, pool, event, "forceRealized");
  await updatePoolMetrics(context, pool, ts, { closeCount: 1 });
  await updateProtocolMetrics(context, ts, { closes: 1 });
  await trackUser(context, event.args.lpOwner, ts, {});
});
