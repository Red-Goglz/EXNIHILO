export const FUJI_CHAIN_ID    = 43113;
export const HARDHAT_CHAIN_ID = 31337;

export const ADDRESSES = {
  // ── Avalanche Fuji testnet ──────────────────────────────────────────────────
  // Must match src/contracts/fujiAddresses.json, rewritten by
  // `npx hardhat run scripts/deployFuji.ts --network avalancheFujiTestnet`.
  [FUJI_CHAIN_ID]: {
    factory:      "0xe90EA832582DCADc45dfCE2869292a5B36d9Fd6d" as `0x${string}`,
    poolDeployer: "0x119ABf394843A081C39627050256F65D1789E77e" as `0x${string}`,
    positionNFT:  "0x47E73F238Ff8bFCAD3Af71b0D55Ed52479890C8e" as `0x${string}`,
    lpNFT:        "0x4722370fef2F3e899e3d5F20aec2D3e10801D618" as `0x${string}`,
    usdc:         "0x378B0BB62b7cdF5B2C706e2E704D3317Ab7fe492" as `0x${string}`,
    faucet:       "0x4ebC95C71a6303d9B5e2Cfade64BbEa37663BE0d" as `0x${string}`,
    router:       "0x7d9FFfEde3E38aF0e9EB09467a70f8553786b38C" as `0x${string}`,
  },

  // ── Local Hardhat node (npx hardhat node) ───────────────────────────────────
  [HARDHAT_CHAIN_ID]: {
    factory:     "0x98eDDadCfde04dC22a0e62119617e74a6Bc77313" as `0x${string}`,
    positionNFT: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as `0x${string}`,
    lpNFT:       "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as `0x${string}`,
    usdc:        "0x5FbDB2315678afecb367f032d93F642f64180aa3" as `0x${string}`,
    router:      "0x5f3f1dBD7B74C6B46e8c44f98792A1dAf8d69154" as `0x${string}`,
    // ARENA — must match `testToken` in src/contracts/localAddresses.json,
    // which deployLocal.ts rewrites on every run.
    testToken:   "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9" as `0x${string}`,
  },
} as const;

export type SupportedChainId = keyof typeof ADDRESSES;

export function getAddresses(chainId: number) {
  const addrs = ADDRESSES[chainId as SupportedChainId];
  if (!addrs) throw new Error(`Unsupported chain: ${chainId}`);
  return addrs;
}
