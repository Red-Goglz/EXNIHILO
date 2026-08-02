/**
 * OpenOcean — first fallback.
 *
 * Keyless. Note the API takes `amount` in WHOLE token units, not wei, which is
 * unusual and lossy for tokens with many decimals: we format the raw amount
 * down to a decimal string and accept the rounding. That is fine for a
 * fallback whose job is to keep the scan alive when KyberSwap rate limits, but
 * it is a reason to keep this second in the chain rather than first.
 *
 * GET https://open-api.openocean.finance/v3/avax/quote
 *   ?inTokenAddress&outTokenAddress&amount&gasPrice
 * → { code: 200, data: { outAmount, estimatedGas, path: {...} } }
 */

import { formatUnits } from "viem";
import { fetchJson, type Quote, type QuoteProvider, type QuoteRequest } from "./types.ts";

const BASE = "https://open-api.openocean.finance/v3/avax/quote";

export const openocean: QuoteProvider = {
  name: "openocean",

  async quote(req: QuoteRequest): Promise<Quote | null> {
    // Whole-unit amount, trimmed of a trailing "." artifact for integers.
    const amount = formatUnits(req.amountIn, req.decimalsIn);

    const url =
      `${BASE}?inTokenAddress=${req.tokenIn}&outTokenAddress=${req.tokenOut}` +
      `&amount=${amount}&gasPrice=25&slippage=1`;

    const json = await fetchJson(url);
    if (!json || json.code !== 200 || !json.data?.outAmount) return null;

    const outAmount = String(json.data.outAmount);
    if (outAmount === "0") return null;

    const dexes: string[] = [];
    for (const r of json.data.path?.routes ?? []) {
      for (const sub of r.subRoutes ?? []) {
        for (const d of sub.dexes ?? []) if (d?.dexCode) dexes.push(d.dexCode);
      }
    }

    return {
      amountOut: BigInt(outAmount),
      provider: "openocean",
      route: [...new Set(dexes)].join(" → ") || "unknown",
      gasEstimate: json.data.estimatedGas ? BigInt(json.data.estimatedGas) : undefined,
    };
  },
};
