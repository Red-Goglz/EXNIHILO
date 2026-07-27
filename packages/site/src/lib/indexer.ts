import { chainById } from "./chains.ts";

/**
 * Indexer access, resolved per chain.
 *
 * A Ponder instance follows exactly one chain and rejects requests carrying a
 * different `?chainId=`, so callers must check `hasIndexer` before querying —
 * otherwise every request on an unindexed chain is a guaranteed 404.
 */

export function indexerUrlFor(chainId: number): string | undefined {
  return chainById(chainId)?.indexerUrl;
}

export function hasIndexer(chainId: number): boolean {
  return !!indexerUrlFor(chainId);
}

export class IndexerUnavailableError extends Error {
  constructor(chainId: number) {
    super(`No indexer configured for chain ${chainId}`);
    this.name = "IndexerUnavailableError";
  }
}

/**
 * GET `path` from the indexer for `chainId`, tagging the request with the
 * chain so a misconfigured URL surfaces as an error instead of wrong-chain data.
 * Throws on a non-2xx response; callers decide how to present the failure.
 */
export async function indexerFetch<T>(chainId: number, path: string): Promise<T> {
  const base = indexerUrlFor(chainId);
  if (!base) throw new IndexerUnavailableError(chainId);

  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${base}${path}${sep}chainId=${chainId}`);
  if (!res.ok) throw new Error(`Indexer returned ${res.status}`);
  return (await res.json()) as T;
}
