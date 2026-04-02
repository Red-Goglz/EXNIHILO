export const FUJI_CHAIN_ID    = 43113;
export const HARDHAT_CHAIN_ID = 31337;

export const ADDRESSES = {
  // ── Avalanche Fuji testnet ──────────────────────────────────────────────────
  [FUJI_CHAIN_ID]: {
    factory:     "0xfb44B5D11b15F116Bc311eF519D22c259b952E5f" as `0x${string}`,
    positionNFT: "0x2eEA6D323ab9b8Fb8cad53aC4B65EE09EAD69Ba4" as `0x${string}`,
    lpNFT:       "0xeE05397377E793675817bEC8553e4553BaC5ef7C" as `0x${string}`,
    usdc:        "0x120D9f9dD15388c0a1fa5a3146F3e07ae0e654Fa" as `0x${string}`,
    faucet:      "0x2fd7d27F2E5F2Da15765b2ec4242292f436e1533" as `0x${string}`,
    router:      "0x313D8030D16251d4345b376058915A505638c0d5" as `0x${string}`,
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
