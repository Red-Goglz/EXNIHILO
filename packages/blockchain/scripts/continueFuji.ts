/**
 * Continuation script: seeds faucet and creates markets on already-deployed Fuji contracts.
 * Run after deployFuji.ts if it failed partway through.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const DEPLOYED = {
  usdc:        "0xfFE6304982d0592E19108eA2c789DAa7eEBA4e60",
  positionNFT: "0xd23F80b1e789ED2438A1aFFc0B6947845a95735B",
  lpNFT:       "0xD0A8Fd0188abaA91eCDaeefaabdD9c64c684E9fC",
  factory:     "0xDba4FCd283365Ecc773017c6EECbfd7525424211",
  router:      "0xfacc707663b05c3001c2B84C1D0204e6275705Bb",
  faucet:      "0x6B6E706bc796027C9f43BF52d5A6d2f22c97F2B0",
  tokens: {
    ARENA:   "0x2bd4E700e5477CA8b54E0703230c8C39652B35e0",
    NOCHILL: "0x25C934b75faF1F55c9cDBD21BD3e77234fDaeE10",
    RGOGLZ:  "0x80e07A1Bc5f760eAE304599EC638138b41420469",
    BANDS:   "0x3Cb5Dc99fBcb3c5DB695B2714B244261abFA1662",
    WAVAX:   "0x1B941846eCd5420058A8e581770eaBbd205c70Ab",
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
      tokenAddr, usdcSeed, tokenSeed, maxPosUsd, maxPosBps, 0n, `air${symbol}`, `air${symbol}Usd`, 18
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
