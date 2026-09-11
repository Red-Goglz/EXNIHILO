/**
 * Pool discovery and state loading.
 *
 * ── How pools are found ────────────────────────────────────────────────────
 * The factory IS the registry. `EXNIHILOFactory` pushes every market it
 * creates into `allPools[]` and flags it in `isPool`, so the authoritative
 * list is two calls deep and needs no indexer, no subgraph, and no event
 * replay:
 *
 *     n = factory.allPoolsLength()
 *     [factory.allPools(0) … factory.allPools(n-1)]      ← one multicall
 *
 * We deliberately prefer this over the alternatives:
 *
 *   • `MarketCreated` log replay — equivalent data and it also hands you the
 *     underlying token in the same pass, but it needs a `fromBlock`, chunked
 *     `eth_getLogs` against a rate-limited public RPC, and reorg handling.
 *     Only worth it if you want to react to new markets within one block; see
 *     `watchNewMarkets` below, which subscribes for exactly that.
 *
 *   • The Ponder indexer's `/metrics/pools` — cheapest of all, but it adds a
 *     service dependency and it lags the chain by its sync distance. An arb
 *     bot acting on stale reserves quotes a trade that no longer exists, so
 *     the indexer is a fine accelerator and a poor source of truth. This bot
 *     reads the chain.
 *
 * ── Static vs dynamic state ────────────────────────────────────────────────
 * `underlyingToken`, `tokenDecimals` and `swapFeeBps` are immutable in the
 * pool, and a token's symbol/decimals never change, so both are cached for the
 * process lifetime. Only reserves and the closing flag are refetched, which
 * keeps a steady-state cycle at one multicall regardless of pool count.
 */

import {
  createPublicClient,
  http,
  type PublicClient,
  type Address,
  parseAbi,
} from "viem";
import { avalanche } from "viem/chains";
// Imported by concrete subpath rather than through the package index: the
// index re-exports with bundler-style ".js" specifiers that Vite and Ponder
// rewrite, but plain Node (which runs this bot) resolves literally.
import { exnihiloFactoryAbi } from "@exnihilio/abis/EXNIHILOFactory.ts";
import { exnihiloPoolAbi } from "@exnihilio/abis/EXNIHILOPool.ts";
import { erc20Abi } from "@exnihilio/abis/Erc20.ts";
import { CONFIG } from "./config.ts";
import type { PoolState } from "./exnihilo.ts";

export const client: PublicClient = createPublicClient({
  chain: avalanche,
  transport: http(CONFIG.rpcUrl, { batch: true, retryCount: 3 }),
  // Multicall3 is deployed at the canonical address on Avalanche and is part of
  // viem's chain definition, so per-pool reads collapse into one RPC round trip.
  batch: { multicall: { wait: 20 } },
});

const marketCreatedAbi = parseAbi([
  "event MarketCreated(address indexed pool, address indexed tokenAddress, address indexed creator, uint256 lpNftId)",
]);

/** Immutable facts about a pool and its underlying token. Cached forever. */
export interface PoolStatic {
  pool: Address;
  token: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  swapFeeBps: bigint;
}

/** A pool plus the reserves that price its next swap. */
export interface PoolSnapshot extends PoolStatic, PoolState {
  isClosing: boolean;
}

const staticCache = new Map<Address, PoolStatic>();

/**
 * Heterogeneous multicalls (different ABIs and function names in one batch)
 * push viem's return-type inference past its recursion limit, so batches are
 * submitted untyped and each result is narrowed by hand at the use site.
 */
type MulticallResult = { status: "success"; result: unknown } | { status: "failure" };

async function multicall(contracts: unknown[]): Promise<MulticallResult[]> {
  return (await client.multicall({
    contracts: contracts as never,
    allowFailure: true,
  })) as unknown as MulticallResult[];
}

/** Read the factory registry. Returns every pool address ever created. */
export async function listPools(): Promise<Address[]> {
  const count = (await client.readContract({
    address: CONFIG.factory,
    abi: exnihiloFactoryAbi,
    functionName: "allPoolsLength",
  })) as bigint;

  if (count === 0n) return [];

  const results = await multicall(
    Array.from({ length: Number(count) }, (_, i) => ({
      address: CONFIG.factory,
      abi: exnihiloFactoryAbi,
      functionName: "allPools",
      args: [BigInt(i)],
    })),
  );

  return results
    .filter((r) => r.status === "success")
    .map((r) => (r as { result: unknown }).result as Address);
}

