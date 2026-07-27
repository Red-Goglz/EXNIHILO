/**
 * Single source of truth for the chain this indexer instance follows.
 *
 * Ponder indexes one chain per process, so both the config and the API must
 * agree on the id — the API rejects requests carrying a different `?chainId=`
 * rather than silently answering with wrong-chain data.
 *
 * Every value is overridable by env so the same code can follow a local
 * Hardhat node or a testnet without source edits; the defaults are the Fuji
 * deployment. Set overrides in `.env.local` (see `.env.example`).
 */

function addr(name: string, fallback: string): `0x${string}` {
  return (process.env[name] ?? fallback) as `0x${string}`;
}

export const INDEXED_CHAIN_ID = Number(process.env.PONDER_CHAIN_ID ?? 43113);

export const FACTORY_ADDRESS = addr(
  "PONDER_FACTORY_ADDRESS",
  "0xe90EA832582DCADc45dfCE2869292a5B36d9Fd6d",
);
export const POSITION_NFT_ADDRESS = addr(
  "PONDER_POSITION_NFT_ADDRESS",
  "0x47E73F238Ff8bFCAD3Af71b0D55Ed52479890C8e",
);
export const LP_NFT_ADDRESS = addr(
  "PONDER_LP_NFT_ADDRESS",
  "0x4722370fef2F3e899e3d5F20aec2D3e10801D618",
);

export const START_BLOCK = Number(process.env.PONDER_START_BLOCK ?? 57_374_656);

export const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as `0x${string}`;
