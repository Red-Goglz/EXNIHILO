import { ethers } from "hardhat";

async function main() {
  const factoryAddr = "0x95bD8D42f30351685e96C62EDdc0d0613bf9a87A";
  const factory = await ethers.getContractAt("EXNIHILOFactory", factoryAddr);
  const poolAddr = await factory.allPools(0);
  const pool = await ethers.getContractAt("EXNIHILOPool", poolAddr);

  // Swap events — determine direction from raw amounts
  const swaps = await pool.queryFilter(pool.filters.Swap(), 0);
  console.log(`=== Swaps ===`);
  for (const e of swaps) {
    const inRaw = e.args.amountIn as bigint;
    const outRaw = e.args.amountOut as bigint;
    const mtou = e.args.memeToUsdc as boolean;
    if (mtou) {
      console.log(`  block ${e.blockNumber}: PEPE→USDC  in=${ethers.formatUnits(inRaw, 18)} PEPE  out=${ethers.formatUnits(outRaw, 6)} USDC`);
    } else {
      console.log(`  block ${e.blockNumber}: USDC→PEPE  in=${ethers.formatUnits(inRaw, 6)} USDC  out=${ethers.formatUnits(outRaw, 18)} PEPE`);
    }
  }

  const longs = await pool.queryFilter(pool.filters.LongOpened(), 0);
  console.log(`\n=== LongOpened ===`);
  for (const e of longs) {
    console.log(`  block ${e.blockNumber}: nftId=${e.args.nftId}  usdcFee=${ethers.formatUnits(e.args.usdcFee ?? e.args[2], 6)} USDC  locked=${ethers.formatUnits(e.args.lockedAirMeme ?? e.args[3], 18)} airMeme`);
  }

  const closes = await pool.queryFilter(pool.filters.LongClosed(), 0);
  console.log(`\n=== LongClosed ===`);
  for (const e of closes) {
    console.log(`  block ${e.blockNumber}: nftId=${e.args.nftId}  usdcReturned=${ethers.formatUnits(e.args.usdcReturned ?? e.args[2], 6)} USDC`);
  }
}
main().catch(console.error);
