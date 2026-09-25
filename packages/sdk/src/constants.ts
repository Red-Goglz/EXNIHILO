/**
 * Protocol constants mirrored from the contracts.
 *
 * These are `constant` in Solidity, not storage, so they cannot be read from a
 * pool at runtime. They are duplicated here for display and estimation only —
 * anything that decides a transaction must quote the pool itself (see
 * `quoteOpenFee`, `fundingRatePerSecond`, `effectiveLeverageCap`), because the pool is
 * the single source of truth and this file can drift.
 */

export const BPS_DENOM = 10_000n;

// ── Position fees ────────────────────────────────────────────────────────────

/** LP's share of the base open fee: 4 % of notional. */
export const LP_FEE_BPS = 400n;

/** Protocol's share of the base open fee: 1 % of notional. */
export const PROTOCOL_FEE_BPS = 100n;

/** Base fee charged on every open: 5 % of notional. */
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

// ── Close-price clamp ────────────────────────────────────────────────────────

/**
 * A close is priced at the worst of live and the last CLAMP_BLOCKS block opens,
 * so a holder cannot close into a price they just moved. `quoteClose` applies
 * it; `quoteCloseUnclamped` tells a held-back close from a real loss.
 */
export const CLAMP_BLOCKS = 5n;

// ── PreMarket ────────────────────────────────────────────────────────────────

/**
 * Integrator's share of the pool's LP fee stream, set on the vault at buyout.
 * The pool routes 4 % of notional to the LP side, so half of that is 2 % of
 * notional each to the integrator and the LP owner.
 */
export const INTEGRATOR_SHARE_BPS = 5_000n;

/** Recommended Dutch decay for a premarket auction: 2 % of start per minute. */
export const DEFAULT_DECAY_BPS_PER_MINUTE = 200n;

/** Markup on the honest spot quote when seeding a premarket; see `planPreMarket`. */
export const DEFAULT_START_PRICE_MARKUP_BPS = 100n; // +1 %

// ── Funding ──────────────────────────────────────────────────────────────────

/**
 * The period one funding charge is levied over: window(age) = min(1 hour + age,
 * 30 days). Short on a young market, so rent starts high and falls with age.
 */
export const FUNDING_WINDOW_MIN = 3_600n;     // 1 hour
export const FUNDING_WINDOW_MAX = 2_592_000n; // 30 days

/**
 * Funding per window, in bps of the position (collateral, debt and notional):
 *
 *   ratePerWindow = FUNDING_BASE_BPS + FUNDING_UTIL_BPS * utilization
 *   utilization   = sameSideOpenInterest / backedAirUsd   (capped at 4x)
 *
 * About 0.33 % a day on a mature market. Display only: quote the pool's
 * `fundingRatePerSecond` for anything that matters.
 */
export const FUNDING_BASE_BPS = 1_000n;       // 10 % per window
export const FUNDING_UTIL_BPS = 2_000n;       // + 20 % x utilization per window
export const FUNDING_UTIL_CAP_BPS = 40_000n;  // utilization capped at 4x

/** Fixed-point base of the funding indices and rates. */
export const RAY = 10n ** 27n;

/** Anyone may sweep a position once funding leaves it this share of its opening collateral (0.1 %). */
export const SWEEP_DUST_BPS = 10n;

/**
 * Wind-down: `closePool` blocks opens and sets `closeDate = now + 7 days`; past
 * that the funding rate doubles every day, up to 2^16. Nothing is force-closed.
 */
export const WIND_DOWN_GRACE = 604_800n;     // 7 days
export const WIND_DOWN_DOUBLING = 86_400n;   // 1 day
export const WIND_DOWN_MAX_SHIFT = 16n;
