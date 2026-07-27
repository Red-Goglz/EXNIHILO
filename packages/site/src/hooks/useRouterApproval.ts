import { useAccount, useReadContracts } from "wagmi";
import { erc20Abi } from "@exnihilio/abis";
import { useAppChain } from "./useAppChain.ts";

const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

/**
 * Reads the user's USDC allowance to the EXNIHILO router.
 * Returns `routerAddress` (or undefined if not deployed) and `routerAllowance`.
 */
export function useRouterApproval(usdcAddress: `0x${string}`) {
  const { address } = useAccount();
  const { chainId, addresses } = useAppChain();

  const routerAddress: `0x${string}` | undefined = addresses.router;

  const hasRouter = !!routerAddress && routerAddress !== ZERO;

  const { data } = useReadContracts({
    contracts:
      hasRouter && address
        ? [
            {
              address: usdcAddress,
              abi: erc20Abi,
              functionName: "allowance" as const,
              args: [address, routerAddress!] as const,
              chainId,
            },
          ]
        : [],
    query: { enabled: hasRouter && !!address },
  });

  const routerAllowance = data?.[0]?.result as bigint | undefined;

  return {
    routerAddress: hasRouter ? routerAddress! : undefined,
    routerAllowance,
  };
}
