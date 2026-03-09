import { ethers } from "hardhat";

async function main() {
  const factoryAddr = "0x95bD8D42f30351685e96C62EDdc0d0613bf9a87A";
  const factory = await ethers.getContractAt("EXNIHILOFactory", factoryAddr);
  const poolAddr = await factory.allPools(0);
  const pool = await ethers.getContractAt("EXNIHILOPool", poolAddr);

  const swaps = await pool.queryFilter(pool.filters.Swap(), 0);
  console.log(`\n=== Swaps (${swaps.length}) ===`);
  for (const e of swaps) {
    const { amountIn, amountOut, memeToUsdc } = e.args;
    if (memeToUsdc) {
      console.log(`  PEPE→USDC  in=${ethers.formatUnits(amountIn, 18)} PEPE  out=${ethers.formatUnits(amountOut, 6)} USDC  (block ${e.blockNumber})`);
    } else {
      console.log(`  USDC→PEPE  in=${ethers.formatUnits(amountIn, 6)} USDC  out=${ethers.formatUnits(amountOut, 18)} PEPE  (block ${e.blockNumber})`);
    }
  }

  const longs = await pool.queryFilter(pool.filters.LongOpened(), 0);
  console.log(`\n=== LongOpened (${longs.length}) ===`);
  for (const e of longs) {
    const { nftId, usdcFee, lockedAirMeme } = e.args;
    console.log(`  nftId=${nftId}  fee=${ethers.formatUnits(usdcFee, 6)} USDC  locked=${ethers.formatUnits(lockedAirMeme, 18)} airMeme`);
  }

  const closes = await pool.queryFilter(pool.filters.LongClosed(), 0);
  console.log(`\n=== LongClosed (${closes.length}) ===`);
  for (const e of closes) {
    const { nftId, usdcReturned } = e.args;
    console.log(`  nftId=${nftId}  usdcReturned=${ethers.formatUnits(usdcReturned, 6)} USDC`);
  }
}
main().catch(console.error);
