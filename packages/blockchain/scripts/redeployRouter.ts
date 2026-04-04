import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer:", deployer.address, "Balance:", ethers.formatEther(balance), "AVAX");

  const factory = "0xDba4FCd283365Ecc773017c6EECbfd7525424211";
  const usdc = "0xfFE6304982d0592E19108eA2c789DAa7eEBA4e60";

  const RouterF = await ethers.getContractFactory("EXNIHILORouter");
  const router = await RouterF.connect(deployer).deploy(factory, usdc);
  await router.waitForDeployment();
  const addr = await router.getAddress();
  console.log("New Router:", addr);
  console.log(`\nVerify:\n  npx hardhat verify --network avalancheFujiTestnet ${addr} "${factory}" "${usdc}"`);
}

main().catch((err) => { console.error(err); process.exit(1); });
