/**
 * Protocol constants mirrored from the contracts.
 *
 * These are `constant` in Solidity, not storage, so they cannot be read from a
 * pool at runtime. They are duplicated here for display and estimation only —
 * anything that decides a transaction must quote the pool itself (see
 * `quoteOpenFee`, `quoteRenewFee`, `effectiveLeverageCap`), because the pool is
 * the single source of truth and this file can drift.
 */

export const BPS_DENOM = 10_000n;

// ── Position fees ────────────────────────────────────────────────────────────

/** LP's share of the base open/renew fee: 4 % of notional. */
export const LP_FEE_BPS = 400n;

/** Protocol's share of the base open/renew fee: 1 % of notional. */
export const PROTOCOL_FEE_BPS = 100n;

/** Base fee charged on every open and renewal: 5 % of notional. */
export const BASE_FEE_BPS = LP_FEE_BPS + PROTOCOL_FEE_BPS;

/** Floor on the base fee, in USDC (6 dec). Applies when 5 % would be less. */
export const MIN_POSITION_FEE = 50_000n; // 0.05 USDC

/** Protocol's cut of profit on a close: 1 % of surplus. */
export const CLOSE_FEE_BPS = 100n;

/** Impact fee scaling rate. Whole fee accrues to the LP. */
export const IMPACT_FEE_BPS = 1_500n;

// ── Position size cap ────────────────────────────────────────────────────────

/** Cap on a single position at market creation: 1 % of backedAirUsd. */
export const CAP_START_BPS = 100n;

/** Cap ceiling, reached after CAP_RAMP_SECONDS: 20 % of backedAirUsd. */
export const CAP_MAX_BPS = 2_000n;

/** Seconds over which the cap ramps from CAP_START_BPS to CAP_MAX_BPS. */
export const CAP_RAMP_SECONDS = 86_400n; // 24 hours

// ── Settlement guard ─────────────────────────────────────────────────────────

/** A swap moving at least this share of backedAirUsd arms the guard. */
export const SETTLE_GUARD_BPS = 100n;

/** Blocks a third party must wait before settling someone else's position. */
export const SETTLE_GUARD_BLOCKS = 5n;

// ── PreMarket ────────────────────────────────────────────────────────────────

/**
 * Integrator's share of the pool's LP fee stream, set on the vault at buyout.
 * The pool routes 4 % of notional to the LP side, so half of that is 2 % of
 * notional each to the integrator and the LP owner.
 */
export const INTEGRATOR_SHARE_BPS = 5_000n;

/** Recommended Dutch decay for a premarket auction: 2 % of start per minute. */
export const DEFAULT_DECAY_BPS_PER_MINUTE = 200n;

/**
 * Recommended markup on the launchpad's honest spot quote when seeding a
 * premarket. Overestimating costs ~30 s per 1 % at the default decay;
 * underestimating gets the reserve sniped at that number with no band to absorb
 * it, so the asymmetry is deliberate.
 */
export const DEFAULT_START_PRICE_MARKUP_BPS = 100n; // +1 %

// ── Position duration ────────────────────────────────────────────────────────

/**
 * Position lifetime steps with market age. Like the size cap it is automatic —
 * there is no parameter and no setter.
 *
 *   age < 1h   →  1 hour
 *   age < 8h   →  8 hours
 *   age < 24h  →  24 hours
 *   age < 7d   →  7 days
 *   age >= 7d  →  30 days  (the ceiling)
 *
 * Non-decreasing by construction, which is what lets closePool guarantee every
 * outstanding position has expired by its closeDate.
 */
export const DURATION_STEPS: readonly { maxAge: bigint; duration: bigint }[] = [
  { maxAge: 3_600n,   duration: 3_600n },   // < 1h   → 1h
  { maxAge: 28_800n,  duration: 28_800n },  // < 8h   → 8h
  { maxAge: 86_400n,  duration: 86_400n },  // < 24h  → 24h
  { maxAge: 604_800n, duration: 604_800n }, // < 7d   → 7d
];

/** Ceiling reached once a market is a week old. */
export const DURATION_MAX = 2_592_000n; // 30 days
