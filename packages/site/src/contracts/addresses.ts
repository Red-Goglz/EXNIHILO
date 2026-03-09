export const FUJI_CHAIN_ID    = 43113;
export const HARDHAT_CHAIN_ID = 31337;

export const ADDRESSES = {
  // ── Avalanche Fuji testnet ──────────────────────────────────────────────────
  [FUJI_CHAIN_ID]: {
    factory:     "0x541d9eF535B2F9eEc9769f281E8F88A727c8764E" as `0x${string}`,
    positionNFT: "0x853de4146B96352257964eD2D25F6B4beF203f4e" as `0x${string}`,
    lpNFT:       "0x01906738B32aeF10e0a864Bca6E056952c6E3603" as `0x${string}`,
    usdc:        "0x50538BbeaF3040Fec0B13D9C39bC0521237f15a5" as `0x${string}`,
  },

  // ── Local Hardhat node (npx hardhat node) ───────────────────────────────────
  [HARDHAT_CHAIN_ID]: {
    factory:     "0x95bD8D42f30351685e96C62EDdc0d0613bf9a87A" as `0x${string}`,
    positionNFT: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as `0x${string}`,
    lpNFT:       "0xef11D1c2aA48826D4c41e54ab82D1Ff5Ad8A64Ca" as `0x${string}`,
    usdc:        "0x5FbDB2315678afecb367f032d93F642f64180aa3" as `0x${string}`,
    // Test meme token (MockPEPE, 18 dec) — local dev only
    testMeme:    "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as `0x${string}`,
  },
} as const;

export type SupportedChainId = keyof typeof ADDRESSES;

export function getAddresses(chainId: number) {
  const addrs = ADDRESSES[chainId as SupportedChainId];
  if (!addrs) throw new Error(`Unsupported chain: ${chainId}`);
  return addrs;
}
