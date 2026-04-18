export const FUJI_CHAIN_ID    = 43113;
export const HARDHAT_CHAIN_ID = 31337;

export const ADDRESSES = {
  // ── Avalanche Fuji testnet ──────────────────────────────────────────────────
  [FUJI_CHAIN_ID]: {
    factory:      "0xA07e1d24a2df2284210e44A01C95EB471C0EC7a7" as `0x${string}`,
    poolDeployer: "0xA51f532a99f5DCb1178B193153EE7473D68cE229" as `0x${string}`,
    positionNFT:  "0x6818a4c71E8271CFD765900F10A24a46aF7fB88a" as `0x${string}`,
    lpNFT:        "0x770960d23C6fa38dA748AFcDbE1865CEC4f74C9d" as `0x${string}`,
    usdc:         "0xC514C55ed6C9011db57f8F9DD81acD7cD33Cb296" as `0x${string}`,
    faucet:       "0x7fc29625E55d09f63c9e2f08f4a5fF693bB5d927" as `0x${string}`,
    router:       "0xe228f2591527e3F506197464a973fF793fE56222" as `0x${string}`,
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
