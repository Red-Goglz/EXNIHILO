/**
 * Bigint formatting helpers for the EXNIHILO dApp.
 */

/**
 * Format a raw USDC bigint (6 decimals) to a USD dollar string.
 * e.g. 1_500_000n → "$1.50"
 */
export function formatUsdc(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const frac = raw % 1_000_000n;
  const fracStr = frac.toString().padStart(6, "0").slice(0, 2);
  return `$${whole.toLocaleString()}.${fracStr}`;
}

/**
 * Format a raw USDC bigint (6 decimals) as a compact dollar string with no
 * fractional part. Uses K/M suffixes for thousands/millions.
 * e.g. 2_000_000n → "$2" · 1_500_000_000n → "$1.5K" · 2_300_000_000_000n → "$2.3M"
 */
export function formatUsdcCompact(raw: bigint): string {
  const dollars = Number(raw) / 1_000_000;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (dollars >= 1_000)     return `$${(dollars / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `$${Math.round(dollars)}`;
}

/**
 * Format a raw token amount with the given decimal places.
 * e.g. formatToken(1_500_000_000_000_000_000n, 18) → "1.50"
 */
export function formatToken(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const frac = raw % scale;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, 4);
  return `${whole.toLocaleString()}.${fracStr}`;
}

/**
 * Format the pool's spotPrice return value to a USD/token string.
 *
 * The pool's spotPrice() returns: (backedAirUsd * 1e18) / backedAirToken
 *
 * For an 18-decimal token and 6-decimal USDC, the raw value is
 * denominated in USDC units scaled by 1e12 (= 1e18 / 1e6).
 * Divide by 1e12 to get the USD price per token.
 *
 * For tokens with non-18 decimals, pass tokenDecimals so the
 * adjustment is applied correctly.
 *
 * @param raw           Return value of pool.spotPrice()
 * @param tokenDecimals Decimals of the token (usually 18)
 */
export function decodeSpotPrice(raw: bigint, tokenDecimals = 18): string {
  // spotPrice = (backedAirUsd * 1e18) / backedAirToken
  // backedAirUsd is 6-dec, backedAirToken is tokenDecimals-dec
  // To get USD per whole token:
  //   price = spotPrice / 10^(18 - tokenDecimals + 12)
  //         = spotPrice / 10^(30 - tokenDecimals)   for 6-dec USDC
  const shift = 18 - tokenDecimals;
  const divisor = 10n ** BigInt(shift);
  const wholeCents = raw / divisor; // in USDC units (6 dec)
  return formatUsdc(wholeCents);
}

/**
 * Parse a decimal string input into a bigint with the given number of decimals.
 * e.g. parseUnits("1.5", 6) → 1_500_000n
 * Returns 0n for invalid input.
 */
export function parseUnits(value: string, decimals: number): bigint {
  if (!value || value.trim() === "") return 0n;
  const [whole, frac = ""] = value.split(".");
  const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
  try {
    return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
  } catch {
    return 0n;
  }
}
