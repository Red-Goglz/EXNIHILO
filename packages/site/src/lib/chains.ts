import { http, type Transport } from "wagmi";
import { avalancheFuji, hardhat } from "wagmi/chains";
import type { Chain } from "wagmi/chains";

/**
 * Single source of truth for every chain the dApp supports.
 * To add a chain: add an entry here + an entry in contracts/addresses.ts.
 * Router paths, wagmi config, guards, and nav all derive from this list.
 */
export interface AppChain {
  /** URL segment: /app/<slug>/... */
  slug: string;
  chain: Chain;
  /** Display name shown in the navbar / chain guard */
  label: string;
  /** RPC endpoint used for reads regardless of wallet connection */
  rpcUrl: string;
  testnet: boolean;
  /**
   * Ponder indexer serving this chain, if one is deployed. A Ponder instance
   * follows exactly one chain and 404s requests for any other, so chains
   * without an entry here must not be queried at all — the UI shows an
   * "indexer unavailable" state instead of firing requests that always fail.
   */
  indexerUrl?: string;
}

const fujiRpcUrl =
  import.meta.env.VITE_RPC_FUJI ?? "https://api.avax-test.network/ext/bc/C/rpc";

// One Ponder instance follows one chain, so each chain gets its own URL.
// VITE_INDEXER_URL is kept as the Fuji fallback for existing deployments.
const fujiIndexerUrl: string | undefined =
  import.meta.env.VITE_INDEXER_URL_FUJI || import.meta.env.VITE_INDEXER_URL || undefined;

const localIndexerUrl: string | undefined =
  import.meta.env.VITE_INDEXER_URL_LOCAL || undefined;

export const APP_CHAINS = [
  {
    slug: "fuji",
    chain: avalancheFuji,
    label: "FUJI TESTNET",
    rpcUrl: fujiRpcUrl,
    testnet: true,
    indexerUrl: fujiIndexerUrl,
  },
  {
    slug: "local",
    chain: hardhat,
    label: "HARDHAT LOCAL",
    rpcUrl: "http://127.0.0.1:8545",
    testnet: true,
    indexerUrl: localIndexerUrl,
  },
] as const satisfies readonly AppChain[];

export type ChainSlug = (typeof APP_CHAINS)[number]["slug"];

/** Chain used when a URL has no (or an unknown) chain segment. */
export const DEFAULT_CHAIN = APP_CHAINS[0];

export const SUPPORTED_CHAIN_IDS: number[] = APP_CHAINS.map((c) => c.chain.id);

export function isChainSlug(slug: string | undefined): slug is ChainSlug {
  return APP_CHAINS.some((c) => c.slug === slug);
}

export function chainBySlug(slug: string | undefined): AppChain | undefined {
  return APP_CHAINS.find((c) => c.slug === slug);
}

export function chainById(chainId: number | undefined): AppChain | undefined {
  return APP_CHAINS.find((c) => c.chain.id === chainId);
}

/** Builds a chain-scoped app path, e.g. appPath("fuji", "markets/0xabc") → "/app/fuji/markets/0xabc" */
export function appPath(slug: ChainSlug, sub = ""): string {
  return sub ? `/app/${slug}/${sub}` : `/app/${slug}`;
}

/** wagmi createConfig inputs derived from the registry */
export const wagmiChains = APP_CHAINS.map((c) => c.chain) as unknown as readonly [
  Chain,
  ...Chain[],
];

export const wagmiTransports = Object.fromEntries(
  APP_CHAINS.map((c) => [c.chain.id, http(c.rpcUrl)])
) as Record<number, Transport>;
