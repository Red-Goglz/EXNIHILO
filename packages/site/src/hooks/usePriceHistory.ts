import { useQuery } from "@tanstack/react-query";
import { hasIndexer, indexerFetch } from "../lib/indexer.ts";

export interface PricePoint {
  timestamp: number;
  spot: bigint;
  long: bigint;
  short: bigint;
  event: string;
}

interface ApiResponse {
  pool: string;
  count: number;
  prices: {
    timestamp: number;
    spot: string;
    long: string;
    short: string;
    event: string;
  }[];
}

export function usePriceHistory(poolAddress: string, chainId: number, limit = 200) {
  return useQuery<PricePoint[]>({
    // chainId in the key: pool addresses are only unique per chain
    queryKey: ["priceHistory", chainId, poolAddress, limit],
    queryFn: async () => {
      const data = await indexerFetch<ApiResponse>(
        chainId,
        `/prices/${poolAddress.toLowerCase()}?limit=${limit}`,
      );
      return data.prices.map((p) => ({
        timestamp: p.timestamp,
        spot: BigInt(p.spot),
        long: BigInt(p.long),
        short: BigInt(p.short),
        event: p.event,
      }));
    },
    staleTime: 15_000,
    refetchInterval: 15_000,
    retry: 1,
    // Skip chains no indexer follows — those requests can only 404.
    enabled: hasIndexer(chainId),
  });
}
