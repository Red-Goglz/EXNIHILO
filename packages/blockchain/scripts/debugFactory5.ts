import { ethers } from "hardhat";

async function patchImmutableAddress(
  contractAddress: string,
  fromAddress: string,
  toAddress: string
): Promise<void> {
  const bytecode = await ethers.provider.getCode(contractAddress);
  const raw = bytecode.slice(2).toLowerCase();
  const fromPadded = "000000000000000000000000" + fromAddress.toLowerCase().slice(2);
  const toPadded   = "000000000000000000000000" + toAddress.toLowerCase().slice(2);

  console.log("fromPadded:", fromPadded);
  console.log("toPadded:  ", toPadded);
  console.log("Found in bytecode:", raw.includes(fromPadded));

  if (!raw.includes(fromPadded)) {
    throw new Error(`Address ${fromAddress} not found in bytecode of ${contractAddress}`);
  }

  const patched = raw.split(fromPadded).join(toPadded);
  await ethers.provider.send("hardhat_setCode", [contractAddress, "0x" + patched]);
}

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const treasury = signers[1];
  const throwaway = signers[7];
  const sysDeployer = signers[8];

  console.log("deployer:", deployer.address);
  console.log("throwaway:", throwaway.address);
  console.log("sysDeployer:", sysDeployer.address);

  // Deploy prerequisites
  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6);
  const positionNFT = await (await ethers.getContractFactory("PositionNFT")).connect(deployer).deploy();

  // Deploy LpNFT from throwaway
  const lpNft = await (await ethers.getContractFactory("LpNFT")).connect(throwaway).deploy();
  await lpNft.waitForDeployment();
  const lpNftAddr = await lpNft.getAddress();
  console.log("\nLpNFT deployed at:", lpNftAddr);
  console.log("LpNFT.factory (before patch):", await lpNft.factory());

  // Deploy factory from sysDeployer
  const FactoryF = await ethers.getContractFactory("EXNIHILOFactory");
  const factory = await FactoryF.connect(sysDeployer).deploy(
    await positionNFT.getAddress(),
    lpNftAddr,
    await usdc.getAddress(),
    treasury.address,
    100n
  );
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("\nFactory deployed at:", factoryAddr);

  // Patch LpNFT bytecode
  console.log("\nPatching LpNFT bytecode...");
  await patchImmutableAddress(lpNftAddr, throwaway.address, factoryAddr);

  // Verify
  const patchedFactory = await lpNft.factory();
  console.log("\nLpNFT.factory (after patch):", patchedFactory);
  console.log("Factory address:            ", factoryAddr);
  console.log("Match:", patchedFactory.toLowerCase() === factoryAddr.toLowerCase());
}

main().catch(console.error);
