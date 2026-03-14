export const FUJI_CHAIN_ID    = 43113;
export const HARDHAT_CHAIN_ID = 31337;

export const ADDRESSES = {
  // ── Avalanche Fuji testnet ──────────────────────────────────────────────────
  [FUJI_CHAIN_ID]: {
    factory:     "0x56143D13d7645cb0B223B6dcc6Fe191b06343749" as `0x${string}`,
    positionNFT: "0x6645378D58e91731e4ffDdD0b8cE49869E49d716" as `0x${string}`,
    lpNFT:       "0x501B84b5CE84da8eee2809b8FC6d2d1A81ceA8E7" as `0x${string}`,
    usdc:        "0x3aC316e49B06b07d4EAfFfc510d9D491E2EcF4c8" as `0x${string}`,
    faucet:      "0xDE21c209A0605bc9128CC5b61f15e7ddfDcD119f" as `0x${string}`,
    router:      "0x1b23f3D3760c9D7572A32E7f29fA652E6D8b598A" as `0x${string}`,
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
