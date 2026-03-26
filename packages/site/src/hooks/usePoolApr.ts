import { useQuery } from "@tanstack/react-query";

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || "";

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

export function usePoolApr(poolAddress: string) {
  return useQuery<PoolAprData>({
    queryKey: ["poolApr", poolAddress],
    queryFn: async () => {
      if (!INDEXER_URL) throw new Error("VITE_INDEXER_URL not set");
      const res = await fetch(
        `${INDEXER_URL}/metrics/apr/${poolAddress.toLowerCase()}`
      );
      if (!res.ok) throw new Error(`Indexer returned ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,       // 1 min — APR doesn't change every second
    refetchInterval: 60_000,
    retry: 1,
    enabled: !!INDEXER_URL,
  });
}
