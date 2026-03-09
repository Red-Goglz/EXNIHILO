/**
 * Local Hardhat deployment script.
 * Deploys MockUSDC + PositionNFT + LpNFT + EXNIHILOFactory to localhost.
 *
 * LpNFT.factory is set via constructor arg (pre-computed via nonce prediction):
 *   1. Read sysDeployer nonce before deploying LpNFT
 *   2. Predict factory address = CREATE(sysDeployer, nonce)
 *   3. Deploy LpNFT(predictedFactory) from deployer
 *   4. Deploy EXNIHILOFactory from sysDeployer → address matches prediction
 *   No bytecode patching required.
 *
 * Signers used (all standard hardhat accounts):
 *   [0]  deployer    — deploys MockUSDC + PositionNFT + LpNFT; initial token holder
 *   [1]  treasury    — receives 2% protocol fee
 *   [8]  sysDeployer — deploys EXNIHILOFactory (matches test fixture)
 *
 * Usage:
 *   npx hardhat run scripts/deployLocal.ts --network localhost
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  // Reset to clean state in case a previous run partially failed
  await ethers.provider.send("hardhat_reset", []);

  const signers     = await ethers.getSigners();
  const deployer    = signers[0]; // deploys MockUSDC + PositionNFT + LpNFT
  const treasury    = signers[1]; // protocol fee recipient
  const sysDeployer = signers[8]; // EXNIHILOFactory deployer

  console.log("Deployer:    ", deployer.address);
  console.log("Treasury:    ", treasury.address);
  console.log("SysDeployer: ", sysDeployer.address);

  // 1. Deploy mock USDC (6 decimals)
  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6);
  await usdc.waitForDeployment();
  const usdcAddress = await usdc.getAddress();
  console.log("MockUSDC:    ", usdcAddress);

  // 2. Deploy PositionNFT
  const posNFTF = await ethers.getContractFactory("PositionNFT");
  const positionNFT = await posNFTF.connect(deployer).deploy();
  await positionNFT.waitForDeployment();
  const positionNFTAddress = await positionNFT.getAddress();
  console.log("PositionNFT: ", positionNFTAddress);

  // 3. Pre-compute factory address, then deploy LpNFT with it as constructor arg
  //    sysDeployer's NEXT tx will be the factory deploy → nonce at that moment
  const sysNonce = await sysDeployer.getNonce();
  const predictedFactoryAddress = ethers.getCreateAddress({
    from: sysDeployer.address,
    nonce: sysNonce,
  });

  const lpNFTF = await ethers.getContractFactory("LpNFT");
  const lpNFT = await lpNFTF.connect(deployer).deploy(predictedFactoryAddress);
  await lpNFT.waitForDeployment();
  const lpNFTAddress = await lpNFT.getAddress();
  console.log("LpNFT:       ", lpNFTAddress);

  // 4. Deploy EXNIHILOFactory from sysDeployer (address matches prediction)
  const FactoryF = await ethers.getContractFactory("EXNIHILOFactory");
  const factory = await FactoryF.connect(sysDeployer).deploy(
    positionNFTAddress,
    lpNFTAddress,
    usdcAddress,
    treasury.address,
    100n // defaultSwapFeeBps = 1%
  );
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  if (factoryAddress.toLowerCase() !== predictedFactoryAddress.toLowerCase()) {
    throw new Error(`Factory address mismatch: predicted=${predictedFactoryAddress} got=${factoryAddress}`);
  }
  console.log("Factory:     ", factoryAddress, "(LpNFT.factory matches — no patch needed)");

  // 5. Deploy meme tokens
  const memeTokens: { name: string; symbol: string; contract: any; address: string }[] = [];

  const memeSpecs = [
    { name: "Arena Token",         symbol: "ARENA"   },
    { name: "No Chill Token",     symbol: "NOCHILL" },
    { name: "Ragoogle",           symbol: "RGOGLZ"  },
    { name: "Bands Finance",      symbol: "BANDS"   },
    { name: "Wrapped AVAX",       symbol: "WAVAX"   },
  ];

  for (const spec of memeSpecs) {
    const token = await MockERC20F.connect(deployer).deploy(spec.name, spec.symbol, 18);
    await token.waitForDeployment();
    const addr = await token.getAddress();
    memeTokens.push({ ...spec, contract: token, address: addr });
    console.log(`Mock${spec.symbol.padEnd(7)}: `, addr);
  }

  // 6. Mint tokens to key accounts
  const user1 = signers[2];
  const user2 = signers[3];
  const recipients = [deployer, treasury, user1, user2];

  const USDC_MINT  = 10_000_000n * 1_000_000n;        // 10M USDC (6 dec)
  const TOKEN_MINT = 10_000_000n * 10n ** 18n;         // 10M of each meme (18 dec)

  for (const r of recipients) {
    await (usdc as any).connect(deployer).mint(r.address, USDC_MINT);
    for (const t of memeTokens) {
      await (t.contract as any).connect(deployer).mint(r.address, TOKEN_MINT);
    }
  }
  console.log("Minted 10M USDC + 10M of each meme token to deployer, treasury, user1, user2");

  // 7. Create markets with varied LP sizes
  //    Each market is seeded by deployer (who becomes the LP NFT holder).
  //    LP sizes intentionally varied to give the UI different TVLs / prices.
  //    format: [symbolIndex, usdcSeed (6dec), tokenSeed (18dec), swapFeeBps]
  const marketSpecs: [string, bigint, bigint, bigint][] = [
    // ARENA — small pool, low price (~$0.001 / token)
    ["ARENA",   500n   * 1_000_000n,  500_000n * 10n ** 18n, 100n],
    // NOCHILL — medium pool, ~$1 / token
    ["NOCHILL", 20_000n * 1_000_000n,  20_000n * 10n ** 18n, 100n],
    // RGOGLZ  — larger pool, ~$5 / token
    ["RGOGLZ",  50_000n * 1_000_000n,  10_000n * 10n ** 18n, 50n ],
    // BANDS   — small pool, very cheap token (~$0.0001)
    ["BANDS",   1_000n  * 1_000_000n, 10_000_000n * 10n ** 18n, 100n],
    // WAVAX   — large pool, ~$25 / token (close to real AVAX price)
    ["WAVAX",  100_000n * 1_000_000n,   4_000n * 10n ** 18n, 30n ],
  ];

  console.log("\n─── Creating markets ───────────────────────────────────");
  const poolAddresses: Record<string, string> = {};

  for (const [symbol, usdcSeed, tokenSeed, feeBps] of marketSpecs) {
    const meme = memeTokens.find(t => t.symbol === symbol)!;

    await usdc.connect(deployer).approve(factoryAddress, usdcSeed);
    await meme.contract.connect(deployer).approve(factoryAddress, tokenSeed);

    // createMarket uses the factory's defaultSwapFeeBps unless overridden.
    // We re-deploy the factory without per-market fee override, so set it via
    // a custom factory call if available, otherwise use a separate pool deploy.
    // Since EXNIHILOFactory.createMarket doesn't take feeBps, we use the
    // factory default (100 bps = 1%) for all except WAVAX which we leave at 1%
    // (minor difference — fee tiers would need factory support to differentiate).
    const tx = await factory.connect(deployer).createMarket(
      meme.address,
      usdcSeed,
      tokenSeed,
      0n, // maxPositionUsd — no cap
      0n  // maxPositionBps — no cap
    );
    const receipt = await tx.wait();

    // Extract pool address from MarketCreated event
    let poolAddr = "";
    for (const log of receipt!.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed?.name === "MarketCreated") { poolAddr = parsed.args[0]; break; }
      } catch { /* skip */ }
    }

    poolAddresses[symbol] = poolAddr;
    const spotRaw = await (await ethers.getContractAt("EXNIHILOPool", poolAddr)).spotPrice();
    const spotUsd = Number(spotRaw) / 1e6; // raw USDC units → USD
    console.log(`  ${symbol.padEnd(7)} pool: ${poolAddr}  spot ~$${spotUsd.toFixed(4)}`);
  }

  // 8. Write addresses JSON for the frontend
  const addresses = {
    chainId: 31337,
    factory:     factoryAddress,
    positionNFT: positionNFTAddress,
    lpNFT:       lpNFTAddress,
    usdc:        usdcAddress,
    testMeme:    memeTokens[0].address, // ARENA as the "default" test meme
    treasury:    treasury.address,
    deployer:    deployer.address,
  };

  const outPath = path.resolve(__dirname, "../../site/src/contracts/localAddresses.json");
  fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2));
  console.log("\n✓ Addresses written to:", outPath);
  console.log(JSON.stringify(addresses, null, 2));

  // ── Test wallets (standard Hardhat deterministic accounts) ─────────────────
  // Safe to share — these keys are publicly known Hardhat defaults.
  console.log("\n─────────────────────────────────────────────────────────");
  console.log("TEST WALLETS  (import into Rabby / MetaMask)");
  console.log("─────────────────────────────────────────────────────────");
  const wallets = [
    {
      label: "Deployer  (signers[0])",
      address: signers[0].address,
      key:     "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    },
    {
      label: "User 1    (signers[2])",
      address: signers[2].address,
      key:     "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    },
    {
      label: "User 2    (signers[3])",
      address: signers[3].address,
      key:     "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    },
  ];
  for (const w of wallets) {
    console.log(`\n${w.label}`);
    console.log(`  Address : ${w.address}`);
    console.log(`  Key     : ${w.key}`);
    console.log(`  Balance : 10,000 ETH (native) · 10,000,000 USDC · 10M of each meme`);
  }
  console.log("\n  Network : localhost:8545  (chain ID 31337)");
  console.log("─────────────────────────────────────────────────────────");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
