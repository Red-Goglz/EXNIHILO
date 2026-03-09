import { ethers } from "hardhat";

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const treasury = signers[1];
  const sysDeployer = signers[9];

  // Deploy prerequisites using signers[0]
  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const memeToken = await MockERC20F.connect(deployer).deploy("PEPE", "PEPE", 18);
  const usdc = await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6);
  const positionNFT = await (await ethers.getContractFactory("PositionNFT")).connect(deployer).deploy();

  const sysNonce = await ethers.provider.getTransactionCount(sysDeployer.address);
  const predictedFactoryAddr = ethers.getCreateAddress({
    from: sysDeployer.address,
    nonce: sysNonce,
  });

  // Deploy LpNFT from impersonated factory address
  await ethers.provider.send("hardhat_impersonateAccount", [predictedFactoryAddr]);
  await ethers.provider.send("hardhat_setBalance", [
    predictedFactoryAddr,
    "0x" + (10n ** 18n * 10n).toString(16),
  ]);
  const factorySigner = await ethers.getSigner(predictedFactoryAddr);
  const lpNft = await (await ethers.getContractFactory("LpNFT")).connect(factorySigner).deploy();
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [predictedFactoryAddr]);

  // Try deploying just the ReentrancyGuard pattern to see if it works
  // Actually, let's try bypassing the issue by deploying from deployer first to see if it's a sysDeployer-specific issue
  const FactoryF = await ethers.getContractFactory("EXNIHILOFactory");

  const constructorArgs: [string, string, string, string, bigint] = [
    await positionNFT.getAddress(),
    await lpNft.getAddress(),
    await usdc.getAddress(),
    treasury.address,
    100n,
  ];

  // Try from deployer (signers[0]) instead of sysDeployer to isolate if it's signer-related
  console.log("Trying factory deploy from deployer (not sysDeployer)...");
  try {
    const factory = await FactoryF.connect(deployer).deploy(...constructorArgs);
    await factory.waitForDeployment();
    console.log("SUCCESS from deployer! Factory at:", await factory.getAddress());
  } catch (e: any) {
    console.log("FAILED from deployer:", e.message.substring(0, 200));
  }

  // Try a minimal contract to verify sysDeployer can deploy anything
  console.log("\nTrying to deploy PositionNFT from sysDeployer (simpler contract)...");
  try {
    const pNFT = await (await ethers.getContractFactory("PositionNFT")).connect(sysDeployer).deploy();
    await pNFT.waitForDeployment();
    console.log("PositionNFT from sysDeployer: SUCCESS at", await pNFT.getAddress());
  } catch (e: any) {
    console.log("PositionNFT from sysDeployer FAILED:", e.message.substring(0, 200));
  }

  // Check sysDeployer balance
  const sysBalance = await ethers.provider.getBalance(sysDeployer.address);
  console.log("\nsysDeployer balance:", ethers.formatEther(sysBalance), "ETH");
}

main().catch(console.error);
