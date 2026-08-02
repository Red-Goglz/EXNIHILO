/**
 * KyberSwap Aggregator — primary quote source.
 *
 * Keyless, generous rate limits, covers every meaningful Avalanche venue, and
 * returns a per-hop route breakdown that is genuinely useful in the report.
 * The `/routes` response also carries the `routeSummary` that `/route/build`
 * turns into executable calldata, so the execution leg is a follow-up call on
 * the same object rather than a different integration.
 *
 * GET https://aggregator-api.kyberswap.com/avalanche/api/v1/routes
 *   ?tokenIn&tokenOut&amountIn
 * → { code: 0, data: { routeSummary: { amountOut, gas, route: [[hop…]] } } }
 */

import { CONFIG } from "../config.ts";
import { fetchJson, type Quote, type QuoteProvider, type QuoteRequest } from "./types.ts";

const BASE = "https://aggregator-api.kyberswap.com/avalanche/api/v1/routes";

export const kyberswap: QuoteProvider = {
  name: "kyberswap",

  async quote(req: QuoteRequest): Promise<Quote | null> {
    const url =
      `${BASE}?tokenIn=${req.tokenIn}&tokenOut=${req.tokenOut}` +
      `&amountIn=${req.amountIn.toString()}&gasInclude=true`;

    const json = await fetchJson(url, {
      headers: { "x-client-id": CONFIG.kyberswapClientId },
    });

    if (!json || json.code !== 0 || !json.data?.routeSummary) return null;

    const s = json.data.routeSummary;
    if (!s.amountOut || s.amountOut === "0") return null;

    // route is hop-major: Array<Array<{ exchange }>>. Flatten to a readable path.
    const venues: string[] = Array.isArray(s.route)
      ? [
          ...new Set<string>(
            (s.route.flat() as any[])
              .map((h) => h?.exchange)
              .filter((e): e is string => typeof e === "string"),
          ),
        ]
      : [];

    return {
      amountOut: BigInt(s.amountOut),
      provider: "kyberswap",
      route: venues.join(" → ") || "unknown",
      gasEstimate: s.gas ? BigInt(s.gas) : undefined,
    };
  },
};
