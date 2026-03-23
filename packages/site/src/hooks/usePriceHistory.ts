import { useQuery } from "@tanstack/react-query";

// Use relative URL so requests go through the vite proxy to Ponder
const API_BASE = "";

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
      const res = await fetch(
        `${API_BASE}/prices/${poolAddress.toLowerCase()}?limit=${limit}`
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
    staleTime: 15_000, // refetch every 15s
    refetchInterval: 15_000,
    retry: 1,
  });
}
