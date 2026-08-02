/**
 * Quote router: failover across providers, global rate limiting, and a
 * negative cache for tokens that simply have no external market.
 *
 * The negative cache matters more than it looks. EXNIHILO markets are
 * permissionless, so a live deployment will accumulate pools over tokens that
 * never trade anywhere else — test tokens, dead memecoins, tokens whose only
 * liquidity IS the EXNIHILO pool. Without the cache, every one of those burns
 * three aggregator round trips on every cycle, forever, and starves the pools
 * that actually matter.
 */

import type { Address } from "viem";
import { CONFIG } from "../config.ts";
import { pLimit, sleep } from "../util.ts";
import { kyberswap } from "./kyberswap.ts";
import { openocean } from "./openocean.ts";
import { lifi } from "./lifi.ts";
import type { Quote, QuoteProvider, QuoteRequest } from "./types.ts";

export type { Quote, QuoteRequest } from "./types.ts";

const REGISTRY: Record<string, QuoteProvider> = {
  kyberswap,
  openocean,
  lifi,
};

const providers: QuoteProvider[] = CONFIG.quoteProviders
  .map((n) => REGISTRY[n])
  .filter((p): p is QuoteProvider => Boolean(p));

if (providers.length === 0) {
  throw new Error(
    `QUOTE_PROVIDERS matched nothing. Known: ${Object.keys(REGISTRY).join(", ")}`,
  );
}

const limit = pLimit(CONFIG.quoteConcurrency);

/** token → timestamp after which we are willing to re-probe for a route. */
const noRoute = new Map<Address, number>();

export function hasNoKnownRoute(token: Address): boolean {
  const until = noRoute.get(token);
  if (until === undefined) return false;
  if (Date.now() > until) {
    noRoute.delete(token);
    return false;
  }
  return true;
}

function markNoRoute(token: Address) {
  noRoute.set(token, Date.now() + CONFIG.noRouteTtlMs);
}

/**
 * Best executable output for `amountIn`, trying each provider in order.
 *
 * `nonUsdcToken` is the side of the pair that might not be routable — used to
 * key the negative cache, since USDC is always routable.
 */
export async function getQuote(
  req: QuoteRequest,
  nonUsdcToken: Address,
): Promise<Quote | null> {
  if (hasNoKnownRoute(nonUsdcToken)) return null;

  return limit(async () => {
    for (const provider of providers) {
      const q = await provider.quote(req);
      if (CONFIG.quoteDelayMs > 0) await sleep(CONFIG.quoteDelayMs);
      if (q && q.amountOut > 0n) return q;
    }
    // Every provider declined. Either the token has no liquidity anywhere, or
    // all three are down at once; the TTL makes both cases self-healing.
    markNoRoute(nonUsdcToken);
    return null;
  });
}

export const providerNames = providers.map((p) => p.name);
