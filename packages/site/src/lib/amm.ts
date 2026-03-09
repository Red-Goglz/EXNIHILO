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
 * Preview airMeme out for an openLong (SWAP-2).
 *
 * SWAP-2:  reserveIn  = airUsd.totalSupply()
 *          reserveOut = backedAirMeme
 *
 * The pool mints `usdcAmount` synthetic airUsd (increasing totalSupply by
 * usdcAmount) before the swap, so we add it to totalSupply here.
 *
 * Returns net airMeme out (after fee).
 */
export function quoteLong(
  usdcAmount: bigint,
  airUsdTotalSupply: bigint,
  backedAirMeme: bigint,
  feeBps: bigint
): bigint {
  const reserveIn = airUsdTotalSupply + usdcAmount;
  return cpAmountOut(usdcAmount, reserveIn, backedAirMeme, feeBps);
}

/**
 * Preview airUsd out for an openShort (SWAP-3).
 *
 * SWAP-3:  reserveIn  = airMeme.totalSupply()
 *          reserveOut = backedAirUsd
 *
 * The pool mints `usdcNotional` synthetic airMeme before the swap, so we add
 * it to totalSupply here.
 *
 * Returns net airUsd out (after fee).
 */
export function quoteShort(
  usdcNotional: bigint,
  airMemeTotalSupply: bigint,
  backedAirUsd: bigint,
  feeBps: bigint
): bigint {
  const reserveIn = airMemeTotalSupply + usdcNotional;
  return cpAmountOut(usdcNotional, reserveIn, backedAirUsd, feeBps);
}
