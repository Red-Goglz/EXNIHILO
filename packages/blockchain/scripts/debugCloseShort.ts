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
  if (!raw.includes(fromPadded)) throw new Error("not found");
  const patched = raw.split(fromPadded).join(toPadded);
  await ethers.provider.send("hardhat_setCode", [contractAddress, "0x" + patched]);
}

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const treasury = signers[1];
  const throwaway = signers[7];
  const sysDeployer = signers[8];
  const trader1 = signers[3];
  const trader2 = signers[4];

  const USDC = 10_000n * 10n**6n;
  const TOKEN = 1_000_000n * 10n**18n;

  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const baseToken = await MockERC20F.connect(deployer).deploy("PEPE", "PEPE", 18);
  const usdc = await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6);
  const positionNFT = await (await ethers.getContractFactory("PositionNFT")).connect(deployer).deploy();

  const lpNft = await (await ethers.getContractFactory("LpNFT")).connect(throwaway).deploy();
  const factory = await (await ethers.getContractFactory("EXNIHILOFactory"))
    .connect(sysDeployer)
    .deploy(await positionNFT.getAddress(), await lpNft.getAddress(), await usdc.getAddress(), treasury.address, 100n);

  await patchImmutableAddress(await lpNft.getAddress(), throwaway.address, await factory.getAddress());

  await baseToken.mint(deployer.address, TOKEN);
  await usdc.mint(deployer.address, USDC);
  await baseToken.connect(deployer).approve(await factory.getAddress(), ethers.MaxUint256);
  await usdc.connect(deployer).approve(await factory.getAddress(), ethers.MaxUint256);

  const tx = await factory.connect(deployer).createMarket(await baseToken.getAddress(), USDC, TOKEN, 0n, 0n);
  const receipt = await tx.wait();
  const log = receipt!.logs.map(l => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(l => l?.name === "MarketCreated")!;
  const poolAddr = log.args.pool;
  const pool = await ethers.getContractAt("EXNIHILOPool", poolAddr);

  // Open short with 100 USDC
  await usdc.mint(trader1.address, ethers.parseUnits("100", 6));
  await usdc.connect(trader1).approve(poolAddr, ethers.MaxUint256);
  const shortTx = await pool.connect(trader1).openShort(ethers.parseUnits("100", 6), 0n);
  const shortReceipt = await shortTx.wait();
  const shortLog = shortReceipt!.logs.map(l => { try { return pool.interface.parseLog(l); } catch { return null; } }).find(l => l?.name === "ShortOpened")!;
  const nftId = shortLog.args.nftId;
  console.log("Short opened. nftId:", nftId);
  console.log("  airTokenMinted:", shortLog.args.airTokenMinted.toString());
  console.log("  airUsdLocked:", shortLog.args.airUsdLocked.toString());

  const pos = await positionNFT.getPosition(nftId);
  console.log("Position airTokenMinted:", pos.airTokenMinted.toString());
  console.log("Position lockedAmount (airUsd):", pos.lockedAmount.toString());

  const airUsdAddr = await pool.airUsdToken();
  const airUsd = await ethers.getContractAt("AirToken", airUsdAddr);
  const airTokenAddr = await pool.airToken();
  const airToken = await ethers.getContractAt("AirToken", airTokenAddr);

  console.log("airUsd.totalSupply():", (await airUsd.totalSupply()).toString());
  console.log("airToken.totalSupply():", (await airToken.totalSupply()).toString());
  console.log("backedAirToken:", (await pool.backedAirToken()).toString());
  console.log("backedAirUsd:", (await pool.backedAirUsd()).toString());

  // Try to close without dump
  console.log("\nTrying closeShort without price action...");
  try {
    await pool.connect(trader1).closeShort(nftId, 0n);
    console.log("Succeeded (unexpected)");
  } catch (e: any) {
    console.log("Failed:", e.message.substring(0, 80));
  }

  // Now dump massively
  const bigDump = ethers.parseEther("900000"); // 900k tokens
  await baseToken.mint(trader2.address, bigDump);
  await baseToken.connect(trader2).approve(poolAddr, ethers.MaxUint256);
  await pool.connect(trader2).swap(bigDump, 0n, true);
  console.log("\nAfter massive dump:");
  console.log("airUsd.totalSupply():", (await airUsd.totalSupply()).toString());
  console.log("airToken.totalSupply():", (await airToken.totalSupply()).toString());
  console.log("backedAirToken:", (await pool.backedAirToken()).toString());
  console.log("backedAirUsd:", (await pool.backedAirUsd()).toString());

  // Try to close after dump
  console.log("\nTrying closeShort after massive dump...");
  try {
    await pool.connect(trader1).closeShort(nftId, 0n);
    console.log("Succeeded!");
  } catch (e: any) {
    console.log("Failed:", e.message.substring(0, 80));
  }
}

main().catch(console.error);
