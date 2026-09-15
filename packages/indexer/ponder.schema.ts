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
  // Collateral AS AT OPEN. Funding decays every open position on a side by the
  // same factor, so the live figure is
  //   lockedAmountAtOpen * poolMetrics.fundingIndex<Side> / fundingIndexAtOpen
  // and the API computes it on read rather than this table trying to track a
  // number that changes every second with no event to hang an update on.
  lockedAmountAtOpen: t.bigint().notNull(),
  usdcIn: t.bigint().notNull(),
  airUsdMinted: t.bigint().notNull(),
  airTokenMinted: t.bigint().notNull(),
  feesPaid: t.bigint().notNull(),
  openedAt: t.bigint().notNull(),
  // Replaces `deadline`. Positions do not expire; this is the denominator of
  // the decay ratio above, in RAY.
  fundingIndexAtOpen: t.bigint().notNull(),
  status: t.text().notNull(),             // "open" | "closed" | "swept"
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
  // Carried on every snapshot so a chart can show a position's decay against
  // the price history it happened alongside.
  fundingIndexLong: t.bigint().notNull(),
  fundingIndexShort: t.bigint().notNull(),
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
  // Funding is NOT a fee and deliberately absent from the fee columns above: it
  // never becomes claimable, it lands straight in the backed reserves. Reading
  // it out of lpFees would double-count nothing and miss everything, so it is
  // accumulated here from the FundingAccrued event instead — the only record
  // that separates reserve growth caused by funding from reserve growth caused
  // by trading.
  //
  // The two released totals are in DIFFERENT UNITS and must never be summed:
  // the long side releases airToken (token decimals), the short side releases
  // airUsd (6 decimals).
  //
  // Funding shrinks debt with collateral, so each release comes with debt burned
  // — airUsd (6 dec) on the long side, airToken on the short, so again never
  // summed. Released collateral valued at the time, minus the debt cancelled, is
  // a lower bound on what funding was worth to the LP: winners and losers net
  // against each other in an aggregate.
  fundingIndexLong: t.bigint().notNull(),
  fundingIndexShort: t.bigint().notNull(),
  fundingReleasedLong: t.bigint().notNull(),
  fundingReleasedShort: t.bigint().notNull(),
  fundingDebtCancelledLong: t.bigint().notNull(),
  fundingDebtCancelledShort: t.bigint().notNull(),
  fundingRateLong: t.bigint().notNull(),
  fundingRateShort: t.bigint().notNull(),
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
