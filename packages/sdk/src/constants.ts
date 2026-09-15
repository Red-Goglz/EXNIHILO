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
 * A close is priced against the worst of the last CLAMP_BLOCKS block-opens
 * wherever that is less favourable than live, so a holder cannot close at a
 * price they just moved (audit H-2). Quote with `quoteClose`, which applies it.
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

/**
 * Recommended markup on the launchpad's honest spot quote when seeding a
 * premarket. Overestimating costs ~30 s per 1 % at the default decay;
 * underestimating gets the reserve sniped at that number with no band to absorb
 * it, so the asymmetry is deliberate.
 */
export const DEFAULT_START_PRICE_MARKUP_BPS = 100n; // +1 %

// ── Funding ──────────────────────────────────────────────────────────────────

/**
 * The funding window: the period over which one funding charge is levied.
 *
 *   window(age) = min(1 hour + age, 30 days)
 *
 * It opens at an hour and widens by one second per second of market age. A
 * market's first hours are its most volatile — the token has no price history
 * and depth is whatever the creator seeded — so rent starts high and falls as
 * the market earns a history.
 *
 * This replaced a position *lifetime* that stepped through the same range. The
 * shape survived the change; what it governs did not. Positions no longer
 * expire and are never renewed, so there is nothing to buy an extension for:
 * holding is charged continuously by shrinking the position itself — its
 * collateral and debt together — and the window sets how fast.
 */
export const FUNDING_WINDOW_MIN = 3_600n;     // 1 hour
export const FUNDING_WINDOW_MAX = 2_592_000n; // 30 days

/**
 * Funding rate per window, in bps of the position (collateral and debt alike):
 *
 *   ratePerWindow = FUNDING_BASE_BPS + FUNDING_UTIL_BPS * utilization
 *   utilization   = sameSideOpenInterest / backedAirUsd   (capped at 4x)
 *
 * A position is a perpetual option — no liquidation, loss capped at the premium —
 * so it costs more to hold than a perp's funding: ~0.33 % a day at a mature
 * market's 30-day window, many times that on a young market. A side whose open
 * interest equals the pool's depth pays three times the base. Funding takes a
 * share of the whole position, so a winner gives up that share of its profit.
 *
 * Utilization decays with the positions it counts, and the pool integrates that
 * exactly, so a crowded side pays more at first and less as it shrinks.
 *
 * Display only. Quote the pool (`fundingRatePerSecond`) for anything that
 * matters; these exist so a UI can explain where the number comes from.
 */
export const FUNDING_BASE_BPS = 1_000n;       // 10 % per window
export const FUNDING_UTIL_BPS = 2_000n;       // + 20 % x utilization per window
export const FUNDING_UTIL_CAP_BPS = 40_000n;  // utilization capped at 4x

/** Fixed-point base of the funding indices and rates. */
export const RAY = 10n ** 27n;

/**
 * A position becomes sweepable by anyone once funding has taken all but this
 * fraction of the collateral it opened with. At 0.1 % the holder's remaining
 * claim is worth less than the gas to collect it.
 */
export const SWEEP_DUST_BPS = 10n;

/**
 * Wind-down. `closePool` blocks new positions at once and sets
 * `closeDate = now + 7 days`; past that the funding rate doubles every day, up
 * to a 2^16 ceiling. That is the whole of the LP's exit guarantee —
 * positions are never force-closed at a price someone else chose, they are made
 * geometrically more expensive to hold until the holder closes or the
 * collateral decays into sweep range.
 */
export const WIND_DOWN_GRACE = 604_800n;     // 7 days
export const WIND_DOWN_DOUBLING = 86_400n;   // 1 day
export const WIND_DOWN_MAX_SHIFT = 16n;
