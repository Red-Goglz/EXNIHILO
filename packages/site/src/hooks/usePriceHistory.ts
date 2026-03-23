import { useQuery } from "@tanstack/react-query";

// Indexer URL — set VITE_INDEXER_URL to your Ponder Replit URL
// e.g. https://exnihilo-indexer.your-username.repl.co
const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || "";

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

export function usePriceHistory(poolAddress: string, limit = 200) {
  return useQuery<PricePoint[]>({
    queryKey: ["priceHistory", poolAddress, limit],
    queryFn: async () => {
      if (!INDEXER_URL) throw new Error("VITE_INDEXER_URL not set");
      const res = await fetch(
        `${INDEXER_URL}/prices/${poolAddress.toLowerCase()}?limit=${limit}`
      );
      if (!res.ok) throw new Error(`Indexer returned ${res.status}`);
      const data: ApiResponse = await res.json();
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
    enabled: !!INDEXER_URL, // don't fetch if no indexer configured
  });
}
