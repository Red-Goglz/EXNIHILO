/**
 * Reads constructor args from on-chain pool immutables and verifies each pool on Snowtrace.
 *
 * Usage:
 *   npx hardhat run scripts/verifyPools.ts --network avalancheFujiTestnet
 */
import { ethers, run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const json = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "../../site/src/contracts/fujiAddresses.json"),
      "utf-8"
    )
  );

  const poolEntries = Object.entries(json.pools) as [string, string][];

  for (const [symbol, poolAddr] of poolEntries) {
    console.log(`\n── Verifying ${symbol} pool: ${poolAddr} ──`);

    const pool = await ethers.getContractAt("EXNIHILOPool", poolAddr);

    const [
      airToken,
      airUsdToken,
      underlyingToken,
      underlyingUsdc,
      positionNFT,
      lpNftContract,
      lpNftId,
      protocolTreasury,
      maxPositionUsd,
      maxPositionBps,
      swapFeeBps,
    ] = await Promise.all([
      pool.airToken(),
      pool.airUsdToken(),
      pool.underlyingToken(),
      pool.underlyingUsdc(),
      pool.positionNFT(),
      pool.lpNftContract(),
      pool.lpNftId(),
      pool.protocolTreasury(),
      pool.maxPositionUsd(),
      pool.maxPositionBps(),
      pool.swapFeeBps(),
    ]);

    try {
      await run("verify:verify", {
        address: poolAddr,
        constructorArguments: [
          airToken,
          airUsdToken,
          underlyingToken,
          underlyingUsdc,
          positionNFT,
          lpNftContract,
          lpNftId,
          protocolTreasury,
          maxPositionUsd,
          maxPositionBps,
          swapFeeBps,
        ],
      });
      console.log(`  ✓ ${symbol} verified`);
    } catch (e: any) {
      if (e.message?.includes("already been verified")) {
        console.log(`  ✓ ${symbol} already verified`);
      } else {
        console.error(`  ✗ ${symbol}:`, e.message);
      }
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
