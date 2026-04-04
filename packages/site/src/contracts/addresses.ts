export const FUJI_CHAIN_ID    = 43113;
export const HARDHAT_CHAIN_ID = 31337;

export const ADDRESSES = {
  // ── Avalanche Fuji testnet ──────────────────────────────────────────────────
  [FUJI_CHAIN_ID]: {
    factory:     "0xebeB3d8888e51027DddE6745BEBB633236533a18" as `0x${string}`,
    positionNFT: "0x9B3CE8FAF33ca6AAF998178344482d9d2ec4052E" as `0x${string}`,
    lpNFT:       "0xF80CC21C7efed26D8f4f3195B70a9c13e74Cab7D" as `0x${string}`,
    usdc:        "0xa6F7C2Ad039aB4d21C5fa111683Ca3cE8d2C0fa4" as `0x${string}`,
    faucet:      "0xaE4a9DD91587c6F36BbCC06008eE5Edf081EbBC4" as `0x${string}`,
    router:      "0xEd3EB063919cD90286cF2B2570a8403877751602" as `0x${string}`,
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
