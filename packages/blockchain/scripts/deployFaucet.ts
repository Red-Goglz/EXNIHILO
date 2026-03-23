/**
 * Deploy the testnet Faucet contract to Fuji.
 *
 * Usage:
 *   npx hardhat run scripts/deployFaucet.ts --network avalancheFujiTestnet
 */
import { ethers } from "hardhat";

const USDC_ADDRESS = "0x3b1afaC2D81af169c7D0B1a99dfEA7bb1C9Cc25e";
// Seed the faucet with 1 AVAX for initial claims
const SEED_AVAX = ethers.parseEther("1.0");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const Faucet = await ethers.getContractFactory("Faucet");
  const faucet = await Faucet.deploy(USDC_ADDRESS);
  await faucet.waitForDeployment();
  const addr = await faucet.getAddress();
  console.log("Faucet:  ", addr);

  // Seed with AVAX
  const tx = await deployer.sendTransaction({ to: addr, value: SEED_AVAX });
  await tx.wait();
  console.log(`Seeded:   ${ethers.formatEther(SEED_AVAX)} AVAX`);

  console.log(`\nVerify:\n  npx hardhat verify --network avalancheFujiTestnet ${addr} "${USDC_ADDRESS}"`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
