import { useAccount, useChainId, useReadContracts } from "wagmi";
import { erc20Abi } from "@exnihilio/abis";
import { getAddresses } from "../contracts/addresses.ts";

const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

/**
 * Reads the user's USDC allowance to the EXNIHILO router.
 * Returns `routerAddress` (or undefined if not deployed) and `routerAllowance`.
 */
export function useRouterApproval(usdcAddress: `0x${string}`) {
  const { address } = useAccount();
  const chainId = useChainId();

  let routerAddress: `0x${string}` | undefined;
  try {
    const addrs = getAddresses(chainId);
    routerAddress = addrs.router;
  } catch {
    /* unsupported chain */
  }

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
