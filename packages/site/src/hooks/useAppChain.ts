import { useMemo } from "react";
import { useParams } from "react-router-dom";
import {
  appPath,
  chainBySlug,
  DEFAULT_CHAIN,
  type ChainSlug,
} from "../lib/chains.ts";
import { getAddresses } from "../contracts/addresses.ts";

/**
 * Resolves the active chain from the URL (/app/:chainSlug/...).
 * The URL — not the connected wallet — is the source of truth for which
 * chain's contracts we read from. Falls back to the default chain when
 * rendered outside a chain-scoped route.
 */
export function useAppChain() {
  const { chainSlug } = useParams();

  return useMemo(() => {
    const appChain = chainBySlug(chainSlug) ?? DEFAULT_CHAIN;
    const chainId = appChain.chain.id;
    return {
      slug: appChain.slug as ChainSlug,
      chainId,
      chain: appChain.chain,
      label: appChain.label,
      testnet: appChain.testnet,
      addresses: getAddresses(chainId),
      /** Chain-scoped link builder: path("markets/0xabc") → "/app/fuji/markets/0xabc" */
      path: (sub = "") => appPath(appChain.slug as ChainSlug, sub),
    };
  }, [chainSlug]);
}
