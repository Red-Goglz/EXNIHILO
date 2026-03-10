import { ethers } from "hardhat";

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const treasury = signers[1];
  const sysDeployer = signers[9];

  // Deploy prerequisites
  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const baseToken = await MockERC20F.connect(deployer).deploy("PEPE", "PEPE", 18);
  const usdc = await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6);
  const positionNFT = await (await ethers.getContractFactory("PositionNFT")).connect(deployer).deploy();

  const sysNonce = await ethers.provider.getTransactionCount(sysDeployer.address);
  console.log("sysDeployer nonce:", sysNonce);

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

  console.log("LpNFT deployed:", await lpNft.getAddress());
  console.log("LpNFT.factory:", await lpNft.factory());

  const FactoryF = await ethers.getContractFactory("EXNIHILOFactory");

  const constructorArgs: [string, string, string, string, bigint] = [
    await positionNFT.getAddress(),
    await lpNft.getAddress(),
    await usdc.getAddress(),
    treasury.address,
    100n,
  ];

  console.log("Constructor args:", constructorArgs);

  // Try eth_estimateGas first
  try {
    const deployTx = await FactoryF.getDeployTransaction(...constructorArgs);
    const gasEst = await ethers.provider.estimateGas({
      from: sysDeployer.address,
      data: deployTx.data,
    });
    console.log("Gas estimate for factory deploy:", gasEst.toString());
  } catch (e: any) {
    console.log("Gas estimation FAILED:", e.message);

    // Try eth_call to get revert reason
    try {
      const deployTx = await FactoryF.getDeployTransaction(...constructorArgs);
      const result = await ethers.provider.call({
        from: sysDeployer.address,
        data: deployTx.data,
      });
      console.log("eth_call result:", result);
    } catch (e2: any) {
      console.log("eth_call FAILED:", e2.message);
    }
  }

  // Also check block gas limit
  const block = await ethers.provider.getBlock("latest");
  console.log("Block gas limit:", block?.gasLimit?.toString());
}

main().catch(console.error);
