import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "ponder:api";
import {
  position,
  lpOwnership,
  priceSnapshot,
  poolMetrics,
  protocolMetrics,
  userActivity,
  dailyMetrics,
} from "ponder:schema";
import { eq, desc, gte, and, sql } from "ponder";
import { INDEXED_CHAIN_ID, ZERO_ADDR } from "../chain.js";

const app = new Hono();
app.use("/*", cors());

// The frontend sends ?chainId= on every request; answering for a different
// chain would silently serve wrong-chain data, so reject those instead.
app.use("/*", async (c, next) => {
  const chainId = c.req.query("chainId");
  if (chainId && Number(chainId) !== INDEXED_CHAIN_ID) {
    return c.json(
      { error: `This indexer serves chainId ${INDEXED_CHAIN_ID}, got ${chainId}` },
      404,
    );
  }
  await next();
});

// ── Price history for a pool ────────────────────────────────────────────────

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

// ── Positions by pool ───────────────────────────────────────────────────────

app.get("/positions/:pool", async (c) => {
  const pool = c.req.param("pool")?.toLowerCase() as `0x${string}`;
  const status = c.req.query("status");
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);

  const rows = await db
    .select()
    .from(position)
    .where(
      status
        ? and(eq(position.pool, pool), eq(position.status, status))
        : eq(position.pool, pool),
    )
    .orderBy(desc(position.openedAt))
    .limit(limit);

  return c.json({
    pool,
    count: rows.length,
    positions: rows.map((r) => ({
      nftId: r.nftId.toString(),
      holder: r.holder,
      isLong: r.isLong,
      usdcIn: r.usdcIn.toString(),
      lockedAmount: r.lockedAmount.toString(),
      feesPaid: r.feesPaid.toString(),
      openedAt: Number(r.openedAt),
      deadline: Number(r.deadline),
      status: r.status,
      payout: r.payout.toString(),
      closedAt: Number(r.closedAt),
    })),
  });
});

// ── Single position ─────────────────────────────────────────────────────────

app.get("/position/:nftId", async (c) => {
  const nftId = BigInt(c.req.param("nftId") ?? "0");

  const rows = await db
    .select()
    .from(position)
    .where(eq(position.nftId, nftId))
    .limit(1);

  if (rows.length === 0) return c.json({ error: "Position not found" }, 404);
  const r = rows[0];

  return c.json({
    nftId: r.nftId.toString(),
    pool: r.pool,
    holder: r.holder,
    isLong: r.isLong,
    lockedAmount: r.lockedAmount.toString(),
    usdcIn: r.usdcIn.toString(),
    airUsdMinted: r.airUsdMinted.toString(),
    airTokenMinted: r.airTokenMinted.toString(),
    feesPaid: r.feesPaid.toString(),
    openedAt: Number(r.openedAt),
    deadline: Number(r.deadline),
    status: r.status,
    payout: r.payout.toString(),
    closedAt: Number(r.closedAt),
  });
});

// ── Positions by user ───────────────────────────────────────────────────────

app.get("/positions/user/:address", async (c) => {
  const addr = c.req.param("address")?.toLowerCase() as `0x${string}`;
  const status = c.req.query("status");
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);

  const rows = await db
    .select()
    .from(position)
    .where(
      status
        ? and(eq(position.holder, addr), eq(position.status, status))
        : eq(position.holder, addr),
    )
    .orderBy(desc(position.openedAt))
    .limit(limit);

  return c.json({
    address: addr,
    count: rows.length,
    positions: rows.map((r) => ({
      nftId: r.nftId.toString(),
      pool: r.pool,
      isLong: r.isLong,
      usdcIn: r.usdcIn.toString(),
      lockedAmount: r.lockedAmount.toString(),
      feesPaid: r.feesPaid.toString(),
      openedAt: Number(r.openedAt),
      deadline: Number(r.deadline),
      status: r.status,
      payout: r.payout.toString(),
      closedAt: Number(r.closedAt),
    })),
  });
});

// ── Pool metrics ────────────────────────────────────────────────────────────

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
    positionVolume: r.positionVolume.toString(),
    totalFees: r.totalFees.toString(),
    lpFees: r.lpFees.toString(),
    protocolFees: r.protocolFees.toString(),
    longCount: r.longCount,
    shortCount: r.shortCount,
    closeCount: r.closeCount,
    totalPayout: r.totalPayout.toString(),
  });
});

// ── All pool metrics ────────────────────────────────────────────────────────

app.get("/metrics/pools", async (c) => {
  const rows = await db.select().from(poolMetrics);

  return c.json({
    count: rows.length,
    pools: rows.map((r) => ({
      pool: r.address,
      positionVolume: r.positionVolume.toString(),
      totalFees: r.totalFees.toString(),
      lpFees: r.lpFees.toString(),
      protocolFees: r.protocolFees.toString(),
      longCount: r.longCount,
      shortCount: r.shortCount,
      closeCount: r.closeCount,
      totalPayout: r.totalPayout.toString(),
    })),
  });
});

// ── Protocol-wide metrics ───────────────────────────────────────────────────

app.get("/metrics/protocol", async (c) => {
  const rows = await db
    .select()
    .from(protocolMetrics)
    .where(eq(protocolMetrics.id, "global"))
    .limit(1);

  if (rows.length === 0) {
    return c.json({
      totalPositionVolume: "0",
      totalFees: "0",
      totalLpFees: "0",
      totalProtocolFees: "0",
      totalPositions: 0,
      totalCloses: 0,
      totalPayout: "0",
      poolCount: 0,
    });
  }

  const r = rows[0];
  return c.json({
    totalPositionVolume: r.totalPositionVolume.toString(),
    totalFees: r.totalFees.toString(),
    totalLpFees: r.totalLpFees.toString(),
    totalProtocolFees: r.totalProtocolFees.toString(),
    totalPositions: r.totalPositions,
    totalCloses: r.totalCloses,
    totalPayout: r.totalPayout.toString(),
    poolCount: r.poolCount,
  });
});

