/**
 * Client-side AMM math helpers.
 * All inputs and outputs are bigint (raw on-chain values).
 * No RPC calls — purely deterministic math matching the on-chain formulas.
 */

const BPS_DENOM = 10_000n;

/**
 * SWAP-1 constant-product output, net of fee.
 *
 * Matches the contract exactly:
 *   rawOut = amountIn * reserveOut / (reserveIn + amountIn)
 *   fee    = amountIn * reserveOut * feeBps / (reserveIn * 10_000)   ← spot-value fee
 *   net    = rawOut - fee   (0 if rawOut ≤ fee)
 *
 * For 1% fee, trades larger than 99× reserveIn will return 0.
 * Returns 0n if either reserve is 0.
 */
export function cpAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: bigint
): bigint {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) return 0n;
  const rawOut = (amountIn * reserveOut) / (reserveIn + amountIn);
  const fee = (amountIn * reserveOut * feeBps) / (reserveIn * BPS_DENOM);
  if (rawOut <= fee) return 0n;
  return rawOut - fee;
}

/**
 * Preview airToken out for an openLong (SWAP-2).
 *
 * SWAP-2:  reserveIn  = airUsd.totalSupply()
 *          reserveOut = backedAirToken
 *
 * The pool mints `usdcAmount` synthetic airUsd (increasing totalSupply by
 * usdcAmount) before the swap, so we add it to totalSupply here.
 *
 * Returns net airToken out (after fee).
 */
export function quoteLong(
  usdcAmount: bigint,
  airUsdTotalSupply: bigint,
  backedAirToken: bigint,
  feeBps: bigint
): bigint {
  const reserveIn = airUsdTotalSupply + usdcAmount;
  return cpAmountOut(usdcAmount, reserveIn, backedAirToken, feeBps);
}

/**
 * Preview airUsd out for an openShort (SWAP-3).
 *
 * The pool first mints synthetic airToken proportional to the notional:
 *   airTokenMinted = (usdcNotional * airTokenTotalSupply) / backedAirUsd
 *
 * Then SWAP-3 trades airTokenMinted into the pool:
 *   reserveIn  = airTokenTotalSupply + airTokenMinted  (post-mint supply)
 *   reserveOut = backedAirUsd
 *   amountIn   = airTokenMinted
 *
 * Returns net airUsd out (after fee).
 */
export function quoteShort(
  usdcNotional: bigint,
  airTokenTotalSupply: bigint,
  backedAirUsd: bigint,
  feeBps: bigint
): bigint {
  if (airTokenTotalSupply === 0n || backedAirUsd === 0n) return 0n;
  const airTokenMinted = (usdcNotional * airTokenTotalSupply) / backedAirUsd;
  if (airTokenMinted === 0n) return 0n;
  const reserveIn = airTokenTotalSupply + airTokenMinted;
  return cpAmountOut(airTokenMinted, reserveIn, backedAirUsd, feeBps);
}
