/**
 * The external-price abstraction.
 *
 * ── Why an aggregator and not a single DEX ─────────────────────────────────
 * An EXNIHILO market can be created for ANY ERC-20, permissionlessly. The bot
 * cannot assume the underlying trades on Trader Joe, or on Pangolin, or in a
 * WAVAX pair, or that a direct USDC pair exists at all. Hard-coding a venue
 * means hard-coding which markets are arbable.
 *
 * A meta-DEX aggregator solves exactly that: you hand it (tokenIn, tokenOut,
 * amountIn) and it searches every Avalanche venue — Trader Joe / LFJ liquidity
 * book, Pangolin, Uniswap V3, Pharaoh, GMX, Curve, plus multi-hop paths
 * through WAVAX or USDT — and returns the best executable output.
 *
 * ── Quote for size, never a spot price ─────────────────────────────────────
 * Every provider here is asked for the output of a CONCRETE amountIn. That is
 * the whole point. A spot/mid price (from a pair's reserves, a subgraph, or a
 * price API like CoinGecko) tells you a gap exists but not whether it survives
 * the price impact of capturing it — and on a thin token the impact is the
 * entire trade. Quoting the real size folds routing, fees, and slippage into
 * one number, and the same call later returns the calldata to execute with.
 *
 * ── Trust boundary ─────────────────────────────────────────────────────────
 * These are off-chain HTTP endpoints and their answers are advisory. They are
 * good enough to DETECT an opportunity. Before ever sending a transaction, the
 * execution leg must be simulated on-chain (eth_call / a fork) against the same
 * block, because the quote can be stale, optimistic, or simply wrong.
 */

import type { Address } from "viem";

export interface QuoteRequest {
  tokenIn: Address;
  tokenOut: Address;
  /** Raw amount in tokenIn's own decimals. */
  amountIn: bigint;
  decimalsIn: number;
  decimalsOut: number;
}

export interface Quote {
  /** Raw expected output in tokenOut's decimals, before our slippage haircut. */
  amountOut: bigint;
  /** Which provider answered. */
  provider: string;
  /** Human-readable venue/route summary, e.g. "pharaoh-lb → traderjoe-v2". */
  route: string;
  /** Provider's gas estimate for the swap leg, when it supplies one. */
  gasEstimate?: bigint;
}

export interface QuoteProvider {
  name: string;
  quote(req: QuoteRequest): Promise<Quote | null>;
}

/** Shared fetch with timeout. Returns null on any non-2xx or network error. */
export async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 12_000,
): Promise<any | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
