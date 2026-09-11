/**
 * Single source of truth for the chain this indexer instance follows.
 *
 * Ponder indexes one chain per process, so both the config and the API must
 * agree on the id — the API rejects requests carrying a different `?chainId=`
 * rather than silently answering with wrong-chain data.
 *
 * Every value is overridable by env so the same code can follow a local
 * Hardhat node or a testnet without source edits; the defaults are the
 * Avalanche C-Chain **mainnet** deployment. Set overrides in `.env.local`
 * (see `.env.example`).
 *
 * The RPC env var name is derived from the chain id
 * (`PONDER_RPC_URL_${INDEXED_CHAIN_ID}`), so changing the chain here means the
 * server needs `PONDER_RPC_URL_43114`, not the old `PONDER_RPC_URL_43113`.
 *
 * ── Where the mainnet addresses come from ────────────────────────────────────
 *
 * `deployMainnet.ts` writes `packages/site/src/contracts/mainnetAddresses.json`
 * and that file is the deployment's address book. This module reads it too, so
 * a redeploy cannot leave the site and the indexer pointing at different
 * factories — a divergence that is completely silent, because INDEXED_CHAIN_ID
 * still matches on both sides and every request looks valid (audit PU-004).
 *
 * Precedence is env > the address book > the constants below. Reading it is
 * best-effort on purpose: an indexer running outside the monorepo, or against a
 * chain that has no such book, still starts on the fallbacks.
 */
import { createRequire } from "node:module";

/** Chain the address book below describes. It has no chainId field of its own. */
const ADDRESS_BOOK_CHAIN_ID = 43114;

type AddressBook = {
  factory?: string;
  positionNFT?: string;
  lpNFT?: string;
  startBlock?: number;
};

export const INDEXED_CHAIN_ID = Number(process.env.PONDER_CHAIN_ID ?? 43114);

/**
 * Load the deployed address book, or an empty object when it is absent or
 * unreadable. Never consulted for a chain it does not describe: pointing a Fuji
 * or local instance at the mainnet book would be worse than the stale defaults
 * this exists to prevent.
 */
function addressBook(): AddressBook {
  if (INDEXED_CHAIN_ID !== ADDRESS_BOOK_CHAIN_ID) return {};
  try {
    const require = createRequire(import.meta.url);
    return require("../../site/src/contracts/mainnetAddresses.json") as AddressBook;
  } catch {
    return {};
  }
}

const book = addressBook();

function addr(name: string, deployed: string | undefined, fallback: string): `0x${string}` {
  return (process.env[name] ?? deployed ?? fallback) as `0x${string}`;
}

export const FACTORY_ADDRESS = addr(
  "PONDER_FACTORY_ADDRESS",
  book.factory,
  "0xBe6Fb0e7b7d8EFD491FEbC436F737cE8B244F85a",
);
export const POSITION_NFT_ADDRESS = addr(
  "PONDER_POSITION_NFT_ADDRESS",
  book.positionNFT,
  "0xa08E20fb4c157cf8E46c67A41250F54c1b53adfd",
);
export const LP_NFT_ADDRESS = addr(
  "PONDER_LP_NFT_ADDRESS",
  book.lpNFT,
  "0x71a6802e1b1313822014D29c5Fe43Dd441a4dB9a",
);

/**
 * Block the factory was deployed in. Never lower it.
 *
 * Tied to FACTORY_ADDRESS: a start block from one deployment against another
 * deployment's factory either misses history or re-scans thousands of empty
 * blocks, so both move together or neither does.
 */
export const START_BLOCK = Number(
  process.env.PONDER_START_BLOCK ?? book.startBlock ?? 91_382_693,
);

export const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as `0x${string}`;
