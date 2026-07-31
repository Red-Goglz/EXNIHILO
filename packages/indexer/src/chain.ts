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
 */

function addr(name: string, fallback: string): `0x${string}` {
  return (process.env[name] ?? fallback) as `0x${string}`;
}

export const INDEXED_CHAIN_ID = Number(process.env.PONDER_CHAIN_ID ?? 43114);

export const FACTORY_ADDRESS = addr(
  "PONDER_FACTORY_ADDRESS",
  "0xBe6Fb0e7b7d8EFD491FEbC436F737cE8B244F85a",
);
export const POSITION_NFT_ADDRESS = addr(
  "PONDER_POSITION_NFT_ADDRESS",
  "0xa08E20fb4c157cf8E46c67A41250F54c1b53adfd",
);
export const LP_NFT_ADDRESS = addr(
  "PONDER_LP_NFT_ADDRESS",
  "0x71a6802e1b1313822014D29c5Fe43Dd441a4dB9a",
);

/** Block the mainnet factory was deployed in. Never lower it. */
export const START_BLOCK = Number(process.env.PONDER_START_BLOCK ?? 91_382_693);

export const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as `0x${string}`;
