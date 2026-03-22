import { onchainTable } from "ponder";

// ── Price snapshots — one row per price-moving event per pool ────────────────

export const priceSnapshot = onchainTable("price_snapshot", (t) => ({
  id: t.text().primaryKey(),           // "{pool}-{blockNumber}-{logIndex}"
  pool: t.hex().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
  backedAirToken: t.bigint().notNull(),
  backedAirUsd: t.bigint().notNull(),
  spotPrice: t.bigint().notNull(),     // backedAirUsd * 1e18 / backedAirToken
  longPrice: t.bigint().notNull(),     // airUsd.totalSupply * 1e18 / backedAirToken
  shortPrice: t.bigint().notNull(),    // backedAirUsd * 1e18 / airToken.totalSupply
  eventType: t.text().notNull(),       // "swap" | "longOpened" | "longClosed" | etc.
}));

// ── Pool summary — aggregated stats per pool ─────────────────────────────────

export const poolSummary = onchainTable("pool_summary", (t) => ({
  address: t.hex().primaryKey(),
  eventCount: t.integer().notNull(),
  lastUpdated: t.bigint().notNull(),
}));
