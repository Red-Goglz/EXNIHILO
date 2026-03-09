import { ethers } from "hardhat";

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const treasury = signers[1];
  const sysDeployer = signers[8]; // Use signers[8] as deploy.ts does

  console.log("sysDeployer address:", sysDeployer.address);

  // Deploy prerequisites
  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const memeToken = await MockERC20F.connect(deployer).deploy("PEPE", "PEPE", 18);
  const usdc = await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6);
  const positionNFT = await (await ethers.getContractFactory("PositionNFT")).connect(deployer).deploy();

  const sysNonce = await ethers.provider.getTransactionCount(sysDeployer.address);
  console.log("sysDeployer nonce:", sysNonce);

  const predictedFactoryAddr = ethers.getCreateAddress({
    from: sysDeployer.address,
    nonce: sysNonce,
  });
  console.log("predictedFactoryAddr:", predictedFactoryAddr);

  // Check if predictedFactoryAddr already has code (shouldn't)
  const codeAtPredicted = await ethers.provider.getCode(predictedFactoryAddr);
  console.log("Code at predicted addr (before impersonation):", codeAtPredicted);

  // Deploy LpNFT from impersonated factory address
  await ethers.provider.send("hardhat_impersonateAccount", [predictedFactoryAddr]);
  await ethers.provider.send("hardhat_setBalance", [
    predictedFactoryAddr,
    "0x" + (10n ** 18n * 10n).toString(16),
  ]);
  const factorySigner = await ethers.getSigner(predictedFactoryAddr);
  const lpNft = await (await ethers.getContractFactory("LpNFT")).connect(factorySigner).deploy();
  await lpNft.waitForDeployment();
  console.log("LpNFT deployed at:", await lpNft.getAddress());
  console.log("LpNFT.factory:", await lpNft.factory());
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [predictedFactoryAddr]);

  // Check nonce AFTER impersonated deploy
  const sysNonceAfter = await ethers.provider.getTransactionCount(sysDeployer.address);
  console.log("sysDeployer nonce AFTER impersonated LpNFT deploy:", sysNonceAfter);

  // Check nonce of the predictedFactoryAddr itself
  const predictedNonce = await ethers.provider.getTransactionCount(predictedFactoryAddr);
  console.log("predictedFactoryAddr nonce AFTER impersonated LpNFT deploy:", predictedNonce);

  // Now try to deploy factory from sysDeployer
  const FactoryF = await ethers.getContractFactory("EXNIHILOFactory");
  const constructorArgs: [string, string, string, string, bigint] = [
    await positionNFT.getAddress(),
    await lpNft.getAddress(),
    await usdc.getAddress(),
    treasury.address,
    100n,
  ];

  console.log("\nDeploying factory from sysDeployer at nonce", sysNonceAfter, "...");
  try {
    const factory = await FactoryF.connect(sysDeployer).deploy(...constructorArgs);
    await factory.waitForDeployment();
    const actualAddr = await factory.getAddress();
    console.log("Factory deployed at:", actualAddr);
    console.log("Predicted:          ", predictedFactoryAddr);
    console.log("Match:", actualAddr.toLowerCase() === predictedFactoryAddr.toLowerCase());
  } catch (e: any) {
    console.log("Factory deploy FAILED:", e.message.substring(0, 300));

    // Check: does the factory address now have code? (from the impersonated LpNFT deploy?)
    const codeAtPredictedAfter = await ethers.provider.getCode(predictedFactoryAddr);
    console.log("\nCode at predictedFactoryAddr after failure:",
      codeAtPredictedAfter.length > 10 ? `${codeAtPredictedAfter.length/2} bytes` : codeAtPredictedAfter);
  }
}

main().catch(console.error);