// ── User stats (aggregate) ──────────────────────────────────────────────────

app.get("/metrics/users", async (c) => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const thirtyDaysAgo = now - 30n * 86400n;
  const sevenDaysAgo = now - 7n * 86400n;

  // Aggregated in SQL rather than by loading every row: this used to
  // `select().from(userActivity)` and reduce in JS, which is an O(users)
  // memory spike on every request just to produce six numbers.
  //
  // The sums are numeric(78) — wider than float8 — so they come back as
  // strings and stay exact; `count` returns bigint. Empty table yields NULL,
  // hence the coalesce.
  const [row] = await db
    .select({
      totalUsers: sql<string>`count(*)`,
      active30d: sql<string>`count(*) filter (where ${userActivity.lastSeen} >= ${thirtyDaysAgo})`,
      active7d: sql<string>`count(*) filter (where ${userActivity.lastSeen} >= ${sevenDaysAgo})`,
      totalVolume: sql<string>`coalesce(sum(${userActivity.totalVolume}), 0)`,
      totalFeesPaid: sql<string>`coalesce(sum(${userActivity.totalFeesPaid}), 0)`,
      totalPayout: sql<string>`coalesce(sum(${userActivity.totalPayout}), 0)`,
    })
    .from(userActivity);

  return c.json({
    totalUsers: Number(row?.totalUsers ?? 0),
    activeUsers30d: Number(row?.active30d ?? 0),
    activeUsers7d: Number(row?.active7d ?? 0),
    totalUserVolume: String(row?.totalVolume ?? "0"),
    totalUserFeesPaid: String(row?.totalFeesPaid ?? "0"),
    totalUserPayout: String(row?.totalPayout ?? "0"),
  });
});

// ── Single user stats ───────────────────────────────────────────────────────

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
    longCount: r.longCount,
    shortCount: r.shortCount,
    closeCount: r.closeCount,
    totalVolume: r.totalVolume.toString(),
    totalFeesPaid: r.totalFeesPaid.toString(),
    totalPayout: r.totalPayout.toString(),
  });
});

// ── Daily metrics (per pool) ────────────────────────────────────────────────

app.get("/metrics/daily/:pool", async (c) => {
  const pool = c.req.param("pool")?.toLowerCase() as `0x${string}`;
  const days = Math.min(Number(c.req.query("days") ?? 30), 365);

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
      positions: r.positionCount,
      closes: r.closeCount,
      users: r.uniqueUsers,
    })),
  });
});

// ── Daily metrics (global) ──────────────────────────────────────────────────

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
      positions: r.positionCount,
      closes: r.closeCount,
      users: r.uniqueUsers,
    })),
  });
});

// ── LP APR ──────────────────────────────────────────────────────────────────

app.get("/metrics/apr/:pool", async (c) => {
  const pool = c.req.param("pool")?.toLowerCase() as `0x${string}`;
  const now = BigInt(Math.floor(Date.now() / 1000));

  const periods = [
    { name: "1d", seconds: 86400n, days: 1 },
    { name: "7d", seconds: 7n * 86400n, days: 7 },
    { name: "30d", seconds: 30n * 86400n, days: 30 },
  ] as const;

  const apr: Record<string, any> = {};

  for (const p of periods) {
    const since = now - p.seconds;
    const sinceDay = (since / 86400n) * 86400n;

    const dailyRows = await db
      .select()
      .from(dailyMetrics)
      .where(
        and(eq(dailyMetrics.pool, pool), gte(dailyMetrics.dayTimestamp, sinceDay)),
      );

    const feeRevenue = dailyRows.reduce((sum, r) => sum + r.lpFees, 0n);

    const snapshots = await db
      .select({
        backedAirToken: priceSnapshot.backedAirToken,
        backedAirUsd: priceSnapshot.backedAirUsd,
        spotPrice: priceSnapshot.spotPrice,
      })
      .from(priceSnapshot)
      .where(
        and(eq(priceSnapshot.pool, pool), gte(priceSnapshot.timestamp, since)),
      );

    let tvlSum = 0n;
    for (const s of snapshots) {
      const tokenValue = (s.backedAirToken * s.spotPrice) / 10n ** 18n;
      tvlSum += tokenValue + s.backedAirUsd;
    }

    const snapshotCount = snapshots.length;
    const feeRevenueUsd = Number(feeRevenue) / 1e6;
    const tvlAvgUsd =
      snapshotCount > 0 ? Number(tvlSum / BigInt(snapshotCount)) / 1e6 : 0;

    const aprPct =
      tvlAvgUsd > 0 ? (feeRevenueUsd / tvlAvgUsd) * (365 / p.days) * 100 : 0;

    apr[p.name] = {
      feeRevenue: feeRevenue.toString(),
      tvlAvg: snapshotCount > 0 ? (tvlSum / BigInt(snapshotCount)).toString() : "0",
      apr: Math.round(aprPct * 100) / 100,
      snapshotCount,
    };
  }

  return c.json({ pool, ...apr });
});

// ── Status ──────────────────────────────────────────────────────────────────

app.get("/api-status", (c) => c.json({ status: "ok", chainId: INDEXED_CHAIN_ID }));

export default app;
