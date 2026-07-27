import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { EXNIHILOPool, MockERC20 } from "../typechain-types";

/**
 * Coverage for the zero-output swap guard (audit finding NM-OP5-001).
 *
 * `_cpAmountOut` computes the fee as
 *   fee = amountIn * reserveOut * swapFeeBps / (reserveIn * BPS_DENOM)
 * dividing by `reserveIn` rather than `reserveIn + amountIn`, so the effective
 * rate is swapFeeBps * (1 + amountIn/reserveIn). Past
 *   amountIn / reserveIn >= BPS_DENOM/swapFeeBps - 1
 * (99x the reserve at a 1% fee) the fee exceeds the raw output and the helper
 * returns 0.
 *
 * Before the fix, a caller passing minAmountOut = 0 in that regime had their
 * input taken and received nothing. The pool gained and the caller lost, so it
 * was a caller-side footgun rather than an LP drain — but silently accepting
 * payment for nothing is not acceptable behaviour.
 */
describe("Zero-output swap guard", function () {
  async function fixture() {
    const signers = await ethers.getSigners();
    const [deployer, treasury, creator, trader] = signers;

    const MockERC20F = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6);
    await usdc.waitForDeployment();
    const baseToken = await MockERC20F.connect(deployer).deploy("Base", "BASE", 18);
    await baseToken.waitForDeployment();

    const PosF = await ethers.getContractFactory("PositionNFT");
    const positionNFT = await PosF.connect(deployer).deploy();
    await positionNFT.waitForDeployment();

    const sysDeployer = signers[8];
    const PoolDeployerF = await ethers.getContractFactory("PoolDeployer");
    const poolDeployer = await PoolDeployerF.connect(sysDeployer).deploy();
    await poolDeployer.waitForDeployment();

    const predictedFactory = ethers.getCreateAddress({
      from: sysDeployer.address,
      nonce: await sysDeployer.getNonce(),
    });

    const LpNFTF = await ethers.getContractFactory("LpNFT");
    const lpNft = await LpNFTF.connect(deployer).deploy(predictedFactory);
    await lpNft.waitForDeployment();

    const FactoryF = await ethers.getContractFactory("EXNIHILOFactory");
    const factory = await FactoryF.connect(sysDeployer).deploy(
      await positionNFT.getAddress(),
      await lpNft.getAddress(),
      await usdc.getAddress(),
      treasury.address,
      100n, // 1% swap fee → zero-output threshold is 99x the reserve
      await poolDeployer.getAddress(),
    );
    await factory.waitForDeployment();
    await (await positionNFT.connect(deployer).initFactory(await factory.getAddress())).wait();

    // Deliberately shallow so the threshold is reachable with sane balances.
    const LP_USDC = 1_000n * 10n ** 6n;
    const LP_TOKEN = 1_000n * 10n ** 18n;

    await (await usdc.mint(creator.address, LP_USDC)).wait();
    await (await baseToken.mint(creator.address, LP_TOKEN)).wait();
    await (await usdc.mint(trader.address, 10_000_000n * 10n ** 6n)).wait();
    await (await baseToken.mint(trader.address, 10_000_000n * 10n ** 18n)).wait();

    await (await usdc.connect(creator).approve(await factory.getAddress(), LP_USDC)).wait();
    await (await baseToken.connect(creator).approve(await factory.getAddress(), LP_TOKEN)).wait();
    const rc = await (
      await factory.connect(creator).createMarket(
        await baseToken.getAddress(), LP_USDC, LP_TOKEN, 0n, 0n, 0n,
      )
    ).wait();

    let poolAddress = "";
    for (const log of rc!.logs) {
      try {
        const p = factory.interface.parseLog(log);
        if (p?.name === "MarketCreated") poolAddress = p.args[0];
      } catch { /* skip */ }
    }
    const pool = (await ethers.getContractAt("EXNIHILOPool", poolAddress)) as unknown as EXNIHILOPool;

    return { pool, poolAddress, usdc, baseToken, trader };
  }

  it("reverts a USDC→token swap whose output would round to zero", async function () {
    const { pool, poolAddress, usdc, trader } = await loadFixture(fixture);

    // 1% fee → threshold at 99x backedAirUsd. Use 150x for headroom.
    const reserve = await pool.backedAirUsd();
    const amountIn = reserve * 150n;

    await (await usdc.connect(trader).approve(poolAddress, amountIn)).wait();
    await expect(
      pool.connect(trader).swap(amountIn, 0n, false, trader.address),
    ).to.be.revertedWithCustomError(pool, "InsufficientOutput");
  });

  it("reverts a token→USDC swap whose output would round to zero", async function () {
    const { pool, poolAddress, baseToken, trader } = await loadFixture(fixture);

    const reserve = await pool.backedAirToken();
    const amountIn = reserve * 150n;

    await (await baseToken.connect(trader).approve(poolAddress, amountIn)).wait();
    await expect(
      pool.connect(trader).swap(amountIn, 0n, true, trader.address),
    ).to.be.revertedWithCustomError(pool, "InsufficientOutput");
  });

  it("takes nothing from the caller when the swap reverts", async function () {
    const { pool, poolAddress, usdc, trader } = await loadFixture(fixture);

    const reserve = await pool.backedAirUsd();
    const amountIn = reserve * 150n;
    const balBefore = await usdc.balanceOf(trader.address);
    const poolBefore = await usdc.balanceOf(poolAddress);

    await (await usdc.connect(trader).approve(poolAddress, amountIn)).wait();
    await expect(pool.connect(trader).swap(amountIn, 0n, false, trader.address)).to.be.reverted;

    // The whole point of the fix: no silent transfer of value for nothing.
    expect(await usdc.balanceOf(trader.address)).to.equal(balBefore);
    expect(await usdc.balanceOf(poolAddress)).to.equal(poolBefore);
  });

  it("still allows normal-sized swaps", async function () {
    const { pool, poolAddress, usdc, baseToken, trader } = await loadFixture(fixture);

    // Well under the threshold — must be unaffected by the guard.
    const amountIn = (await pool.backedAirUsd()) / 10n;
    const before = await baseToken.balanceOf(trader.address);

    await (await usdc.connect(trader).approve(poolAddress, amountIn)).wait();
    await (await pool.connect(trader).swap(amountIn, 0n, false, trader.address)).wait();

    expect(await baseToken.balanceOf(trader.address)).to.be.gt(before);
  });

  it("still honours minAmountOut on swaps that do produce output", async function () {
    const { pool, poolAddress, usdc, trader } = await loadFixture(fixture);

    const amountIn = (await pool.backedAirUsd()) / 10n;
    await (await usdc.connect(trader).approve(poolAddress, amountIn)).wait();

    await expect(
      pool.connect(trader).swap(amountIn, ethers.parseEther("1000000"), false, trader.address),
    ).to.be.revertedWithCustomError(pool, "InsufficientOutput");
  });
});
