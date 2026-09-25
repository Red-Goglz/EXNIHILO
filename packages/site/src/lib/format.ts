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
  const fracPadded = frac.toString().padStart(6, "0");

  if (whole > 0n || frac >= 10_000n) {
    // >= $0.01 — show 2 decimal places
    return `$${whole.toLocaleString()}.${fracPadded.slice(0, 2)}`;
  }
  // Sub-cent — show all significant digits (up to 6)
  const trimmed = fracPadded.replace(/0+$/, "") || "0";
  return `$0.${trimmed}`;
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

const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";

/**
 * Format a raw USDC price (6 decimals) for display, DEX-style:
 *   ≥ $1        → 2 decimals            ($25.00)
 *   $0.01–$1    → 4 significant digits  ($0.1234)
 *   < $0.01     → subscript-zero count  ($0.0₃42 = 0.00042)
 * Token prices need more resolution than balances — meme-token markets
 * live entirely below one cent.
 */
export function formatPrice(raw: bigint): string {
  if (raw >= 1_000_000n) {
    const whole = raw / 1_000_000n;
    const frac = ((raw % 1_000_000n) / 10_000n).toString().padStart(2, "0");
    return `$${whole.toLocaleString()}.${frac}`;
  }
  const frac = raw.toString().padStart(6, "0"); // 6 fractional digits
  if (raw >= 10_000n) {
    // $0.01–$1: four significant digits
    return `$0.${frac.slice(0, 4)}`;
  }
  // Sub-cent: count leading zeros, subscript them, show 2 significant digits
  const zeros = frac.length - raw.toString().length;
  const sig = raw.toString().slice(0, 2);
  if (raw === 0n) return "$0.00";
  const zeroCount = zeros
    .toString()
    .split("")
    .map((d) => SUBSCRIPTS[Number(d)])
    .join("");
  return `$0.0${zeroCount}${sig}`;
}

/**
 * Compact duration for buttons/labels: 604800 → "7D", 3600 → "1H".
 */
export function formatDuration(sec: bigint | undefined): string {
  if (!sec || sec <= 0n) return "PERIOD";
  const s = Number(sec);
  if (s % 86400 === 0) return `${s / 86400}D`;
  if (s >= 86400) return `${(s / 86400).toFixed(1)}D`;
  return `${Math.round(s / 3600)}H`;
}

/**
 * Format a pool price view (spotPrice / longPrice / shortPrice). The pool
 * already scales by 10^tokenDecimals, so the value is USDC (6 dec) per whole
 * token whatever the token's decimals.
 */
export function decodeSpotPrice(raw: bigint): string {
  return formatPrice(raw);
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

/**
 * Exact inverse of parseUnits: render a raw bigint at full precision, with
 * trailing zeros trimmed. Round-trips losslessly.
 *
 * Unlike formatToken (4 dp) and formatUsdc (2 dp), this loses no information,
 * so it is the only safe formatter for a value that will be written back into
 * an input and re-parsed — e.g. the auto-paired LP amounts, where truncating
 * the display would silently submit an off-ratio deposit.
 */
export function formatExact(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
