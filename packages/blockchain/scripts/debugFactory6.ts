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

  const USDC_INITIAL = 10_000n * 10n**6n;   // 10,000 USDC
  const TOKEN_INITIAL = 1_000_000n * 10n**18n; // 1M base tokens

  // Deploy tokens
  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const baseToken = await MockERC20F.connect(deployer).deploy("PEPE", "PEPE", 18);
  const usdc = await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6);
  await baseToken.mint(deployer.address, TOKEN_INITIAL * 10n);
  await usdc.mint(deployer.address, USDC_INITIAL * 10n);

  // Deploy PositionNFT
  const positionNFT = await (await ethers.getContractFactory("PositionNFT")).connect(deployer).deploy();

  // Deploy LpNFT from throwaway
  const lpNft = await (await ethers.getContractFactory("LpNFT")).connect(throwaway).deploy();
  await lpNft.waitForDeployment();

  // Deploy factory from sysDeployer
  const FactoryF = await ethers.getContractFactory("EXNIHILOFactory");
  const factory = await FactoryF.connect(sysDeployer).deploy(
    await positionNFT.getAddress(),
    await lpNft.getAddress(),
    await usdc.getAddress(),
    treasury.address,
    100n
  );
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();

  // Patch LpNFT
  await patchImmutableAddress(await lpNft.getAddress(), throwaway.address, factoryAddr);
  console.log("LpNFT.factory after patch:", await lpNft.factory());
  console.log("Factory address:          ", factoryAddr);
  console.log("Match:", (await lpNft.factory()).toLowerCase() === factoryAddr.toLowerCase());

  // Approve factory to pull tokens
  await baseToken.connect(deployer).approve(factoryAddr, TOKEN_INITIAL);
  await usdc.connect(deployer).approve(factoryAddr, USDC_INITIAL);

  // Call createMarket
  console.log("\nCalling createMarket...");
  const tx = await factory.connect(deployer).createMarket(
    await baseToken.getAddress(),
    USDC_INITIAL,
    TOKEN_INITIAL,
    0n, // no position cap
    0n  // no bps cap
  );
  const receipt = await tx.wait();
  console.log("createMarket succeeded! Gas used:", receipt?.gasUsed.toString());

  // Check state
  console.log("allPoolsLength:", (await factory.allPoolsLength()).toString());
  const poolAddr = await factory.allPools(0);
  console.log("Pool[0]:", poolAddr);
  console.log("isPool:", await factory.isPool(poolAddr));

  // Check LP NFT was transferred to deployer
  const lpOwner = await lpNft.ownerOf(0);
  console.log("LP NFT owner:", lpOwner);
  console.log("Expected:    ", deployer.address);
  console.log("Match:", lpOwner.toLowerCase() === deployer.address.toLowerCase());
}

main().catch(console.error);
