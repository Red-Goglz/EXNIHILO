import { ethers } from "hardhat";
async function main() {
  const factory = await ethers.getContractAt("EXNIHILOFactory", "0x95bD8D42f30351685e96C62EDdc0d0613bf9a87A");
  const len = Number(await factory.allPoolsLength());
  for (let i = 0; i < len; i++) {
    const poolAddr = await factory.allPools(i);
    const pool = await ethers.getContractAt("EXNIHILOPool", poolAddr);
    const bMeme = await pool.backedAirMeme();
    const bUsd  = await pool.backedAirUsd();
    const swaps = await pool.queryFilter(pool.filters.Swap(), 0);
    console.log(`\nPool[${i}] ${poolAddr}`);
    console.log(`  backedAirMeme: ${ethers.formatUnits(bMeme, 18)} PEPE`);
    console.log(`  backedAirUsd:  ${ethers.formatUnits(bUsd,  6)} USDC`);
    console.log(`  Swaps (${swaps.length}):`);
    for (const e of swaps) {
      const inRaw = BigInt(e.args.amountIn); const outRaw = BigInt(e.args.amountOut);
      // detect direction: if inRaw > 1e12 and outRaw < 1e12 → USDC in, PEPE out (unlikely since PEPE 18dec always large)
      // use: if inRaw divisible by 1e6 scale vs 1e18 scale — just check magnitude
      const inIsPepe = inRaw > BigInt("1000000000000"); // > 1e12 → likely 18-dec PEPE
      if (inIsPepe) {
        console.log(`    block ${e.blockNumber}: PEPE→USDC  in=${ethers.formatUnits(inRaw, 18)} PEPE  out=${ethers.formatUnits(outRaw, 6)} USDC`);
      } else {
        console.log(`    block ${e.blockNumber}: USDC→PEPE  in=${ethers.formatUnits(inRaw, 6)} USDC  out=${ethers.formatUnits(outRaw, 18)} PEPE`);
      }
    }
  }
}
main().catch(console.error);
