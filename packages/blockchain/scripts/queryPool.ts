import { ethers } from "hardhat";

async function main() {
  const factoryAddr = "0x95bD8D42f30351685e96C62EDdc0d0613bf9a87A";
  const factory = await ethers.getContractAt("EXNIHILOFactory", factoryAddr);
  const poolAddr = await factory.allPools(0);
  const pool = await ethers.getContractAt("EXNIHILOPool", poolAddr);

  // Current pool state
  const backedToken = await pool.backedAirToken();
  const backedUsd  = await pool.backedAirUsd();
  const lpFees     = await pool.lpFeesAccumulated();
  console.log(`\n=== Current Pool State ===`);
  console.log(`  backedAirToken:       ${ethers.formatUnits(backedToken, 18)} PEPE`);
  console.log(`  backedAirUsd:        ${ethers.formatUnits(backedUsd, 6)} USDC`);
  console.log(`  lpFeesAccumulated:   ${ethers.formatUnits(lpFees, 6)} USDC`);

  // Initial liquidity from MarketCreated event
  const created = await factory.queryFilter(factory.filters.MarketCreated(), 0);
  for (const e of created) {
    console.log(`\n=== MarketCreated (initial seed) ===`);
    console.log(`  usdcAmount:  ${ethers.formatUnits(e.args.usdcAmount, 6)} USDC`);
    console.log(`  tokenAmount: ${ethers.formatUnits(e.args.tokenAmount, 18)} PEPE`);
  }

  // Treasury USDC balance
  const treasuryAddr = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const usdcAddr = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  const usdc = await ethers.getContractAt("IERC20", usdcAddr);
  const treasuryBal = await usdc.balanceOf(treasuryAddr);
  console.log(`\n=== Treasury ===`);
  console.log(`  USDC balance: ${ethers.formatUnits(treasuryBal, 6)} USDC`);
}
main().catch(console.error);
