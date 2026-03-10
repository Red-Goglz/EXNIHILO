import { ethers } from "hardhat";

async function main() {
  // Simulate deployFactoryFixture setup
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const treasury = signers[1];
  const sysDeployer = signers[9];

  console.log("deployer:", deployer.address);
  console.log("sysDeployer:", sysDeployer.address);

  // These transactions happen in deployFactoryFixture before deploySystem
  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const baseToken = await MockERC20F.connect(deployer).deploy("PEPE", "PEPE", 18);
  const usdc = await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6);
  const positionNFT = await (await ethers.getContractFactory("PositionNFT")).connect(deployer).deploy();

  console.log("deployer nonce after 3 deploys:", await ethers.provider.getTransactionCount(deployer.address));

  // Now simulate deploySystem
  const sysNonce = await ethers.provider.getTransactionCount(sysDeployer.address);
  console.log("sysDeployer nonce:", sysNonce);

  const predictedFactoryAddr = ethers.getCreateAddress({
    from: sysDeployer.address,
    nonce: sysNonce,
  });
  console.log("predictedFactory:", predictedFactoryAddr);

  await ethers.provider.send("hardhat_impersonateAccount", [predictedFactoryAddr]);
  await ethers.provider.send("hardhat_setBalance", [
    predictedFactoryAddr,
    "0x" + (10n ** 18n * 10n).toString(16),
  ]);

  const factorySigner = await ethers.getSigner(predictedFactoryAddr);
  console.log("factorySigner balance:", (await ethers.provider.getBalance(predictedFactoryAddr)).toString());

  const lpNft = await (await ethers.getContractFactory("LpNFT")).connect(factorySigner).deploy();
  await lpNft.waitForDeployment();
  console.log("LpNFT deployed at:", await lpNft.getAddress());
  console.log("LpNFT factory:", await lpNft.factory());

  await ethers.provider.send("hardhat_stopImpersonatingAccount", [predictedFactoryAddr]);

  const sysNonceAfterLpNft = await ethers.provider.getTransactionCount(sysDeployer.address);
  console.log("sysDeployer nonce AFTER LpNFT deploy:", sysNonceAfterLpNft);
  // Should still be 0

  const FactoryF = await ethers.getContractFactory("EXNIHILOFactory");
  console.log("About to deploy factory from sysDeployer...");

  const factory = await FactoryF.connect(sysDeployer).deploy(
    await positionNFT.getAddress(),
    await lpNft.getAddress(),
    await usdc.getAddress(),
    treasury.address,
    100n
  );
  await factory.waitForDeployment();

  const actualAddr = await factory.getAddress();
  console.log("Factory deployed at:", actualAddr);
  console.log("Predicted addr:     ", predictedFactoryAddr);
  console.log("Match:", actualAddr.toLowerCase() === predictedFactoryAddr.toLowerCase());
}

main().catch(console.error);
