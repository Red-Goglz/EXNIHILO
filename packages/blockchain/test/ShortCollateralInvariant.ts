import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time, mine } from "@nomicfoundation/hardhat-network-helpers";
import { EXNIHILOPool, PositionNFT, MockERC20 } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { windDownAndSweep } from "./helpers/winddown";

// Mine past the close-price clamp window (EXNIHILOPool CLAMP_BLOCKS): a close
// is priced against the worst block-open inside it, so a test that moves the
// price and then closes waits it out first to price against the moved curve.
const CLAMP_BLOCKS = 5;

/**
 * Coverage for `totalShortCollateral` and the reserve invariant that now
 * includes it.
 *
 * Background: `openShort` moves real USDC out of `backedAirUsd` and records it
 * as the position's `lockedAmount`. That USDC is still held by the pool but is
 * owed to the trader. Before this counter existed, `_assertReserveInvariant`
 * did not represent it on the liability side, so the check passed whether or
 * not the collateral was actually still there — it could not detect a leak.
 *
 * These tests pin the two properties the counter must have:
 *   1. It always equals the sum of `lockedAmount` over open shorts.
 *   2. The reserve invariant is EXACT (zero slack), not a loose lower bound.
 */

// The full liability set the pool's USDC balance must cover.
async function liabilities(pool: EXNIHILOPool): Promise<bigint> {
  return (
    (await pool.backedAirUsd()) +
    (await pool.totalShortCollateral()) +
    (await pool.lpFeesAccumulated()) +
    (await pool.protocolFeesAccumulated()) +
    (await pool.totalClaimable())
  );
}

async function slack(pool: EXNIHILOPool, usdc: MockERC20, poolAddress: string): Promise<bigint> {
  return (await usdc.balanceOf(poolAddress)) - (await liabilities(pool));
}

async function sumOpenShortCollateral(
  pool: EXNIHILOPool,
  positionNFT: PositionNFT,
  nftIds: bigint[],
): Promise<bigint> {
  let sum = 0n;
  for (const id of nftIds) {
    try {
      const pos = await positionNFT.getPosition(id);
      // effectiveLockedOf, not lockedAmountAtOpen: funding decays every open
      // position continuously, and the registry stores only the opening figure.
      if (!pos.isLong) sum += await pool.effectiveLockedOf(id);
    } catch {
      // released (burned) on settle — contributes nothing
    }
  }
  return sum;
}

