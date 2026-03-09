/**
 * Avalanche Fuji testnet deployment script.
 * Deploys MockUSDC + PositionNFT + LpNFT + EXNIHILOFactory + 5 mock meme tokens,
 * then seeds one market per token.
 *
 * All contracts use MockERC20 for USDC so you don't need real Fuji USDC.
 *
 * LpNFT circular-dependency is resolved via CREATE address prediction:
 *   1. Read deployer nonce (N) before LpNFT deploy
 *   2. Factory will be deployed at nonce N+1 → predict its address
 *   3. Deploy LpNFT(predictedFactory)           — nonce N
 *   4. Deploy EXNIHILOFactory(...)              — nonce N+1 → matches prediction
 *   No bytecode patching or Hardhat-specific RPCs needed.
 *
 * Setup:
 *   cp packages/blockchain/.env.example packages/blockchain/.env
 *   # Fill in ACCOUNT_PRIVATE_KEY, PROTOCOL_TREASURY, optional FUJI_RPC_URL
 *
 * Usage:
 *   npx hardhat run scripts/deployFuji.ts --network avalancheFujiTestnet
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:    ", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:     ", ethers.formatEther(balance), "AVAX");
  if (balance < ethers.parseEther("0.5")) {
    console.warn("⚠  Low balance — you may run out of gas. Get Fuji AVAX from https://faucet.avax.network");
  }

  // Treasury: use env var or fall back to deployer
  const treasuryAddr = process.env.PROTOCOL_TREASURY?.trim() || deployer.address;
  console.log("Treasury:    ", treasuryAddr);

  const defaultSwapFeeBps = BigInt(process.env.DEFAULT_SWAP_FEE_BPS?.trim() || "100");
  console.log("Default fee: ", defaultSwapFeeBps.toString(), "bps");

  // ── 1. MockUSDC ──────────────────────────────────────────────────────────────
  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6);
  await usdc.waitForDeployment();
  const usdcAddress = await usdc.getAddress();
  console.log("MockUSDC:    ", usdcAddress);

  // ── 2. PositionNFT ───────────────────────────────────────────────────────────
  const posNFTF = await ethers.getContractFactory("PositionNFT");
  const positionNFT = await posNFTF.connect(deployer).deploy();
  await positionNFT.waitForDeployment();
  const positionNFTAddress = await positionNFT.getAddress();
  console.log("PositionNFT: ", positionNFTAddress);

  // ── 3. LpNFT + EXNIHILOFactory (nonce prediction) ──────────────────────────
  //
  // After the two deploys above, deployer nonce = initial + 2.
  // LpNFT will be tx N, factory will be tx N+1.
  // We pre-compute N+1 address and pass it to LpNFT constructor.
  const nonceBeforeLpNFT = await deployer.getNonce();
  const predictedFactoryAddress = ethers.getCreateAddress({
    from: deployer.address,
    nonce: nonceBeforeLpNFT + 1, // factory is the tx immediately after LpNFT
  });

  const lpNFTF = await ethers.getContractFactory("LpNFT");
  const lpNFT = await lpNFTF.connect(deployer).deploy(predictedFactoryAddress);
  await lpNFT.waitForDeployment();
  const lpNFTAddress = await lpNFT.getAddress();
  console.log("LpNFT:       ", lpNFTAddress);

  const FactoryF = await ethers.getContractFactory("EXNIHILOFactory");
  const factory = await FactoryF.connect(deployer).deploy(
    positionNFTAddress,
    lpNFTAddress,
    usdcAddress,
    treasuryAddr,
    defaultSwapFeeBps
  );
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();

  if (factoryAddress.toLowerCase() !== predictedFactoryAddress.toLowerCase()) {
    throw new Error(
      `Factory address mismatch!\n  predicted: ${predictedFactoryAddress}\n  actual:    ${factoryAddress}`
    );
  }
  const lpNftFactory = await lpNFT.factory();
  if (lpNftFactory.toLowerCase() !== factoryAddress.toLowerCase()) {
    throw new Error(
      `LpNFT.factory mismatch!\n  expected: ${factoryAddress}\n  actual:   ${lpNftFactory}`
    );
  }
  console.log("Factory:     ", factoryAddress, "(LpNFT.factory verified ✓)");

  // ── 4. Mock meme tokens ──────────────────────────────────────────────────────
  const memeTokens: { name: string; symbol: string; contract: any; address: string }[] = [];

  const memeSpecs = [
    { name: "Arena Token",    symbol: "ARENA"   },
    { name: "No Chill Token", symbol: "NOCHILL" },
    { name: "Ragoogle",       symbol: "RGOGLZ"  },
    { name: "Bands Finance",  symbol: "BANDS"   },
    { name: "Wrapped AVAX",   symbol: "WAVAX"   },
  ];

  for (const spec of memeSpecs) {
    const token = await MockERC20F.connect(deployer).deploy(spec.name, spec.symbol, 18);
    await token.waitForDeployment();
    const addr = await token.getAddress();
    memeTokens.push({ ...spec, contract: token, address: addr });
    console.log(`Mock${spec.symbol.padEnd(7)}: `, addr);
  }

  // ── 5. Mint tokens to deployer (and treasury if different) ───────────────────
  const USDC_MINT  = 100_000_000n * 1_000_000n;    // 100M MockUSDC (6 dec)
  const TOKEN_MINT = 100_000_000n * 10n ** 18n;    // 100M of each meme (18 dec)

  const mintRecipients = [deployer.address];
  if (treasuryAddr.toLowerCase() !== deployer.address.toLowerCase()) {
    mintRecipients.push(treasuryAddr);
  }

  for (const recipient of mintRecipients) {
    await (usdc as any).connect(deployer).mint(recipient, USDC_MINT);
    for (const t of memeTokens) {
      await (t.contract as any).connect(deployer).mint(recipient, TOKEN_MINT);
    }
  }
  console.log(`Minted 100M MockUSDC + 100M of each meme to: ${mintRecipients.join(", ")}`);

  // ── 6. Create markets ────────────────────────────────────────────────────────
  //    Seed sizes chosen to give varied TVLs and prices similar to localhost.
  const marketSpecs: [string, bigint, bigint][] = [
    // ARENA   — small pool, ~$0.001/token
    ["ARENA",   500n   * 1_000_000n,  500_000n * 10n ** 18n],
    // NOCHILL — medium pool, ~$1/token
    ["NOCHILL", 20_000n * 1_000_000n,  20_000n * 10n ** 18n],
    // RGOGLZ  — larger pool, ~$5/token
    ["RGOGLZ",  50_000n * 1_000_000n,  10_000n * 10n ** 18n],
    // BANDS   — small pool, very cheap (~$0.0001/token)
    ["BANDS",   1_000n  * 1_000_000n, 10_000_000n * 10n ** 18n],
    // WAVAX   — large pool, ~$25/token
    ["WAVAX",  100_000n * 1_000_000n,   4_000n * 10n ** 18n],
  ];

  console.log("\n─── Creating markets ───────────────────────────────────");
  const poolAddresses: Record<string, string> = {};

  for (const [symbol, usdcSeed, tokenSeed] of marketSpecs) {
    const meme = memeTokens.find(t => t.symbol === symbol)!;

    await usdc.connect(deployer).approve(factoryAddress, usdcSeed);
    await meme.contract.connect(deployer).approve(factoryAddress, tokenSeed);

    const tx = await factory.connect(deployer).createMarket(
      meme.address,
      usdcSeed,
      tokenSeed,
      0n, // maxPositionUsd — no cap
      0n  // maxPositionBps — no cap
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

  // ── 7. Write addresses JSON ───────────────────────────────────────────────────
  const addresses = {
    chainId: 43113,
    factory:     factoryAddress,
    positionNFT: positionNFTAddress,
    lpNFT:       lpNFTAddress,
    usdc:        usdcAddress,
    testMeme:    memeTokens[0].address, // ARENA as the "default" test meme
    treasury:    treasuryAddr,
    deployer:    deployer.address,
    pools:       poolAddresses,
  };

  const outPath = path.resolve(__dirname, "../../site/src/contracts/fujiAddresses.json");
  fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2));
  console.log("\n✓ Addresses written to:", outPath);
  console.log(JSON.stringify(addresses, null, 2));

  console.log("\n─────────────────────────────────────────────────────────");
  console.log("DEPLOYMENT COMPLETE");
  console.log("─────────────────────────────────────────────────────────");
  console.log("  Network: Avalanche Fuji (chain ID 43113)");
  console.log("  RPC:     https://api.avax-test.network/ext/bc/C/rpc");
  console.log("\n  To verify contracts on Snowtrace:");
  console.log(`    npx hardhat verify --network avalancheFujiTestnet ${usdcAddress} "USD Coin" "USDC" 6`);
  console.log(`    npx hardhat verify --network avalancheFujiTestnet ${positionNFTAddress}`);
  console.log(`    npx hardhat verify --network avalancheFujiTestnet ${lpNFTAddress} "${factoryAddress}"`);
  console.log(`    npx hardhat verify --network avalancheFujiTestnet ${factoryAddress} "${positionNFTAddress}" "${lpNFTAddress}" "${usdcAddress}" "${treasuryAddr}" ${defaultSwapFeeBps}`);
  for (const t of memeTokens) {
    console.log(`    npx hardhat verify --network avalancheFujiTestnet ${t.address} "${t.name}" "${t.symbol}" 18`);
  }
  console.log("─────────────────────────────────────────────────────────");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
