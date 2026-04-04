export const FUJI_CHAIN_ID    = 43113;
export const HARDHAT_CHAIN_ID = 31337;

export const ADDRESSES = {
  // ── Avalanche Fuji testnet ──────────────────────────────────────────────────
  [FUJI_CHAIN_ID]: {
    factory:     "0xDba4FCd283365Ecc773017c6EECbfd7525424211" as `0x${string}`,
    positionNFT: "0xd23F80b1e789ED2438A1aFFc0B6947845a95735B" as `0x${string}`,
    lpNFT:       "0xD0A8Fd0188abaA91eCDaeefaabdD9c64c684E9fC" as `0x${string}`,
    usdc:        "0xfFE6304982d0592E19108eA2c789DAa7eEBA4e60" as `0x${string}`,
    faucet:      "0x6B6E706bc796027C9f43BF52d5A6d2f22c97F2B0" as `0x${string}`,
    router:      "0x3BFA0E1C244be6607525F0AcC845712356A21521" as `0x${string}`,
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
