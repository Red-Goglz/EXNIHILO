/**
 * LI.FI — second fallback.
 *
 * Keyless for modest volume. It is a bridge aggregator, so we pin fromChain
 * and toChain to the same id to keep it on a single-chain swap route. It
 * requires a `fromAddress`; since nothing is ever executed here, a burn
 * address is sufficient for a quote.
 *
 * GET https://li.quest/v1/quote
 *   ?fromChain&toChain&fromToken&toToken&fromAmount&fromAddress
 * → { estimate: { toAmount, gasCosts: [...] }, toolDetails: { name } }
 */

import { CONFIG } from "../config.ts";
import { fetchJson, type Quote, type QuoteProvider, type QuoteRequest } from "./types.ts";

const BASE = "https://li.quest/v1/quote";
const QUOTE_ONLY_ADDRESS = "0x000000000000000000000000000000000000dEaD";

export const lifi: QuoteProvider = {
  name: "lifi",

  async quote(req: QuoteRequest): Promise<Quote | null> {
    const url =
      `${BASE}?fromChain=${CONFIG.chainId}&toChain=${CONFIG.chainId}` +
      `&fromToken=${req.tokenIn}&toToken=${req.tokenOut}` +
      `&fromAmount=${req.amountIn.toString()}&fromAddress=${QUOTE_ONLY_ADDRESS}` +
      `&slippage=0.01`;

    const json = await fetchJson(url);
    const toAmount = json?.estimate?.toAmount;
    if (!toAmount || toAmount === "0") return null;

    const gas = json.estimate?.gasCosts?.[0]?.estimate;

    return {
      amountOut: BigInt(toAmount),
      provider: "lifi",
      route: json.toolDetails?.name ?? json.tool ?? "unknown",
      gasEstimate: gas ? BigInt(gas) : undefined,
    };
  },
};
