export const FUJI_CHAIN_ID    = 43113;
export const HARDHAT_CHAIN_ID = 31337;

export const ADDRESSES = {
  // ── Avalanche Fuji testnet ──────────────────────────────────────────────────
  [FUJI_CHAIN_ID]: {
    factory:     "0xe77E3d6B532c548F16Fbf65E6beCAAAc5d17A326" as `0x${string}`,
    positionNFT: "0xc041AFa0F4E62685c1B717adCe6Af66dF817DC37" as `0x${string}`,
    lpNFT:       "0x0591D40AdC6bD090b020a69E3688EcB746dE79D6" as `0x${string}`,
    usdc:        "0x1539792fb1723bB6C504A393e1E5916e06361b49" as `0x${string}`,
    faucet:      "0x244Fb3964b54f2A9c68A0Dca3166A6Cbe39E3302" as `0x${string}`,
    router:      "0x0A59D214f83A1BB762624538b755271012a3D37C" as `0x${string}`,
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
