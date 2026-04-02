/**
 * Continuation script: seeds faucet and creates markets on already-deployed Fuji contracts.
 * Run after deployFuji.ts if it failed partway through.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const DEPLOYED = {
  usdc:        "0x1539792fb1723bB6C504A393e1E5916e06361b49",
  positionNFT: "0xc041AFa0F4E62685c1B717adCe6Af66dF817DC37",
  lpNFT:       "0x0591D40AdC6bD090b020a69E3688EcB746dE79D6",
  factory:     "0xe77E3d6B532c548F16Fbf65E6beCAAAc5d17A326",
  router:      "0x0A59D214f83A1BB762624538b755271012a3D37C",
  faucet:      "0x244Fb3964b54f2A9c68A0Dca3166A6Cbe39E3302",
  tokens: {
    ARENA:   "0xcF92bA028b0F38aE2A2f9e59Bfd575d30f240dDe",
    NOCHILL: "0x0CaBE62b95818722811160bE22d0e7B78B5e81d0",
    RGOGLZ:  "0xdC0dA911e369E8280824aAB1509c1e6098A461A5",
    BANDS:   "0x5C01b8daf02f21b3705744b797A7912C61539Af6",
    WAVAX:   "0x5bc78D769d4132CA7D2B67Cfcf896e1CFc977029",
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
