export const FUJI_CHAIN_ID    = 43113;
export const HARDHAT_CHAIN_ID = 31337;

export const ADDRESSES = {
  // ── Avalanche Fuji testnet ──────────────────────────────────────────────────
  [FUJI_CHAIN_ID]: {
    factory:     "0x8f4708B86bC2B304C287C73f7f59E731A80a1119" as `0x${string}`,
    positionNFT: "0x040E858FFF9B27C87B12c25599f8772591ac96c6" as `0x${string}`,
    lpNFT:       "0x1C897652Df8f1AB184Ef2fD314247B4D2F12193D" as `0x${string}`,
    usdc:        "0xD0e59Bf944387A190a46DF2E0fC8110780F66d0d" as `0x${string}`,
    faucet:      "0x225574Bf2Fa29606ED324Ce7FF9657c34fd3C84b" as `0x${string}`,
    router:      "0x880Ec3Ad3eEAC30a86C4e1a5056DB7dB1Bbbf84f" as `0x${string}`,
  },

  // ── Local Hardhat node (npx hardhat node) ───────────────────────────────────
  [HARDHAT_CHAIN_ID]: {
    factory:     "0x95bD8D42f30351685e96C62EDdc0d0613bf9a87A" as `0x${string}`,
    positionNFT: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as `0x${string}`,
    lpNFT:       "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as `0x${string}`,
    usdc:        "0x5FbDB2315678afecb367f032d93F642f64180aa3" as `0x${string}`,
    router:      "0x0000000000000000000000000000000000000000" as `0x${string}`,
    testToken:   "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9" as `0x${string}`,
  },
} as const;

export type SupportedChainId = keyof typeof ADDRESSES;

export function getAddresses(chainId: number) {
  const addrs = ADDRESSES[chainId as SupportedChainId];
  if (!addrs) throw new Error(`Unsupported chain: ${chainId}`);
  return addrs;
}
