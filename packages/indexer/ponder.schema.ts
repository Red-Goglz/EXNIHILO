import { onchainTable, index } from "ponder";

// Secondary indexes below mirror the exact filter+sort of each API route.
// Primary keys cover every `db.find()` in the handlers; everything the HTTP
// layer does filters on non-key columns, which without these is a sequential
// scan of the whole table.

// ── Individual positions ────────────────────────────────────────────────────

export const position = onchainTable("position", (t) => ({
  nftId: t.bigint().primaryKey(),
  pool: t.hex().notNull(),
  holder: t.hex().notNull(),
  isLong: t.boolean().notNull(),
  lockedAmount: t.bigint().notNull(),
  usdcIn: t.bigint().notNull(),
  airUsdMinted: t.bigint().notNull(),
  airTokenMinted: t.bigint().notNull(),
  feesPaid: t.bigint().notNull(),
  openedAt: t.bigint().notNull(),
  deadline: t.bigint().notNull(),
  status: t.text().notNull(),             // "open" | "closed" | "expired"
  payout: t.bigint().notNull(),           // 0 while open
  closedAt: t.bigint().notNull(),         // 0 while open
}), (t) => ({
  // GET /positions/:pool        — where(pool[, status]) order by openedAt desc
  poolOpenedIdx: index().on(t.pool, t.openedAt),
  // GET /positions/user/:address — where(holder[, status]) order by openedAt desc
  holderOpenedIdx: index().on(t.holder, t.openedAt),
}));

// ── LP ownership ────────────────────────────────────────────────────────────

export const lpOwnership = onchainTable("lp_ownership", (t) => ({
  nftId: t.bigint().primaryKey(),
  pool: t.hex().notNull(),
  owner: t.hex().notNull(),
}));

// ── Price snapshots ─────────────────────────────────────────────────────────

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
}), (t) => ({
  // GET /prices/:pool     — where(pool) order by timestamp desc
  // GET /metrics/apr/:pool — where(pool AND timestamp >= since)
  // The hottest query in the API: the chart polls it every 15s per pool.
  poolTimestampIdx: index().on(t.pool, t.timestamp),
}));

// ── Pool metrics ────────────────────────────────────────────────────────────

// Fee fields hold the pool's LIFETIME accrual read straight off the contract
// (accumulated + already-paid-out), not a running sum of per-event estimates.
// The pool routes impact fees entirely to LPs and takes a close fee on surplus,
// so the LP/protocol ratio is not a fixed 3:2 and cannot be derived from bps.
export const poolMetrics = onchainTable("pool_metrics", (t) => ({
  address: t.hex().primaryKey(),
  positionVolume: t.bigint().notNull(),
  totalFees: t.bigint().notNull(),
  lpFees: t.bigint().notNull(),
  protocolFees: t.bigint().notNull(),
  longCount: t.integer().notNull(),
  shortCount: t.integer().notNull(),
  closeCount: t.integer().notNull(),
  totalPayout: t.bigint().notNull(),
  lastUpdated: t.bigint().notNull(),
}));

// ── Protocol-wide totals ────────────────────────────────────────────────────

export const protocolMetrics = onchainTable("protocol_metrics", (t) => ({
  id: t.text().primaryKey(),              // always "global"
  totalPositionVolume: t.bigint().notNull(),
  totalFees: t.bigint().notNull(),
  totalLpFees: t.bigint().notNull(),
  totalProtocolFees: t.bigint().notNull(),
  totalPositions: t.integer().notNull(),
  totalCloses: t.integer().notNull(),
  totalPayout: t.bigint().notNull(),
  poolCount: t.integer().notNull(),
  lastUpdated: t.bigint().notNull(),
}));

// ── User activity ───────────────────────────────────────────────────────────

export const userActivity = onchainTable("user_activity", (t) => ({
  address: t.hex().primaryKey(),
  firstSeen: t.bigint().notNull(),
  lastSeen: t.bigint().notNull(),
  longCount: t.integer().notNull(),
  shortCount: t.integer().notNull(),
  closeCount: t.integer().notNull(),
  totalVolume: t.bigint().notNull(),
  totalFeesPaid: t.bigint().notNull(),
  totalPayout: t.bigint().notNull(),
}), (t) => ({
  // GET /metrics/users — counts active users by lastSeen cutoff
  lastSeenIdx: index().on(t.lastSeen),
}));

// ── Daily snapshots ─────────────────────────────────────────────────────────

export const dailyMetrics = onchainTable("daily_metrics", (t) => ({
  id: t.text().primaryKey(),              // "{pool}-{dayTimestamp}" or "global-{dayTimestamp}"
  pool: t.hex().notNull(),                // "0x0" for global
  dayTimestamp: t.bigint().notNull(),
  volume: t.bigint().notNull(),
  fees: t.bigint().notNull(),
  lpFees: t.bigint().notNull(),
  positionCount: t.integer().notNull(),
  closeCount: t.integer().notNull(),
  uniqueUsers: t.integer().notNull(),     // distinct addresses — see dailyUser
}), (t) => ({
  // GET /metrics/daily[/:pool] — where(pool) order by dayTimestamp desc
  // GET /metrics/apr/:pool     — where(pool AND dayTimestamp >= sinceDay)
  poolDayIdx: index().on(t.pool, t.dayTimestamp),
}));

// ── Daily distinct-user set ─────────────────────────────────────────────────
// One row per (scope, day, user). Existence of a row is what makes
// dailyMetrics.uniqueUsers a real distinct count instead of an event count.

export const dailyUser = onchainTable("daily_user", (t) => ({
  id: t.text().primaryKey(),              // "{scope}-{day}-{user}"
  scope: t.text().notNull(),              // pool address, or "global"
  day: t.bigint().notNull(),
  user: t.hex().notNull(),
}));
