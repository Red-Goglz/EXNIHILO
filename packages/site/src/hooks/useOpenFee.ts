import { useReadContract } from "wagmi";
import { exnihiloPoolAbi } from "@exnihilio/abis";

/**
 * Quotes the USDC fee to open a position, straight from the pool.
 *
 * The fee is NOT a flat 5% of notional: `_openFees` adds an OI-integral impact
 * fee on top of the base, and the base itself has a MIN_POSITION_FEE floor. The
 * contract exposes `quoteOpenFee` as the single source of truth precisely so
 * frontends don't replicate the formula — replicating it silently under-approves
 * and the open reverts with ERC20InsufficientAllowance.
 *
 * `feeMax` adds headroom because the impact term moves with open interest: the
 * quote is read a few seconds before the user signs, and any trade landing in
 * between raises the real fee. Approving the bare quote makes the open a race.
 */

/** Headroom over the quoted fee, in bps. The renew path uses 2%; opens get more
 *  because the impact term reacts to other traders' open interest. */
const FEE_HEADROOM_BPS = 500n; // 5%

export interface OpenFee {
  /** Exact fee at quote time — use for display. */
  fee: bigint | undefined;
  /** Fee plus headroom — use for approvals and allowance checks. */
  feeMax: bigint | undefined;
  isLoading: boolean;
}

export function useOpenFee(
  poolAddress: `0x${string}`,
  chainId: number,
  usdcRaw: bigint,
  isLong: boolean | null,
): OpenFee {
  const enabled = usdcRaw > 0n && isLong !== null;

  const { data, isLoading } = useReadContract({
    address: poolAddress,
    abi: exnihiloPoolAbi,
    functionName: "quoteOpenFee",
    args: [usdcRaw, isLong ?? true],
    chainId,
    query: { enabled },
  });

  const fee = data as bigint | undefined;

  return {
    fee,
    feeMax:
      fee !== undefined
        ? (fee * (10_000n + FEE_HEADROOM_BPS)) / 10_000n
        : undefined,
    isLoading: enabled && isLoading,
  };
}
