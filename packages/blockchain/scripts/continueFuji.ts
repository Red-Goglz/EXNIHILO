/**
 * Continuation script: seeds faucet and creates markets on already-deployed Fuji contracts.
 * Run after deployFuji.ts if it failed partway through.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const DEPLOYED = {
  usdc:        "0x120D9f9dD15388c0a1fa5a3146F3e07ae0e654Fa",
  positionNFT: "0x2eEA6D323ab9b8Fb8cad53aC4B65EE09EAD69Ba4",
  lpNFT:       "0xeE05397377E793675817bEC8553e4553BaC5ef7C",
  factory:     "0xfb44B5D11b15F116Bc311eF519D22c259b952E5f",
  router:      "0x313D8030D16251d4345b376058915A505638c0d5",
  faucet:      "0x2fd7d27F2E5F2Da15765b2ec4242292f436e1533",
  tokens: {
    ARENA:   "0x93Cda24469E1Ee18663072fDb437b9F334a41011",
    NOCHILL: "0x6F222d6FCF3224f5c172Fe2eF069ef26955D022F",
    RGOGLZ:  "0x57477C7BAE4fF069074EdF6161281Fa4827A9172",
    BANDS:   "0x2A0Cb7EF50F748139502f3015941d43d46B573De",
    WAVAX:   "0x351F076488a7561eDa0083227048d18526A322ed",
  },
};

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance: ", ethers.formatEther(balance), "AVAX");

  const usdc = await ethers.getContractAt("MockERC20", DEPLOYED.usdc);
  const factory = await ethers.getContractAt("EXNIHILOFactory", DEPLOYED.factory);

  // Seed faucet with USDC only (skip AVAX to save gas)
  const faucetUsdcBal = await usdc.balanceOf(DEPLOYED.faucet);
  if (faucetUsdcBal === 0n) {
    await (await (usdc as any).connect(deployer).mint(DEPLOYED.faucet, 10_000_000n * 1_000_000n)).wait();
    console.log("Seeded faucet: 10M USDC");
  } else {
    console.log("Faucet already has USDC, skipping seed");
  }

  // Send small AVAX to faucet if we have enough
  if (balance > ethers.parseEther("0.2")) {
    const seedTx = await deployer.sendTransaction({ to: DEPLOYED.faucet, value: ethers.parseEther("0.1") });
    await seedTx.wait();
    console.log("Seeded faucet: 0.1 AVAX");
  }

  // Create markets
  const marketSpecs: [string, bigint, bigint, bigint, bigint][] = [
    ["ARENA",   500n   * 1_000_000n,  500_000n * 10n ** 18n, 10n * 1_000_000n, 0n],
    ["NOCHILL", 20_000n * 1_000_000n,  20_000n * 10n ** 18n, 0n, 0n],
    ["RGOGLZ",  50_000n * 1_000_000n,  10_000n * 10n ** 18n, 0n, 100n],
    ["BANDS",   1_000n  * 1_000_000n, 10_000_000n * 10n ** 18n, 10n * 1_000_000n, 500n],
    ["WAVAX",  100_000n * 1_000_000n,   4_000n * 10n ** 18n, 0n, 0n],
  ];

  const poolAddresses: Record<string, string> = {};

  for (const [symbol, usdcSeed, tokenSeed, maxPosUsd, maxPosBps] of marketSpecs) {
    const tokenAddr = (DEPLOYED.tokens as any)[symbol];
    const token = await ethers.getContractAt("MockERC20", tokenAddr);

    await (await usdc.connect(deployer).approve(DEPLOYED.factory, usdcSeed)).wait();
    await (await token.connect(deployer).approve(DEPLOYED.factory, tokenSeed)).wait();

    const tx = await factory.connect(deployer).createMarket(
      tokenAddr, usdcSeed, tokenSeed, maxPosUsd, maxPosBps, 0n
    );
    const receipt = await tx.wait();

    let poolAddr = "";
    for (const log of receipt!.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed?.name === "MarketCreated") { poolAddr = parsed.args[0]; break; }
      } catch { /* skip */ }
    }

    poolAddresses[symbol] = poolAddr;
    const spotRaw = await (await ethers.getContractAt("EXNIHILOPool", poolAddr)).spotPrice();
    const spotUsd = Number(spotRaw) / 1e6;
    console.log(`  ${symbol.padEnd(7)} pool: ${poolAddr}  spot ~$${spotUsd.toFixed(4)}`);
  }

  // Write addresses
  const addresses = {
    chainId: 43113,
    factory: DEPLOYED.factory,
    positionNFT: DEPLOYED.positionNFT,
    lpNFT: DEPLOYED.lpNFT,
    usdc: DEPLOYED.usdc,
    router: DEPLOYED.router,
    faucet: DEPLOYED.faucet,
    testToken: DEPLOYED.tokens.ARENA,
    treasury: deployer.address,
    deployer: deployer.address,
    pools: poolAddresses,
  };

  const outPath = path.resolve(__dirname, "../../site/src/contracts/fujiAddresses.json");
  fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2));
  console.log("\n✓ Addresses written to:", outPath);
  console.log(JSON.stringify(addresses, null, 2));

  console.log("\n─── VERIFY COMMANDS ─────────────────────────────────────");
  console.log(`npx hardhat verify --network avalancheFujiTestnet ${DEPLOYED.usdc} "USD Coin" "USDC" 6`);
  console.log(`npx hardhat verify --network avalancheFujiTestnet ${DEPLOYED.positionNFT}`);
  console.log(`npx hardhat verify --network avalancheFujiTestnet ${DEPLOYED.lpNFT} "${DEPLOYED.factory}"`);
  console.log(`npx hardhat verify --network avalancheFujiTestnet ${DEPLOYED.factory} "${DEPLOYED.positionNFT}" "${DEPLOYED.lpNFT}" "${DEPLOYED.usdc}" "${deployer.address}" 100`);
  console.log(`npx hardhat verify --network avalancheFujiTestnet ${DEPLOYED.router} "${DEPLOYED.factory}" "${DEPLOYED.usdc}"`);
  console.log(`npx hardhat verify --network avalancheFujiTestnet ${DEPLOYED.faucet} "${DEPLOYED.usdc}"`);
}

main().catch((err) => { console.error(err); process.exit(1); });