describe("Short collateral invariant", function () {
  // Reuses the shared system fixture from EXNIHILOPool.ts by re-deploying the
  // same way; kept local so this file stands alone.
  async function fixture() {
    const signers = await ethers.getSigners();
    const [deployer, treasury, creator, trader1, trader2, trader3] = signers;

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
      await poolDeployer.getAddress(),
    );
    await factory.waitForDeployment();
    await (await positionNFT.connect(deployer).initFactory(await factory.getAddress())).wait();

    const LP_USDC = 100_000n * 10n ** 6n;
    const LP_TOKEN = 100_000n * 10n ** 18n;
    const MINT_USDC = 10_000_000n * 10n ** 6n;

    for (const s of [creator, trader1, trader2, trader3]) {
      await (await usdc.mint(s.address, MINT_USDC)).wait();
      await (await baseToken.mint(s.address, LP_TOKEN * 10n)).wait();
    }

    await (await usdc.connect(creator).approve(await factory.getAddress(), LP_USDC)).wait();
    await (await baseToken.connect(creator).approve(await factory.getAddress(), LP_TOKEN)).wait();
    const rc = await (
      await factory.connect(creator).createMarket(
        await baseToken.getAddress(), LP_USDC, LP_TOKEN)
    ).wait();
    // Position caps ramp 1 %→20 % over 24 h. These tests are not about
    // caps, so start past the ramp where size is not the constraint.
    await time.increase(24 * 3600);

    let poolAddress = "";
    for (const log of rc!.logs) {
      try {
        const p = factory.interface.parseLog(log);
        if (p?.name === "MarketCreated") poolAddress = p.args[0];
      } catch { /* skip */ }
    }
    const pool = (await ethers.getContractAt("EXNIHILOPool", poolAddress)) as unknown as EXNIHILOPool;

    return { pool, poolAddress, positionNFT, usdc, baseToken, creator, trader1, trader2, trader3 };
  }

  async function openShortFor(
    pool: EXNIHILOPool,
    usdc: MockERC20,
    poolAddress: string,
    trader: HardhatEthersSigner,
    notional: bigint,
  ): Promise<bigint> {
    const fee = await pool.quoteOpenFee(notional, false);
    await (await usdc.connect(trader).approve(poolAddress, fee * 2n)).wait();
    const rc = await (await pool.connect(trader).openShort(notional, 0n, trader.address)).wait();
    for (const log of rc!.logs) {
      try {
        const p = pool.interface.parseLog(log);
        if (p?.name === "PositionOpened") return p.args.nftId as bigint;
      } catch { /* skip */ }
    }
    throw new Error("PositionOpened not emitted");
  }

  it("starts at zero on a fresh pool", async function () {
    const { pool } = await loadFixture(fixture);
    expect(await pool.totalShortCollateral()).to.equal(0n);
  });

  it("longs do not touch it (lockedAmount there is airToken, not USDC)", async function () {
    const { pool, poolAddress, usdc, trader1 } = await loadFixture(fixture);

    const notional = 500n * 10n ** 6n;
    const fee = await pool.quoteOpenFee(notional, true);
    await (await usdc.connect(trader1).approve(poolAddress, fee * 2n)).wait();
    await (await pool.connect(trader1).openLong(notional, 0n, trader1.address)).wait();

    expect(await pool.totalShortCollateral()).to.equal(0n);
  });

  it("equals the sum of open short lockedAmounts", async function () {
    const { pool, poolAddress, positionNFT, usdc, trader1, trader2, trader3 } =
      await loadFixture(fixture);

    const ids: bigint[] = [];
    for (const [t, n] of [
      [trader1, 300n * 10n ** 6n],
      [trader2, 750n * 10n ** 6n],
      [trader3, 1_200n * 10n ** 6n],
    ] as const) {
      ids.push(await openShortFor(pool, usdc, poolAddress, t, n));
      // Assert after every open, not just at the end — catches an increment
      // that is merely proportional rather than exact.
      // At or above, never below. _projectFunding rounds the aggregate\'s
      // retained collateral up and effectiveLocked rounds each position\'s down,
      // so the aggregate carries a few wei of slack that _flushResidue
      // returns to the LP once the book is empty. The reverse bias would let the
      // last settle out of the pool underflow this counter.
      const summed = await sumOpenShortCollateral(pool, positionNFT, ids);
      expect(await pool.totalShortCollateral()).to.be.gte(summed);
      expect(await pool.totalShortCollateral()).to.be.closeTo(summed, BigInt(ids.length) + 4n);
    }
  });

  it("returns to zero once every short is retired", async function () {
    const { pool, poolAddress, usdc, creator, trader1, trader2 } = await loadFixture(fixture);

    const a = await openShortFor(pool, usdc, poolAddress, trader1, 400n * 10n ** 6n);
    const b = await openShortFor(pool, usdc, poolAddress, trader2, 900n * 10n ** 6n);
    expect(await pool.totalShortCollateral()).to.be.gt(0n);

    // No expiry to settle at any more. A short that is never closed decays into
    // the LP's reserves until the wind-down takes it below the sweep threshold.
    await windDownAndSweep(pool, creator, [a, b]);

    expect(await pool.openPositionCount()).to.equal(0n);
    // Exactly zero, not merely small: _flushResidue returns the
    // rounding slack to the LP once the last position leaves, so a stranded
    // remainder can never block removeLiquidity.
    expect(await pool.totalShortCollateral()).to.equal(0n);
  });

  it("keeps the reserve invariant EXACT (zero slack) across the lifecycle", async function () {
    const { pool, poolAddress, usdc, creator, trader1, trader2 } = await loadFixture(fixture);

    // A loose lower-bound invariant would show growing positive slack here.
    expect(await slack(pool, usdc, poolAddress), "fresh pool").to.equal(0n);

    const a = await openShortFor(pool, usdc, poolAddress, trader1, 600n * 10n ** 6n);
    expect(await slack(pool, usdc, poolAddress), "after first short").to.equal(0n);

    const b = await openShortFor(pool, usdc, poolAddress, trader2, 1_500n * 10n ** 6n);
    expect(await slack(pool, usdc, poolAddress), "after second short").to.equal(0n);

    // Funding moves airUsd out of totalShortCollateral and into backedAirUsd.
    // Both are terms of the same liability sum, so the slack must not move at
    // all — if funding ever created or destroyed USDC rather than relabelling
    // it, this is where it would show.
    await time.increase(10 * 24 * 60 * 60);
    await (await pool.pokeFunding()).wait();
    expect(await slack(pool, usdc, poolAddress), "after funding").to.equal(0n);

    await windDownAndSweep(pool, creator, [a, b]);
    expect(await slack(pool, usdc, poolAddress), "after wind-down").to.equal(0n);
  });

  it("tracks the reduction when funding charges a short's collateral", async function () {
    // The direct successor to what used to be the auto-renew path: a fee
    // charged against a short's own locked collateral. It is now continuous
    // rather than triggered at expiry, but the accounting requirement is
    // identical — the accumulator must fall by exactly what the positions lost.
    const { pool, poolAddress, positionNFT, usdc, trader1 } = await loadFixture(fixture);

    const nftId = await openShortFor(pool, usdc, poolAddress, trader1, 800n * 10n ** 6n);

    const before = await pool.totalShortCollateral();
    const lockedBefore = await pool.effectiveLockedOf(nftId);

    await time.increase(10 * 24 * 60 * 60);
    await (await pool.pokeFunding()).wait();

    const lockedAfter = await pool.effectiveLockedOf(nftId);
    expect(lockedAfter, "collateral should shrink").to.be.lt(lockedBefore);

    // The position is still open — funding shrinks it, it does not settle it.
    expect(await pool.openPositionCount()).to.equal(1n);

    const accumulatorDrop = before - (await pool.totalShortCollateral());
    const positionDrop = lockedBefore - lockedAfter;
    expect(accumulatorDrop).to.be.lte(positionDrop);
    expect(accumulatorDrop).to.be.closeTo(positionDrop, 4n);
  });

  it("keeps the invariant exact through a funding accrual on both sides", async function () {
    const { pool, poolAddress, usdc, baseToken, trader1, trader2 } = await loadFixture(fixture);

    await openShortFor(pool, usdc, poolAddress, trader1, 800n * 10n ** 6n);

    const dump = 40_000n * 10n ** 18n;
    await (await baseToken.connect(trader2).approve(poolAddress, dump)).wait();
    await (await pool.connect(trader2).swap(dump, 0n, true, trader2.address)).wait();
    await mine(CLAMP_BLOCKS);
    expect(await slack(pool, usdc, poolAddress), "after dump").to.equal(0n);

    for (let i = 0; i < 5; i++) {
      await time.increase(3 * 24 * 60 * 60);
      await (await pool.pokeFunding()).wait();
      expect(await slack(pool, usdc, poolAddress), `after accrual ${i}`).to.equal(0n);
    }
  });

  it("keeps the invariant exact when the clamp prices a short close against an older block", async function () {
    // The clamp can value a close against a block that opened a moment earlier,
    // when funding had taken slightly less of the collateral. That valuation's
    // buyback cost and surplus add up to the collateral as it stood THEN, so
    // settlement must not credit both against the collateral as it stands NOW
    // — it would pay out more USDC than the position still holds.
    const { pool, poolAddress, usdc, baseToken, trader1, trader2 } = await loadFixture(fixture);
    const id = await openShortFor(pool, usdc, poolAddress, trader1, 2_000n * 10n ** 6n);

    // Put the short in profit and let that price age into every clamp entry.
    const dump = 20_000n * 10n ** 18n;
    await (await baseToken.connect(trader2).approve(poolAddress, dump * 2n)).wait();
    await (await pool.connect(trader2).swap(dump, 0n, true, trader2.address)).wait();
    await mine(CLAMP_BLOCKS);
    await time.increase(3600);

    // A second dump makes the live valuation better than this block's open, so
    // the close in the next block is clamped to that open — whose collateral
    // figure predates the next block's accrual.
    await (await pool.connect(trader2).swap(dump, 0n, true, trader2.address)).wait();
    const [ready, pnl] = await pool.quoteClose(id);
    expect(ready).to.equal(true);
    expect(pnl).to.be.gt(0n);

    // Guarantee funding moves between the clamped block and the close. Blocks
    // mined within the same wall-clock second can share a timestamp, and then
    // there is no accrual between them for the mismatch to come from.
    await time.setNextBlockTimestamp((await time.latest()) + 30);
    await (await pool.connect(trader1).closeShort(id, 0n, trader1.address)).wait();
    expect(await slack(pool, usdc, poolAddress)).to.equal(0n);
  });
});
