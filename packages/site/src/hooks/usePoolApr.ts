import { useQuery } from "@tanstack/react-query";
import { hasIndexer, indexerFetch } from "../lib/indexer.ts";

export interface AprBucket {
  feeRevenue: string;
  tvlAvg: string;
  apr: number;
  snapshotCount: number;
}

export interface PoolAprData {
  pool: string;
  "1d": AprBucket;
  "7d": AprBucket;
  "30d": AprBucket;
}

export function usePoolApr(poolAddress: string, chainId: number) {
  return useQuery<PoolAprData>({
    // chainId in the key: pool addresses are only unique per chain
    queryKey: ["poolApr", chainId, poolAddress],
    queryFn: () =>
      indexerFetch<PoolAprData>(chainId, `/metrics/apr/${poolAddress.toLowerCase()}`),
    staleTime: 60_000,       // 1 min — APR doesn't change every second
    refetchInterval: 60_000,
    retry: 1,
    // Skip chains no indexer follows — those requests can only 404.
    enabled: hasIndexer(chainId),
  });
}
