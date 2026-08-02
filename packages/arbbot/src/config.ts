/**
 * Single source of truth for every tunable. Everything is env-overridable so
 * the same process can follow the mainnet deployment, a fork, or a testnet
 * without source edits.
 *
 * Defaults mirror the Avalanche C-Chain mainnet addresses in
 * `packages/site/src/contracts/addresses.ts`. Keep them in sync after a redeploy.
 */

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function addr(name: string, fallback: string): `0x${string}` {
  const v = str(name, fallback);
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${name} is not an address: "${v}"`);
  return v as `0x${string}`;
}

function numList(name: string, fallback: string): number[] {
  return str(name, fallback)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}

export const CONFIG = {
  chainId: num("CHAIN_ID", 43114),
  rpcUrl: str("RPC_URL", "https://api.avax.network/ext/bc/C/rpc"),

  factory: addr("FACTORY_ADDRESS", "0xBe6Fb0e7b7d8EFD491FEbC436F737cE8B244F85a"),
  usdc: addr("USDC_ADDRESS", "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"),
  /** Wrapped AVAX — quoted against USDC once per cycle to price gas. */
  wavax: addr("WAVAX_ADDRESS", "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7"),

  pollIntervalMs: num("POLL_INTERVAL_MS", 30_000),
  minEdgeBps: num("MIN_EDGE_BPS", 25),
  // Low by design: live pools are currently seeded with tens of dollars, so a
  // real edge nets cents. Raise this once pools carry meaningful depth.
  minProfitUsdc: num("MIN_PROFIT_USDC", 0.1),
  sizeLadderUsdc: numList("SIZE_LADDER_USDC", "25,50,100,250,500,1000,2500,5000,10000"),
  maxPoolDepthBps: num("MAX_POOL_DEPTH_BPS", 3000),
  refineSteps: num("REFINE_STEPS", 4),

  slippageBps: num("SLIPPAGE_BPS", 50),
  gasUnits: BigInt(num("GAS_UNITS", 700_000)),

  quoteProviders: str("QUOTE_PROVIDERS", "kyberswap,openocean,lifi")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  quoteConcurrency: num("QUOTE_CONCURRENCY", 3),
  quoteDelayMs: num("QUOTE_DELAY_MS", 120),
  kyberswapClientId: str("KYBERSWAP_CLIENT_ID", "exnihilo-arbbot"),
  noRouteTtlMs: num("NO_ROUTE_TTL_MIN", 60) * 60_000,

  verbose: bool("VERBOSE", false),
  once: process.argv.includes("--once"),
} as const;

/** USDC is 6 decimals across every EXNIHILO deployment; the pool hard-codes it. */
export const USDC_DECIMALS = 6;
export const BPS_DENOM = 10_000n;
