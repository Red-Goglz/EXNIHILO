/** Small helpers shared across the bot. No dependencies beyond viem's formatters. */

import { formatUnits } from "viem";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Minimal concurrency limiter. The aggregator APIs are keyless and will rate
 * limit a burst, so every outbound quote goes through one of these.
 */
export function pLimit(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    active--;
    queue.shift()?.();
  };

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(next);
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
  };
}

/** Retry with exponential backoff. Returns null instead of throwing when exhausted. */
export async function retry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 250,
): Promise<T | null> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(baseDelayMs * 2 ** i);
    }
  }
  if (process.env.DEBUG) console.error("retry exhausted:", lastErr);
  return null;
}

/** Format a token amount with a fixed number of decimal places. */
export function fmt(amount: bigint, decimals: number, places = 4): string {
  const s = formatUnits(amount, decimals);
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

/** Format a 6-decimal USDC amount as "$1,234.56". Handles negatives. */
export function usd(amount: bigint, places = 2): string {
  const n = Number(formatUnits(amount, 6));
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  })}`;
}

export function bps(value: number, places = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(places)} bps`;
}

export function pct(value: number, places = 2): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(places)}%`;
}

export const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

export function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
