/**
 * Fee constants mirrored from EXNIHILOPool.
 *
 * They live in one module because they did not: POSITION_FEE_BPS and
 * PROTOCOL_FEE_BPS were copied into two components, and when the protocol share
 * was reweighted from 200 to 100 bps the change reached neither. Reported
 * protocol revenue was exactly 2x reality until an audit measured it
 * (finding IA-R2-4). One definition cannot drift from itself.
 *
 * Display and analytics only. The authoritative fee for a particular open comes
 * from the pool via quoteOpenFee/useOpenFee — these constants cannot express
 * the MIN_POSITION_FEE floor or the OI-integral impact fee, and must never be
 * used to decide what to send in a transaction.
 */

/** BPS_DENOM. */
export const BPS_DENOM = 10_000n;

/** LP_FEE_BPS (400) + PROTOCOL_FEE_BPS (100) — the base open/renew fee. */
export const POSITION_FEE_BPS = 500n;

/** PROTOCOL_FEE_BPS — the protocol's share of the base fee, 1 % of notional. */
export const PROTOCOL_FEE_BPS = 100n;

/** MIN_POSITION_FEE — 0.05 USDC, 6 dec. */
export const MIN_POSITION_FEE = 50_000n;

/**
 * Protocol revenue booked for opening a position of `notional`.
 *
 * Mirrors EXNIHILOPool._computeFees' protocol leg. It deliberately does not
 * model the MIN_POSITION_FEE floor: below the floor the split is taken out of
 * the floor rather than the notional, and analytics rounding there is not worth
 * a second source of truth that can go stale the way this one did.
 */
export function protocolFeeFor(notional: bigint): bigint {
  return (notional * PROTOCOL_FEE_BPS) / BPS_DENOM;
}
