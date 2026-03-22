import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "ponder:api";
import { priceSnapshot } from "ponder:schema";
import { eq, desc } from "ponder";

const app = new Hono();

// Allow cross-origin requests from the site
app.use("/*", cors());

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

  // Return oldest-first for charting
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

// ── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

export default app;
