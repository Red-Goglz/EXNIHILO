import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { EXNIHILOPool, MockERC20 } from "../typechain-types";

/**
 * The USDC claim paths check only USDC (audit R4, NM-R4-004). A token-side
 * shortfall (seizure, negative rebase) freezes the market, but must not lock
 * USDC fees in with it; a USDC shortfall still stops a claim.
 */

const USDC = 10n ** 6n;
const TOKEN = 10n ** 18n;

async function fixture() {
  const signers = await ethers.getSigners();
  const [deployer, treasury, creator, trader] = signers;

  const M = await ethers.getContractFactory("MockERC20");
  const usdc = (await M.connect(deployer).deploy("USD Coin", "USDC", 6)) as unknown as MockERC20;
  const token = (await M.connect(deployer).deploy("Base", "BASE", 18)) as unknown as MockERC20;
  const positionNFT = await (await ethers.getContractFactory("PositionNFT")).connect(deployer).deploy();

  const sys = signers[8];
  const poolDeployer = await (await ethers.getContractFactory("PoolDeployer")).connect(sys).deploy();
  const predicted = ethers.getCreateAddress({ from: sys.address, nonce: await sys.getNonce() });
  const lpNft = await (await ethers.getContractFactory("LpNFT")).connect(deployer).deploy(predicted);
  const factory = await (await ethers.getContractFactory("EXNIHILOFactory")).connect(sys).deploy(
    await positionNFT.getAddress(), await lpNft.getAddress(), await usdc.getAddress(),
    treasury.address, await poolDeployer.getAddress(),
  );
  await positionNFT.connect(deployer).initFactory(await factory.getAddress());

  await usdc.mint(creator.address, 100_000n * USDC);
  await token.mint(creator.address, 100_000n * TOKEN);
  await usdc.connect(creator).approve(await factory.getAddress(), 100_000n * USDC);
  await token.connect(creator).approve(await factory.getAddress(), 100_000n * TOKEN);
  const rc = await (await factory.connect(creator).createMarket(
    await token.getAddress(), 100_000n * USDC, 100_000n * TOKEN,
  )).wait();
  let addr = "";
  for (const l of rc!.logs) {
    try { const p = factory.interface.parseLog(l); if (p?.name === "MarketCreated") addr = p.args[0]; } catch {}
  }
  const pool = (await ethers.getContractAt("EXNIHILOPool", addr)) as unknown as EXNIHILOPool;

  await usdc.mint(trader.address, 1_000_000n * USDC);
  await usdc.connect(trader).approve(addr, ethers.MaxUint256);
  await time.increase(24 * 3600);
  await pool.connect(trader).openLong(10_000n * USDC, 0n, trader.address); // fees to both sides

  return { pool, addr, usdc, token, treasury, creator, trader };
}

describe("Claim paths check USDC only", function () {
  it("pays LP and protocol fees while the pool is short of the token", async function () {
    const { pool, addr, usdc, token, treasury, creator, trader } = await loadFixture(fixture);
    const lpFees = await pool.lpFeesAccumulated();
    const protocolFees = await pool.protocolFeesAccumulated();
    expect(lpFees).to.be.gt(0n);
    expect(protocolFees).to.be.gt(0n);

    await token.burn(addr, TOKEN); // a seizure or negative rebase
    await expect(pool.connect(trader).swap(100n * USDC, 0n, false, trader.address))
      .to.be.revertedWithCustomError(pool, "ReserveInvariantViolated"); // the market is frozen

    await expect(pool.connect(creator).claimFees(creator.address))
      .to.changeTokenBalance(usdc, creator, lpFees);
    await expect(pool.connect(treasury).claimProtocolFees(treasury.address))
      .to.changeTokenBalance(usdc, treasury, protocolFees);

    // Anyone can restore the missing tokens, which unfreezes the market.
    await token.mint(addr, TOKEN);
    await expect(pool.connect(trader).swap(100n * USDC, 0n, false, trader.address)).to.not.be.reverted;
  });

  it("still refuses a claim while the pool is short of USDC", async function () {
    const { pool, addr, usdc, treasury, creator } = await loadFixture(fixture);
    await usdc.burn(addr, 1n);
    await expect(pool.connect(creator).claimFees(creator.address))
      .to.be.revertedWithCustomError(pool, "ReserveInvariantViolated");
    await expect(pool.connect(treasury).claimProtocolFees(treasury.address))
      .to.be.revertedWithCustomError(pool, "ReserveInvariantViolated");
  });
});
