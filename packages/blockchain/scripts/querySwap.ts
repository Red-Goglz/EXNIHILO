import { ethers } from "hardhat";

async function main() {
  const factoryAddr = "0x95bD8D42f30351685e96C62EDdc0d0613bf9a87A";
  const factory = await ethers.getContractAt("EXNIHILOFactory", factoryAddr);
  const len = await factory.allPoolsLength();
  console.log(`Pools: ${len}`);

  for (let i = 0; i < Number(len); i++) {
    const poolAddr = await factory.allPools(i);
    const pool = await ethers.getContractAt("EXNIHILOPool", poolAddr);
    const filter = pool.filters.Swap();
    const events = await pool.queryFilter(filter, 0);
    if (events.length > 0) {
      console.log(`\nPool ${poolAddr} — ${events.length} Swap event(s):`);
      for (const e of events) {
        const { amountIn, amountOut, memeToUsdc } = e.args;
        if (memeToUsdc) {
          console.log(`  PEPE→USDC  amountIn=${ethers.formatUnits(amountIn, 18)} PEPE  amountOut=${ethers.formatUnits(amountOut, 6)} USDC`);
        } else {
          console.log(`  USDC→PEPE  amountIn=${ethers.formatUnits(amountIn, 6)} USDC  amountOut=${ethers.formatUnits(amountOut, 18)} PEPE`);
        }
      }
    }
  }
}
main().catch(console.error);