/** Load and cache the immutable half of a pool's data. */
async function loadStatic(pools: Address[]): Promise<Map<Address, PoolStatic>> {
  const missing = pools.filter((p) => !staticCache.has(p));

  if (missing.length > 0) {
    const poolReads = await multicall(
      missing.flatMap((pool) => [
        { address: pool, abi: exnihiloPoolAbi, functionName: "underlyingToken" },
        { address: pool, abi: exnihiloPoolAbi, functionName: "tokenDecimals" },
        { address: pool, abi: exnihiloPoolAbi, functionName: "swapFeeBps" },
      ]),
    );

    // Second pass: token symbols. Split out because the addresses are only
    // known after the first multicall resolves.
    const tokens: (Address | null)[] = missing.map((_, i) => {
      const r = poolReads[i * 3];
      return r.status === "success" ? (r.result as Address) : null;
    });

    const symbolReads = await multicall(
      tokens
        .filter((t): t is Address => t !== null)
        .map((token) => ({ address: token, abi: erc20Abi, functionName: "symbol" })),
    );

    let symIdx = 0;
    missing.forEach((pool, i) => {
      const token = tokens[i];
      const decRes = poolReads[i * 3 + 1];
      const feeRes = poolReads[i * 3 + 2];
      if (!token || decRes.status !== "success" || feeRes.status !== "success") return;

      const symRes = symbolReads[symIdx++];
      staticCache.set(pool, {
        pool,
        token,
        // A market can be created for any ERC-20, including ones with a
        // non-standard or missing symbol(). Fall back to a short address.
        tokenSymbol:
          symRes?.status === "success" ? String(symRes.result) : `${token.slice(0, 8)}…`,
        tokenDecimals: Number(decRes.result as bigint | number),
        swapFeeBps: BigInt(feeRes.result as bigint | number),
      });
    });
  }

  return staticCache;
}

/**
 * Full snapshot of every pool: registry + immutable data + live reserves.
 *
 * Reserves come from `indexerState()` rather than the individual getters —
 * the pool bundles them into one call specifically so off-chain consumers do
 * not pay six eth_calls per pool per cycle.
 */
export async function snapshotPools(): Promise<PoolSnapshot[]> {
  const pools = await listPools();
  if (pools.length === 0) return [];

  const statics = await loadStatic(pools);
  const known = pools.filter((p) => statics.has(p));

  const dynamic = await multicall(
    known.flatMap((pool) => [
      { address: pool, abi: exnihiloPoolAbi, functionName: "indexerState" },
      { address: pool, abi: exnihiloPoolAbi, functionName: "isClosing" },
    ]),
  );

  const out: PoolSnapshot[] = [];

  known.forEach((pool, i) => {
    const stateRes = dynamic[i * 2];
    const closingRes = dynamic[i * 2 + 1];
    if (stateRes.status !== "success") return;

    // indexerState() → [backedAirToken, backedAirUsd, longPrice, shortPrice,
    //                   lpFeesLifetime, protocolFeesLifetime]
    const s = stateRes.result as readonly bigint[];
    const st = statics.get(pool)!;

    out.push({
      ...st,
      backedAirToken: s[0],
      backedAirUsd: s[1],
      isClosing: closingRes.status === "success" ? Boolean(closingRes.result) : false,
    });
  });

  return out;
}

/**
 * Optional low-latency path: react to a brand-new market in the block it is
 * created rather than on the next poll. A freshly seeded pool is priced purely
 * by whatever ratio its creator chose, so it is the single most likely place
 * for a large gap to the real market to exist.
 */
export function watchNewMarkets(onMarket: (pool: Address, token: Address) => void) {
  return client.watchEvent({
    address: CONFIG.factory,
    event: marketCreatedAbi[0],
    onLogs: (logs) => {
      for (const log of logs) {
        const { pool, tokenAddress } = log.args as { pool?: Address; tokenAddress?: Address };
        if (pool && tokenAddress) onMarket(pool, tokenAddress);
      }
    },
    onError: (err) => {
      if (process.env.DEBUG) console.error("watchNewMarkets:", err.message);
    },
  });
}
