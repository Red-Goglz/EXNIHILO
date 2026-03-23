import { onchainTable } from "ponder";

// ── Price snapshots ──────────────────────────────────────────────────────────

export const priceSnapshot = onchainTable("price_snapshot", (t) => ({
  id: t.text().primaryKey(),
  pool: t.hex().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
  backedAirToken: t.bigint().notNull(),
  backedAirUsd: t.bigint().notNull(),
  spotPrice: t.bigint().notNull(),
  longPrice: t.bigint().notNull(),
  shortPrice: t.bigint().notNull(),
  eventType: t.text().notNull(),
}));

// ── Pool metrics ─────────────────────────────────────────────────────────────

export const poolMetrics = onchainTable("pool_metrics", (t) => ({
  address: t.hex().primaryKey(),
  // Volume (USDC, 6 decimals)
  swapVolume: t.bigint().notNull(),         // total swap volume
  positionVolume: t.bigint().notNull(),     // total open long/short volume
  // Fees (USDC, 6 decimals)
  totalFees: t.bigint().notNull(),          // total position fees (5%)
  lpFees: t.bigint().notNull(),             // 3% of notional → LP
  protocolFees: t.bigint().notNull(),       // 2% of notional → treasury
  // Counts
  swapCount: t.integer().notNull(),
  longCount: t.integer().notNull(),
  shortCount: t.integer().notNull(),
  closeCount: t.integer().notNull(),
  // Timestamps
  lastUpdated: t.bigint().notNull(),
}));

// ── Protocol-wide totals ─────────────────────────────────────────────────────

export const protocolMetrics = onchainTable("protocol_metrics", (t) => ({
  id: t.text().primaryKey(),                // always "global"
  totalSwapVolume: t.bigint().notNull(),
  totalPositionVolume: t.bigint().notNull(),
  totalFees: t.bigint().notNull(),
  totalLpFees: t.bigint().notNull(),
  totalProtocolFees: t.bigint().notNull(),
  totalSwaps: t.integer().notNull(),
  totalPositions: t.integer().notNull(),
  totalCloses: t.integer().notNull(),
  poolCount: t.integer().notNull(),
  lastUpdated: t.bigint().notNull(),
}));

// ── User activity ────────────────────────────────────────────────────────────

export const userActivity = onchainTable("user_activity", (t) => ({
  address: t.hex().primaryKey(),
  firstSeen: t.bigint().notNull(),          // timestamp of first interaction
  lastSeen: t.bigint().notNull(),           // timestamp of last interaction
  swapCount: t.integer().notNull(),
  longCount: t.integer().notNull(),
  shortCount: t.integer().notNull(),
  totalVolume: t.bigint().notNull(),        // total USDC volume
  totalFeesPaid: t.bigint().notNull(),      // total fees paid
}));

// ── Daily snapshots (for time-series analytics) ──────────────────────────────

export const dailyMetrics = onchainTable("daily_metrics", (t) => ({
  id: t.text().primaryKey(),                // "{pool}-{dayTimestamp}" or "global-{dayTimestamp}"
  pool: t.hex().notNull(),                  // "0x0" for global
  dayTimestamp: t.bigint().notNull(),       // start of day (UTC)
  volume: t.bigint().notNull(),
  fees: t.bigint().notNull(),
  swapCount: t.integer().notNull(),
  positionCount: t.integer().notNull(),
  uniqueUsers: t.integer().notNull(),
}));
