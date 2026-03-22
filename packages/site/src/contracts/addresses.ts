export const FUJI_CHAIN_ID    = 43113;
export const HARDHAT_CHAIN_ID = 31337;

export const ADDRESSES = {
  // ── Avalanche Fuji testnet ──────────────────────────────────────────────────
  [FUJI_CHAIN_ID]: {
    factory:     "0xff1A130a559EF125a7cab3665951adFA288D87Fd" as `0x${string}`,
    positionNFT: "0x378Abb5A52eD278F9b3071A749007AA4D55816d8" as `0x${string}`,
    lpNFT:       "0xE312E9dB5016193802bc95f81E166F78FBB683a7" as `0x${string}`,
    usdc:        "0x83EAeb31E6AC6F9334fFfa1701899356130167C0" as `0x${string}`,
    faucet:      "0x7d1363566742A1022ACc29c8838D7eb904C9eeed" as `0x${string}`,
    router:      "0xEcd4d967b6eDc1c543d9f455ac1582e462332568" as `0x${string}`,
  },

  // ── Local Hardhat node (npx hardhat node) ───────────────────────────────────
  [HARDHAT_CHAIN_ID]: {
    factory:     "0x95bD8D42f30351685e96C62EDdc0d0613bf9a87A" as `0x${string}`,
    positionNFT: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as `0x${string}`,
    lpNFT:       "0xef11D1c2aA48826D4c41e54ab82D1Ff5Ad8A64Ca" as `0x${string}`,
    usdc:        "0x5FbDB2315678afecb367f032d93F642f64180aa3" as `0x${string}`,
    router:      "0x0000000000000000000000000000000000000000" as `0x${string}`, // TODO: deploy and fill
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
