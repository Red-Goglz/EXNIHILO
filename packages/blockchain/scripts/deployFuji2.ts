/**
 * Continuation script — creates remaining markets on already-deployed Fuji contracts.
 * ARENA pool already exists from the first deploy run.
 *
 * Usage:
 *   npx hardhat run scripts/deployFuji2.ts --network avalancheFujiTestnet
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Addresses from the first deploy run
const DEPLOYED = {
  usdc:        "0x3b1afaC2D81af169c7D0B1a99dfEA7bb1C9Cc25e",
  positionNFT: "0xCabe1eaCFFbC617608f75A03FADC9D829a3715fc",
  lpNFT:       "0xF298744Ef968E31d5d3D65Ae2C9EB7A641e02f6d",
  factory:     "0x13b436a263F9d9b6ff1945961C5C960c8ae98614",
  tokens: {
    ARENA:   "0x25C612bd8512A4E06B67C19FCEd924891C0605e1",
    NOCHILL: "0xb9548be3143cc98aCB546194Fa4b593d13265cDc",
    RGOGLZ:  "0xde2E572A517cC85B80C846B42fb87c15021177c5",
    BANDS:   "0x0354F80EbB061B0A71a12f9E9e94be665308309b",
    WAVAX:   "0xCEfCD18596Eb7032b3af631632821A1aceb266ef",
  },
  pools: {
    ARENA: "0x4f043745faaB52C400bbF6D0E236c5c0212E852a",
  },
};

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const factory = await ethers.getContractAt("EXNIHILOFactory", DEPLOYED.factory);
  const usdc = await ethers.getContractAt("MockERC20", DEPLOYED.usdc);

  // Markets still to create
  const remaining: [string, bigint, bigint][] = [
    ["NOCHILL", 20_000n * 1_000_000n,  20_000n * 10n ** 18n],
    ["RGOGLZ",  50_000n * 1_000_000n,  10_000n * 10n ** 18n],
    ["BANDS",   1_000n  * 1_000_000n, 10_000_000n * 10n ** 18n],
    ["WAVAX",  100_000n * 1_000_000n,   4_000n * 10n ** 18n],
  ];

  const poolAddresses: Record<string, string> = { ...DEPLOYED.pools };

  for (const [symbol, usdcSeed, tokenSeed] of remaining) {
    const tokenAddr = (DEPLOYED.tokens as any)[symbol];
    const token = await ethers.getContractAt("MockERC20", tokenAddr);

    console.log(`\nCreating ${symbol} market...`);
    console.log(`  Approving ${ethers.formatUnits(usdcSeed, 6)} USDC + ${ethers.formatEther(tokenSeed)} ${symbol}`);

    await (await usdc.connect(deployer).approve(DEPLOYED.factory, usdcSeed)).wait();
    await (await token.connect(deployer).approve(DEPLOYED.factory, tokenSeed)).wait();

    const tx = await factory.connect(deployer).createMarket(
      tokenAddr,
      usdcSeed,
      tokenSeed,
      0n,
      0n
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
    console.log(`  ${symbol} pool: ${poolAddr}  spot ~$${spotUsd.toFixed(4)}`);
  }

  // Write addresses JSON
  const addresses = {
    chainId: 43113,
    factory:     DEPLOYED.factory,
    positionNFT: DEPLOYED.positionNFT,
    lpNFT:       DEPLOYED.lpNFT,
    usdc:        DEPLOYED.usdc,
    testToken:   DEPLOYED.tokens.ARENA,
    treasury:    deployer.address,
    deployer:    deployer.address,
    pools:       poolAddresses,
  };

  const outPath = path.resolve(__dirname, "../../site/src/contracts/fujiAddresses.json");
  fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2));
  console.log("\n✓ Addresses written to:", outPath);
  console.log(JSON.stringify(addresses, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
