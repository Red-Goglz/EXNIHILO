import { ethers } from "hardhat";

async function main() {
  const factoryAddr = "0x95bD8D42f30351685e96C62EDdc0d0613bf9a87A";
  const factory = await ethers.getContractAt("EXNIHILOFactory", factoryAddr);
  const poolAddr = await factory.allPools(0);
  const pool = await ethers.getContractAt("EXNIHILOPool", poolAddr);

  const swaps = await pool.queryFilter(pool.filters.Swap(), 0);
  console.log(`\n=== Swaps raw ===`);
  for (const e of swaps) {
    console.log(`  block=${e.blockNumber}  memeToUsdc=${e.args.memeToUsdc}  amountIn(raw)=${e.args.amountIn}  amountOut(raw)=${e.args.amountOut}`);
  }

  const longs = await pool.queryFilter(pool.filters.LongOpened(), 0);
  console.log(`\n=== LongOpened raw ===`);
  for (const e of longs) {
    console.log(`  args:`, Object.fromEntries(Object.entries(e.args).filter(([k]) => isNaN(Number(k)))));
  }

  const closes = await pool.queryFilter(pool.filters.LongClosed(), 0);
  console.log(`\n=== LongClosed raw ===`);
  for (const e of closes) {
    console.log(`  args:`, Object.fromEntries(Object.entries(e.args).filter(([k]) => isNaN(Number(k)))));
  }
}
main().catch(console.error);
