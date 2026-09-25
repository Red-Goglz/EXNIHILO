import { useReadContract } from "wagmi";
import { exnihiloPoolAbi } from "@exnihilio/abis";

/**
 * What an open would lock, straight from the pool's `quoteOpen`. The pool prices
 * an open at the worst of live reserves and the last few block opens, so a local
 * reserve calculation overstates it right after a price move and the slippage
 * floor built from it reverts the open.
 */
export function useOpenQuote(
  poolAddress: `0x${string}`,
  chainId: number,
  usdcRaw: bigint,
  isLong: boolean | null,
): { locked: bigint | undefined; isLoading: boolean } {
  const enabled = usdcRaw > 0n && isLong !== null;

  const { data, isLoading } = useReadContract({
    address: poolAddress,
    abi: exnihiloPoolAbi,
    functionName: "quoteOpen",
    args: [usdcRaw, isLong ?? true],
    chainId,
    query: { enabled },
  });

  return {
    locked: enabled ? (data as readonly [bigint, bigint] | undefined)?.[0] : undefined,
    isLoading: enabled && isLoading,
  };
}
