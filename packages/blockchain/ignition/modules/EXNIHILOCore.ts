import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * EXNIHILOCore — deploys the three shared infrastructure contracts:
 *
 *   PositionNFT   — global registry for all Long/Short position tokens
 *   LpNFT         — global registry for all LP tokens
 *   EXNIHILOFactory — permissionless market factory wired to both NFT contracts
 *
 * The factory is the only contract that needs network-specific parameters
 * (USDC address, protocol treasury, swap fee).  Supply them via a parameters
 * file (see ignition/parameters/).
 *
 * Usage:
 *   npx hardhat ignition deploy ignition/modules/EXNIHILOCore.ts \
 *     --network avalanche \
 *     --parameters ignition/parameters/avalanche.json
 *
 *   npx hardhat ignition deploy ignition/modules/EXNIHILOCore.ts \
 *     --network avalancheFujiTestnet \
 *     --parameters ignition/parameters/fuji.json
 *
 * Verify after deploy:
 *   npx hardhat ignition verify chain-43114   (mainnet)
 *   npx hardhat ignition verify chain-43113   (fuji)
 */
const EXNIHILOCoreModule = buildModule("EXNIHILOCore", (m) => {
  // ── Parameters (supplied via parameters JSON file) ───────────────────────

  const usdc             = m.getParameter<string>("usdc");
  const protocolTreasury = m.getParameter<string>("protocolTreasury");
  const defaultSwapFeeBps = m.getParameter<bigint>("defaultSwapFeeBps", 100n);

  // ── Deploy shared NFT contracts ──────────────────────────────────────────

  const positionNFT = m.contract("PositionNFT");
  const lpNFT       = m.contract("LpNFT");

  // ── Deploy factory ───────────────────────────────────────────────────────

  const factory = m.contract("EXNIHILOFactory", [
    positionNFT,        // positionNFT_
    lpNFT,              // lpNftContract_
    usdc,               // usdc_
    protocolTreasury,   // protocolTreasury_
    defaultSwapFeeBps,  // defaultSwapFeeBps_
  ]);

  return { positionNFT, lpNFT, factory };
});

export default EXNIHILOCoreModule;
