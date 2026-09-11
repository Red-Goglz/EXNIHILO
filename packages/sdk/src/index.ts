/**
 * @exnihilio/sdk — TypeScript client for the EXNIHILO trade protocol.
 *
 * Create one instance and call methods on it:
 *
 *   const exnihilo = createExnihilo({ publicClient, walletClient, addresses });
 *   const market = await exnihilo.getMarket(pool);
 *   await exnihilo.openLong({ pool, notional: 100_000000n });
 *
 * Every function is also exported standalone if you prefer to pass a context
 * explicitly or tree-shake aggressively.
 */

import type { Ctx, ExnihiloConfig } from "./client.js";

import * as markets from "./markets.js";
import * as trade from "./trade.js";
import * as positions from "./positions.js";
import * as premarket from "./premarket.js";
import * as vault from "./vault.js";
import * as keeper from "./keeper.js";

export * from "./client.js";
export * from "./constants.js";
export * from "./markets.js";
export * from "./trade.js";
export * from "./positions.js";
export * from "./premarket.js";
export * from "./vault.js";
export * from "./keeper.js";

/** Bind `ctx` as the first argument of every function in a module. */
type Bound<T> = {
  [K in keyof T]: T[K] extends (ctx: Ctx, ...rest: infer A) => infer R
    ? (...args: A) => R
    : T[K];
};

function bind<T extends Record<string, unknown>>(mod: T, ctx: Ctx): Bound<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mod)) {
    out[key] =
      typeof value === "function"
        ? (...args: unknown[]) => (value as (...a: unknown[]) => unknown)(ctx, ...args)
        : value;
  }
  return out as Bound<T>;
}

export function createExnihilo(config: ExnihiloConfig) {
  const ctx: Ctx = {
    publicClient: config.publicClient,
    walletClient: config.walletClient,
    addresses: config.addresses,
  };

  return {
    ctx,
    addresses: config.addresses,
    ...bind(markets, ctx),
    ...bind(trade, ctx),
    ...bind(positions, ctx),
    ...bind(premarket, ctx),
    ...bind(vault, ctx),
    ...bind(keeper, ctx),
  };
}

export type Exnihilo = ReturnType<typeof createExnihilo>;
