import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { EXNIHILOPool, PositionNFT, MockERC20 } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

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
  positionNFT: PositionNFT,
  nftIds: bigint[],
): Promise<bigint> {
  let sum = 0n;
  for (const id of nftIds) {
    try {
      const pos = await positionNFT.getPosition(id);
      if (!pos.isLong) sum += pos.lockedAmount;
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
      100n,
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
      expect(await pool.totalShortCollateral()).to.equal(
        await sumOpenShortCollateral(positionNFT, ids),
      );
    }
  });

  it("returns to zero once every short is settled", async function () {
    const { pool, poolAddress, usdc, trader1, trader2 } = await loadFixture(fixture);

    const a = await openShortFor(pool, usdc, poolAddress, trader1, 400n * 10n ** 6n);
    const b = await openShortFor(pool, usdc, poolAddress, trader2, 900n * 10n ** 6n);
    expect(await pool.totalShortCollateral()).to.be.gt(0n);

    // Expire and settle both via the keeper path, which exercises the
    // underwater and profitable branches of _settle without needing to
    // engineer a specific price.
    await time.increase(7 * 24 * 60 * 60 + 1);
    await (await pool.connect(trader1).settleExpired(a, 0n)).wait();
    await (await pool.connect(trader2).settleExpired(b, 0n)).wait();

    expect(await pool.openPositionCount()).to.equal(0n);
    expect(await pool.totalShortCollateral()).to.equal(0n);
  });

  it("keeps the reserve invariant EXACT (zero slack) across the lifecycle", async function () {
    const { pool, poolAddress, usdc, trader1, trader2 } = await loadFixture(fixture);

    // A loose lower-bound invariant would show growing positive slack here.
    expect(await slack(pool, usdc, poolAddress), "fresh pool").to.equal(0n);

    const a = await openShortFor(pool, usdc, poolAddress, trader1, 600n * 10n ** 6n);
    expect(await slack(pool, usdc, poolAddress), "after first short").to.equal(0n);

    const b = await openShortFor(pool, usdc, poolAddress, trader2, 1_500n * 10n ** 6n);
    expect(await slack(pool, usdc, poolAddress), "after second short").to.equal(0n);

    await time.increase(7 * 24 * 60 * 60 + 1);
    await (await pool.connect(trader1).settleExpired(a, 0n)).wait();
    expect(await slack(pool, usdc, poolAddress), "after first settle").to.equal(0n);

    await (await pool.connect(trader2).settleExpired(b, 0n)).wait();
    expect(await slack(pool, usdc, poolAddress), "after second settle").to.equal(0n);
  });

  it("tracks the reduction when auto-renew charges a short's collateral", async function () {
    const { pool, poolAddress, positionNFT, usdc, baseToken, trader1, trader2 } =
      await loadFixture(fixture);

    const nftId = await openShortFor(pool, usdc, poolAddress, trader1, 800n * 10n ** 6n);
    await (await positionNFT.connect(trader1).setAutoRenew(nftId, true, 500n * 10n ** 6n)).wait();

    // Auto-renew only fires when the position can pay: _autoRenewQuote demands
    // surplus >= totalFee + KEEPER_BOUNTY. A short profits when the token gets
    // cheaper to buy back, so push token INTO the pool to raise backedAirToken.
    const dump = 40_000n * 10n ** 18n;
    await (await baseToken.connect(trader2).approve(poolAddress, dump)).wait();
    await (await pool.connect(trader2).swap(dump, 0n, true, trader2.address)).wait();

    const [renewable] = await pool.quoteClose(nftId).then(
      (r) => [r.ready] as const,
      () => [false] as const,
    );
    expect(renewable, "setup failed: short is not priceable after the dump").to.equal(true);

    const before = await pool.totalShortCollateral();
    const lockedBefore = (await positionNFT.getPosition(nftId)).lockedAmount;

    await time.increase(7 * 24 * 60 * 60 + 1);
    await (await pool.connect(trader2).settleExpired(nftId, 0n)).wait();

    // The position must still exist — i.e. auto-renew fired rather than settling.
    // Asserted unconditionally so a silent fallthrough to settlement fails the
    // test instead of passing it (an earlier if/else version masked exactly
    // that, and let a broken accumulator through mutation testing).
    expect(await pool.openPositionCount(), "auto-renew did not fire").to.equal(1n);

    const lockedAfter = (await positionNFT.getPosition(nftId)).lockedAmount;
    expect(lockedAfter, "collateral should shrink by the fee + bounty").to.be.lt(lockedBefore);

    // The accumulator must fall by exactly what the position lost.
    expect(before - (await pool.totalShortCollateral())).to.equal(lockedBefore - lockedAfter);
  });

  it("keeps the invariant exact through an auto-renew", async function () {
    const { pool, poolAddress, positionNFT, usdc, baseToken, trader1, trader2 } =
      await loadFixture(fixture);

    const nftId = await openShortFor(pool, usdc, poolAddress, trader1, 800n * 10n ** 6n);
    await (await positionNFT.connect(trader1).setAutoRenew(nftId, true, 500n * 10n ** 6n)).wait();

    const dump = 40_000n * 10n ** 18n;
    await (await baseToken.connect(trader2).approve(poolAddress, dump)).wait();
    await (await pool.connect(trader2).swap(dump, 0n, true, trader2.address)).wait();
    expect(await slack(pool, usdc, poolAddress), "after dump").to.equal(0n);

    await time.increase(7 * 24 * 60 * 60 + 1);
    await (await pool.connect(trader2).settleExpired(nftId, 0n)).wait();

    expect(await pool.openPositionCount(), "auto-renew did not fire").to.equal(1n);
    expect(await slack(pool, usdc, poolAddress), "after auto-renew").to.equal(0n);
  });
});
