export const FUJI_CHAIN_ID    = 43113;
export const HARDHAT_CHAIN_ID = 31337;

export const ADDRESSES = {
  // ── Avalanche Fuji testnet ──────────────────────────────────────────────────
  [FUJI_CHAIN_ID]: {
    factory:     "0x13b436a263F9d9b6ff1945961C5C960c8ae98614" as `0x${string}`,
    positionNFT: "0xCabe1eaCFFbC617608f75A03FADC9D829a3715fc" as `0x${string}`,
    lpNFT:       "0xF298744Ef968E31d5d3D65Ae2C9EB7A641e02f6d" as `0x${string}`,
    usdc:        "0x3b1afaC2D81af169c7D0B1a99dfEA7bb1C9Cc25e" as `0x${string}`,
  },

  // ── Local Hardhat node (npx hardhat node) ───────────────────────────────────
  [HARDHAT_CHAIN_ID]: {
    factory:     "0x95bD8D42f30351685e96C62EDdc0d0613bf9a87A" as `0x${string}`,
    positionNFT: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as `0x${string}`,
    lpNFT:       "0xef11D1c2aA48826D4c41e54ab82D1Ff5Ad8A64Ca" as `0x${string}`,
    usdc:        "0x5FbDB2315678afecb367f032d93F642f64180aa3" as `0x${string}`,
    // Test token (MockPEPE, 18 dec) — local dev only
    testToken:   "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as `0x${string}`,
  },
} as const;

export type SupportedChainId = keyof typeof ADDRESSES;

export function getAddresses(chainId: number) {
  const addrs = ADDRESSES[chainId as SupportedChainId];
  if (!addrs) throw new Error(`Unsupported chain: ${chainId}`);
  return addrs;
}
