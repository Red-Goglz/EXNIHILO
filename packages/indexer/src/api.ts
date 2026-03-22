// import { ponder } from "ponder:registry";
// import { priceSnapshot } from "ponder:schema";
// import { eq, desc } from "ponder";

// ── REST endpoint for price history ──────────────────────────────────────────
// TODO: Fix API route syntax for Ponder v1
// ponder.get("/prices/:pool", async (c) => {
//   const pool = c.req.param("pool")?.toLowerCase() as `0x${string}`;
//   const limit = Math.min(Number(c.req.query("limit") ?? 500), 1000);
//
//   const rows = await c.db
//     .select()
//     .from(priceSnapshot)
//     .where(eq(priceSnapshot.pool, pool))
//     .orderBy(desc(priceSnapshot.timestamp))
//     .limit(limit);
//
//   // Return oldest-first for charting
//   rows.reverse();
//
//   return c.json({
//     pool,
//     count: rows.length,
//     prices: rows.map((r) => ({
//       timestamp: Number(r.timestamp),
//       spot: r.spotPrice.toString(),
//       long: r.longPrice.toString(),
//       short: r.shortPrice.toString(),
//       event: r.eventType,
//     })),
//   });
// });

// ── Health check ─────────────────────────────────────────────────────────────
// TODO: Fix API route syntax for Ponder v1
// ponder.get("/health", async (c) => {
//   return c.json({ status: "ok" });
// });
