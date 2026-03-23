import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "ponder:api";
import {
  priceSnapshot,
  poolMetrics,
  protocolMetrics,
  userActivity,
  dailyMetrics,
} from "ponder:schema";
import { eq, desc, gte, sql } from "ponder";

const app = new Hono();
app.use("/*", cors());

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as `0x${string}`;

// ── Price history for a pool ─────────────────────────────────────────────────

app.get("/prices/:pool", async (c) => {
  const pool = c.req.param("pool")?.toLowerCase() as `0x${string}`;
  const limit = Math.min(Number(c.req.query("limit") ?? 500), 1000);

  const rows = await db
    .select()
    .from(priceSnapshot)
    .where(eq(priceSnapshot.pool, pool))
    .orderBy(desc(priceSnapshot.timestamp))
    .limit(limit);

  rows.reverse();

  return c.json({
    pool,
    count: rows.length,
    prices: rows.map((r) => ({
      timestamp: Number(r.timestamp),
      spot: r.spotPrice.toString(),
      long: r.longPrice.toString(),
      short: r.shortPrice.toString(),
      event: r.eventType,
    })),
  });
});

// ── Pool metrics ─────────────────────────────────────────────────────────────

app.get("/metrics/pool/:pool", async (c) => {
  const pool = c.req.param("pool")?.toLowerCase() as `0x${string}`;

  const rows = await db
    .select()
    .from(poolMetrics)
    .where(eq(poolMetrics.address, pool))
    .limit(1);

  if (rows.length === 0) return c.json({ error: "Pool not found" }, 404);
  const r = rows[0];

  return c.json({
    pool: r.address,
    swapVolume: r.swapVolume.toString(),
    positionVolume: r.positionVolume.toString(),
    totalVolume: (r.swapVolume + r.positionVolume).toString(),
    totalFees: r.totalFees.toString(),
    lpFees: r.lpFees.toString(),
    protocolFees: r.protocolFees.toString(),
    swapCount: r.swapCount,
    longCount: r.longCount,
    shortCount: r.shortCount,
    closeCount: r.closeCount,
  });
});

// ── All pool metrics ─────────────────────────────────────────────────────────

app.get("/metrics/pools", async (c) => {
  const rows = await db.select().from(poolMetrics);

  return c.json({
    count: rows.length,
    pools: rows.map((r) => ({
      pool: r.address,
      swapVolume: r.swapVolume.toString(),
      positionVolume: r.positionVolume.toString(),
      totalVolume: (r.swapVolume + r.positionVolume).toString(),
      totalFees: r.totalFees.toString(),
      lpFees: r.lpFees.toString(),
      protocolFees: r.protocolFees.toString(),
      swapCount: r.swapCount,
      longCount: r.longCount,
      shortCount: r.shortCount,
      closeCount: r.closeCount,
    })),
  });
});

// ── Protocol-wide metrics ────────────────────────────────────────────────────

app.get("/metrics/protocol", async (c) => {
  const rows = await db
    .select()
    .from(protocolMetrics)
    .where(eq(protocolMetrics.id, "global"))
    .limit(1);

  if (rows.length === 0) {
    return c.json({
      totalSwapVolume: "0",
      totalPositionVolume: "0",
      totalVolume: "0",
      totalFees: "0",
      totalLpFees: "0",
      totalProtocolFees: "0",
      totalSwaps: 0,
      totalPositions: 0,
      totalCloses: 0,
      poolCount: 0,
    });
  }

  const r = rows[0];
  return c.json({
    totalSwapVolume: r.totalSwapVolume.toString(),
    totalPositionVolume: r.totalPositionVolume.toString(),
    totalVolume: (r.totalSwapVolume + r.totalPositionVolume).toString(),
    totalFees: r.totalFees.toString(),
    totalLpFees: r.totalLpFees.toString(),
    totalProtocolFees: r.totalProtocolFees.toString(),
    totalSwaps: r.totalSwaps,
    totalPositions: r.totalPositions,
    totalCloses: r.totalCloses,
    poolCount: r.poolCount,
  });
});

// ── User stats ───────────────────────────────────────────────────────────────

app.get("/metrics/users", async (c) => {
  const allUsers = await db.select().from(userActivity);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const thirtyDaysAgo = now - 30n * 86400n;
  const sevenDaysAgo = now - 7n * 86400n;

  const total = allUsers.length;
  const active30d = allUsers.filter((u) => u.lastSeen >= thirtyDaysAgo).length;
  const active7d = allUsers.filter((u) => u.lastSeen >= sevenDaysAgo).length;

  const totalVolume = allUsers.reduce((sum, u) => sum + u.totalVolume, 0n);
  const totalFeesPaid = allUsers.reduce((sum, u) => sum + u.totalFeesPaid, 0n);

  return c.json({
    totalUsers: total,
    activeUsers30d: active30d,
    activeUsers7d: active7d,
    totalUserVolume: totalVolume.toString(),
    totalUserFeesPaid: totalFeesPaid.toString(),
  });
});

// ── Single user stats ────────────────────────────────────────────────────────

app.get("/metrics/user/:address", async (c) => {
  const addr = c.req.param("address")?.toLowerCase() as `0x${string}`;

  const rows = await db
    .select()
    .from(userActivity)
    .where(eq(userActivity.address, addr))
    .limit(1);

  if (rows.length === 0) return c.json({ error: "User not found" }, 404);
  const r = rows[0];

  return c.json({
    address: r.address,
    firstSeen: Number(r.firstSeen),
    lastSeen: Number(r.lastSeen),
    swapCount: r.swapCount,
    longCount: r.longCount,
    shortCount: r.shortCount,
    totalVolume: r.totalVolume.toString(),
    totalFeesPaid: r.totalFeesPaid.toString(),
  });
});

// ── Daily metrics (for charts) ───────────────────────────────────────────────

app.get("/metrics/daily/:pool", async (c) => {
  const pool = c.req.param("pool")?.toLowerCase() as `0x${string}`;
  const days = Math.min(Number(c.req.query("days") ?? 30), 365);
  const since = BigInt(Math.floor(Date.now() / 1000)) - BigInt(days) * 86400n;

  const rows = await db
    .select()
    .from(dailyMetrics)
    .where(eq(dailyMetrics.pool, pool))
    .orderBy(desc(dailyMetrics.dayTimestamp))
    .limit(days);

  rows.reverse();

  return c.json({
    pool,
    days: rows.map((r) => ({
      date: Number(r.dayTimestamp),
      volume: r.volume.toString(),
      fees: r.fees.toString(),
      swaps: r.swapCount,
      positions: r.positionCount,
      users: r.uniqueUsers,
    })),
  });
});

// Global daily
app.get("/metrics/daily", async (c) => {
  const days = Math.min(Number(c.req.query("days") ?? 30), 365);

  const rows = await db
    .select()
    .from(dailyMetrics)
    .where(eq(dailyMetrics.pool, ZERO_ADDR))
    .orderBy(desc(dailyMetrics.dayTimestamp))
    .limit(days);

  rows.reverse();

  return c.json({
    days: rows.map((r) => ({
      date: Number(r.dayTimestamp),
      volume: r.volume.toString(),
      fees: r.fees.toString(),
      swaps: r.swapCount,
      positions: r.positionCount,
      users: r.uniqueUsers,
    })),
  });
});

// ── Status ───────────────────────────────────────────────────────────────────

app.get("/api-status", (c) => c.json({ status: "ok" }));

export default app;
