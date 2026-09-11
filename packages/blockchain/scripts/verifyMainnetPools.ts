/**
 * Verifies every EXNIHILOPool on Snowtrace (Routescan).
 *
 * Pools are deployed by PoolDeployer from inside `createMarket`, so they are
 * never verified as a side effect of a deploy script — each one has to be
 * submitted after the fact. The factory's `allPools[]` is the registry, so the
 * list needs no JSON file and picks up permissionless markets automatically
 * (unlike scripts/verifyPools.ts, which reads the seeded Fuji pool map).
 *
 * Usage:
 *   npx hardhat run scripts/verifyMainnetPools.ts --network avalanche
 *   POOLS=0xabc...,0xdef... npx hardhat run scripts/verifyMainnetPools.ts --network avalanche
 *
 * No API key is needed — Routescan verifies without one (see hardhat.config.ts).
 */
import { ethers, run, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function poolList(chainId: number): Promise<string[]> {
  if (process.env.POOLS) {
    return process.env.POOLS.split(",").map((s) => s.trim()).filter(Boolean);
  }

  const file = chainId === 43114 ? "mainnetAddresses.json" : "fujiAddresses.json";
  const json = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../../site/src/contracts/${file}`), "utf-8"),
  );

  const factory = await ethers.getContractAt("EXNIHILOFactory", json.factory);
  const n = await factory.allPoolsLength();
  console.log(`factory ${json.factory} → ${n} pool(s)`);

  const pools: string[] = [];
  for (let i = 0n; i < n; i++) pools.push(await factory.allPools(i));
  return pools;
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  console.log(`network ${network.name} (chain ${chainId})\n`);

  const pools = await poolList(chainId);
  let ok = 0;
  let failed = 0;

  for (const poolAddr of pools) {
    const pool = await ethers.getContractAt("EXNIHILOPool", poolAddr);

    // Exactly the constructor's parameter list, in order. Every one of them is
    // immutable, so reading current state cannot disagree with what the pool
    // was constructed with. The caps and the duration used to be arguments and
    // are not any more — the automatic ramp replaced them, swapFeeBps became a
    // constant, and this script read all three off the pool until they stopped
    // existing, at which point it could not verify anything at all.
    const [
      underlyingToken,
      underlyingUsdc,
      tokenDecimals,
      positionNFT,
      lpNftContract,
      lpNftId,
      protocolTreasury,
      factoryAddr,
    ] = await Promise.all([
      pool.underlyingToken(),
      pool.underlyingUsdc(),
      pool.tokenDecimals(),
      pool.positionNFT(),
      pool.lpNftContract(),
      pool.lpNftId(),
      pool.protocolTreasury(),
      pool.factory(),
    ]);

    let symbol = "?";
    try {
      symbol = await (await ethers.getContractAt("IERC20Metadata", underlyingToken)).symbol();
    } catch { /* non-standard token — address is enough */ }

    console.log(`── ${symbol} ${poolAddr} ──`);

    try {
      await run("verify:verify", {
        address: poolAddr,
        contract: "contracts/EXNIHILOPool.sol:EXNIHILOPool",
        constructorArguments: [
          underlyingToken,
          underlyingUsdc,
          tokenDecimals,
          positionNFT,
          lpNftContract,
          lpNftId,
          protocolTreasury,
          factoryAddr,
        ],
      });
      console.log(`   ✓ verified\n`);
      ok++;
    } catch (e: any) {
      if (/already been verified|already verified/i.test(e.message ?? "")) {
        console.log(`   ✓ already verified\n`);
        ok++;
      } else {
        console.error(`   ✗ ${e.message}\n`);
        failed++;
      }
    }
  }

  console.log(`Done — ${ok} verified, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
