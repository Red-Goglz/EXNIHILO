import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time, mine } from "@nomicfoundation/hardhat-network-helpers";
import { EXNIHILOPool, MockERC20 } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Sweep — what replaced expiry.
 *
 * Positions used to carry a deadline, after which anyone could settle them:
 * a profitable one credited the holder, an underwater one returned its
 * collateral to the LP. That whole mechanism is gone. Funding decays a position
 * continuously instead, and the only third-party path left is sweepDust, which
 * can touch a position only once its collateral is worth essentially nothing.
 *
 * The settlement mechanics the expiry path used to exercise still matter and
 * are still here — pull payments that no recipient can block, collateral and
 * synthetic debt returning to the LP, openPositionCount reaching zero so the LP
 * can withdraw. What has changed is how a position gets into that state: by
 * decaying, not by a clock running out.
 *
 * The one property that genuinely no longer holds: an underwater position is
 * not cleaned up promptly. It sits, decaying, until the wind-down makes it
 * sweepable. The LP still receives its collateral — continuously rather than in
 * one settlement — so nothing is lost, but the timing is different and the
 * tests below say so explicitly rather than quietly asserting the old shape.
 */

const DAY = 24 * 3600;
const BPS = 10_000n;

async function fixture() {
  const signers = await ethers.getSigners();
  const [deployer, treasury, creator, trader1, trader2, other] = signers;

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

  for (const s of [creator, trader1, trader2, other]) {
    await (await usdc.mint(s.address, 10_000_000n * 10n ** 6n)).wait();
    await (await baseToken.mint(s.address, LP_TOKEN * 20n)).wait();
  }

  await (await usdc.connect(creator).approve(await factory.getAddress(), LP_USDC)).wait();
  await (await baseToken.connect(creator).approve(await factory.getAddress(), LP_TOKEN)).wait();
  const rc = await (
    await factory.connect(creator).createMarket(await baseToken.getAddress(), LP_USDC, LP_TOKEN)
  ).wait();

  let poolAddress = "";
  for (const log of rc!.logs) {
    try {
      const p = factory.interface.parseLog(log);
      if (p?.name === "MarketCreated") poolAddress = p.args[0];
    } catch { /* skip */ }
  }
  const pool = (await ethers.getContractAt("EXNIHILOPool", poolAddress)) as unknown as EXNIHILOPool;

  await time.increase(DAY); // past the position-cap ramp

  return { pool, poolAddress, positionNFT, usdc, baseToken,
           creator, trader1, trader2, other };
}

async function openLongFor(
  pool: EXNIHILOPool, usdc: MockERC20, poolAddress: string,
  trader: HardhatEthersSigner, notional: bigint,
): Promise<bigint> {
  const fee = await pool.quoteOpenFee(notional, true);
  await (await usdc.connect(trader).approve(poolAddress, fee * 2n)).wait();
  const rc = await (await pool.connect(trader).openLong(notional, 0n, trader.address)).wait();
  for (const log of rc!.logs) {
    try {
      const p = pool.interface.parseLog(log);
      if (p?.name === "PositionOpened") return p.args[0] as bigint;
    } catch { /* skip */ }
  }
  throw new Error("no PositionOpened");
}

async function openShortFor(
  pool: EXNIHILOPool, usdc: MockERC20, poolAddress: string,
  trader: HardhatEthersSigner, notional: bigint,
): Promise<bigint> {
  const fee = await pool.quoteOpenFee(notional, false);
  await (await usdc.connect(trader).approve(poolAddress, fee * 2n)).wait();
  const rc = await (await pool.connect(trader).openShort(notional, 0n, trader.address)).wait();
  for (const log of rc!.logs) {
    try {
      const p = pool.interface.parseLog(log);
      if (p?.name === "PositionOpened") return p.args[0] as bigint;
    } catch { /* skip */ }
  }
  throw new Error("no PositionOpened");
}

describe("Sweep (what replaced expiry)", function () {
  const N = 2_000n * 10n ** 6n;

  describe("1. positions have no deadline", function () {
    it("a position carries a funding index at open, not an expiry", async function () {
      const { pool, poolAddress, positionNFT, usdc, trader1 } = await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);

      const pos = await positionNFT.getPosition(id);
      expect(pos.fundingIndexAtOpen).to.equal(await pool.fundingIndexLong());
      // There is no `deadline` field to read any more — the struct carries the
      // index the position's decay is measured from instead.
      expect((pos as unknown as Record<string, unknown>).deadline).to.equal(undefined);
    });

    it("a holder can close whenever they like, however old the position", async function () {
      const { pool, poolAddress, usdc, trader1, trader2 } = await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);

      const amt = 60_000n * 10n ** 6n;
      await (await usdc.connect(trader2).approve(poolAddress, amt)).wait();
      await (await pool.connect(trader2).swap(amt, 0n, false, trader2.address)).wait();
      await mine(6);

      // Ninety days later, with no renewal ever paid and nothing expired. The
      // old model capped a position at thirty days and made it buy each
      // extension; this one just keeps charging funding.
      await time.increase(90 * DAY);
      await mine();

      const [ready] = await pool.quoteClose(id);
      expect(ready).to.equal(true);
      await expect(pool.connect(trader1).closeLong(id, 0n, trader1.address))
        .to.emit(pool, "PositionClosed");
    });
  });

  describe("2. sweepDust gating", function () {
    it("refuses a position whose collateral is still real", async function () {
      const { pool, poolAddress, usdc, trader1, other } = await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);

      await time.increase(30 * DAY);
      await expect(pool.connect(other).sweepDust(id))
        .to.be.revertedWithCustomError(pool, "PositionNotDust");
    });

    it("measures dust against the position's own opening collateral", async function () {
      // Not against its claim. A claim-based test could be dodged in the other
      // direction — push the mark down for one block and sweep a position that
      // is not dust at all — whereas collateral moves only with funding, which
      // no caller controls.
      const { pool, poolAddress, usdc, baseToken, trader1, trader2, other } =
        await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);

      // Crush the mark so the claim is zero, without touching the collateral.
      const dump = 400_000n * 10n ** 18n;
      await (await baseToken.connect(trader2).approve(poolAddress, dump)).wait();
      await (await pool.connect(trader2).swap(dump, 0n, true, trader2.address)).wait();

      const [, pnl] = await pool.quoteClose(id);
      expect(pnl).to.be.lte(0n);
      expect(await pool.remainingSizeBps(id)).to.be.gt(10n);
      await expect(pool.connect(other).sweepDust(id))
        .to.be.revertedWithCustomError(pool, "PositionNotDust");
    });
  });

  describe("3. what a sweep does", function () {
    async function decayed() {
      const f = await loadFixture(fixture);
      const longId = await openLongFor(f.pool, f.usdc, f.poolAddress, f.trader1, N);
      const shortId = await openShortFor(f.pool, f.usdc, f.poolAddress, f.trader2, N);
      await (await f.pool.connect(f.creator).closePool()).wait();
      await time.increase(7 * DAY + 45 * DAY);
      await (await f.pool.pokeFunding()).wait();
      return { ...f, longId, shortId };
    }

    it("returns a long's collateral and cancels its synthetic debt", async function () {
      const f = await decayed();
      const backedTokenBefore = await f.pool.backedAirToken();
      const usdSupplyBefore = await f.pool.airUsdSupply();

      await (await f.pool.connect(f.other).sweepDust(f.longId)).wait();

      // The remaining collateral goes to the LP and what is left of the debt is
      // burned. Funding burned nearly all of it on the way down — debt decays
      // with collateral — so the sweep mostly retires the slot.
      expect(await f.pool.backedAirToken()).to.be.gte(backedTokenBefore);
      expect(await f.pool.airUsdSupply()).to.be.lte(usdSupplyBefore);
      expect(await f.pool.longOpenInterest()).to.equal(0n);
    });

    it("returns a short's collateral and cancels its synthetic debt", async function () {
      const f = await decayed();
      const tokenSupplyBefore = await f.pool.airTokenSupply();

      await (await f.pool.connect(f.other).sweepDust(f.shortId)).wait();

      expect(await f.pool.airTokenSupply()).to.be.lte(tokenSupplyBefore);
      expect(await f.pool.shortOpenInterest()).to.equal(0n);
      expect(await f.pool.totalShortDebt()).to.equal(0n);
    });

    it("emits PositionSwept and decrements openPositionCount", async function () {
      const f = await decayed();
      expect(await f.pool.openPositionCount()).to.equal(2n);

      await expect(f.pool.connect(f.other).sweepDust(f.longId))
        .to.emit(f.pool, "PositionSwept");
      expect(await f.pool.openPositionCount()).to.equal(1n);

      await (await f.pool.connect(f.other).sweepDust(f.shortId)).wait();
      expect(await f.pool.openPositionCount()).to.equal(0n);
    });

    it("burns the NFT", async function () {
      const f = await decayed();
      await (await f.pool.connect(f.other).sweepDust(f.longId)).wait();
      await expect(f.positionNFT.ownerOf(f.longId)).to.be.reverted;
    });

    it("frees the LP's principal, which is the point", async function () {
      const f = await decayed();
      await (await f.pool.connect(f.other).sweepDust(f.longId)).wait();
      await (await f.pool.connect(f.other).sweepDust(f.shortId)).wait();

      const tokenBefore = await f.baseToken.balanceOf(f.creator.address);
      await (await f.pool.connect(f.creator).removeLiquidity()).wait();
      expect(await f.baseToken.balanceOf(f.creator.address)).to.be.gt(tokenBefore);
    });

    it("cannot be swept twice", async function () {
      const f = await decayed();
      await (await f.pool.connect(f.other).sweepDust(f.longId)).wait();
      await expect(f.pool.connect(f.other).sweepDust(f.longId)).to.be.reverted;
    });
  });

  describe("4. pull payments", function () {
    it("credits rather than pushes, so no recipient can block a sweep", async function () {
      // The sweep is callable by a stranger, so it must never depend on the
      // holder's wallet being able to receive USDC. Any residual claim is
      // credited and withdrawn separately.
      const { pool, poolAddress, usdc, trader1, other, creator } = await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);

      await (await pool.connect(creator).closePool()).wait();
      await time.increase(7 * DAY + 45 * DAY);
      await (await pool.pokeFunding()).wait();

      const before = await usdc.balanceOf(trader1.address);
      await (await pool.connect(other).sweepDust(id)).wait();
      // Nothing is pushed during the sweep itself, whatever the outcome.
      expect(await usdc.balanceOf(trader1.address)).to.equal(before);
    });

    it("claimPayout reverts with ZeroAmount when nothing is credited", async function () {
      const { pool, trader1 } = await loadFixture(fixture);
      await expect(pool.connect(trader1).claimPayout(trader1.address))
        .to.be.revertedWithCustomError(pool, "ZeroAmount");
    });

    it("claimPayout rejects the zero address", async function () {
      const { pool, trader1 } = await loadFixture(fixture);
      await expect(pool.connect(trader1).claimPayout(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(pool, "ZeroAddress");
    });
  });

  describe("5. the close path takes a recipient", function () {
    it("pays a profitable close to the address the holder names", async function () {
      // A holder whose own wallet cannot receive USDC used to be able to wait
      // for a third party to settle their expired position and credit the
      // payout. With expiry gone that escape would have disappeared, so the
      // voluntary close carries the recipient instead.
      const { pool, poolAddress, usdc, trader1, trader2, other } = await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);

      const amt = 25_000n * 10n ** 6n;
      await (await usdc.connect(trader2).approve(poolAddress, amt)).wait();
      await (await pool.connect(trader2).swap(amt, 0n, false, trader2.address)).wait();
      await mine(6);

      const otherBefore = await usdc.balanceOf(other.address);
      const holderBefore = await usdc.balanceOf(trader1.address);

      await (await pool.connect(trader1).closeLong(id, 0n, other.address)).wait();

      expect(await usdc.balanceOf(other.address)).to.be.gt(otherBefore);
      expect(await usdc.balanceOf(trader1.address)).to.equal(holderBefore);
    });

    it("rejects the zero address", async function () {
      const { pool, poolAddress, usdc, trader1 } = await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);
      await expect(pool.connect(trader1).closeLong(id, 0n, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(pool, "ZeroAddress");
    });

    it("still refuses a non-holder", async function () {
      const { pool, poolAddress, usdc, trader1, other } = await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);
      await expect(pool.connect(other).closeLong(id, 0n, other.address))
        .to.be.revertedWithCustomError(pool, "OnlyPositionHolder");
    });
  });

  describe("6. an underwater position is no longer cleaned up promptly", function () {
    it("has no third-party exit until it has decayed", async function () {
      // The behaviour change worth stating plainly. There is no deadline, so an
      // underwater position simply persists. The LP is not harmed — it collects
      // the collateral continuously through funding instead of in one
      // settlement — but the position does keep its optionality, and a price
      // recovery still belongs to the holder.
      const { pool, poolAddress, usdc, baseToken, trader1, trader2, other } =
        await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);

      const dump = 400_000n * 10n ** 18n;
      await (await baseToken.connect(trader2).approve(poolAddress, dump)).wait();
      await (await pool.connect(trader2).swap(dump, 0n, true, trader2.address)).wait();
      await mine(6);

      await expect(pool.connect(trader1).closeLong(id, 0n, trader1.address))
        .to.be.revertedWithCustomError(pool, "PositionUnderwater");
      await expect(pool.connect(other).sweepDust(id))
        .to.be.revertedWithCustomError(pool, "PositionNotDust");
      expect(await pool.openPositionCount()).to.equal(1n);
    });

    it("still hands the LP the collateral, continuously", async function () {
      const { pool, poolAddress, usdc, baseToken, trader1, trader2 } = await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);

      const dump = 400_000n * 10n ** 18n;
      await (await baseToken.connect(trader2).approve(poolAddress, dump)).wait();
      await (await pool.connect(trader2).swap(dump, 0n, true, trader2.address)).wait();

      const backedBefore = await pool.backedAirToken();
      await time.increase(30 * DAY);
      await (await pool.pokeFunding()).wait();

      expect(await pool.backedAirToken()).to.be.gt(backedBefore);
      expect(await pool.remainingSizeBps(id)).to.be.lt(BPS);
    });
  });
});

/**
 * Clearing an abandoned book.
 *
 * Only a sweep decrements openPositionCount, and removeLiquidity waits on it
 * reaching zero. Nothing bounds how many positions a pool can hold, and the
 * opening fee floor is 0.05 USDC, so a book of tiny abandoned positions is
 * cheap to create and — one sweepDust transaction at a time — expensive to
 * clear. sweepDustBatch is what makes the cleanup proportional.
 */
describe("Sweep: clearing a book in one transaction", function () {
  const SMALL = 20n * 10n ** 6n;

  /** Six abandoned positions, decayed past the dust threshold. */
  async function abandoned() {
    const f = await loadFixture(fixture);
    const ids: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await openLongFor(f.pool, f.usdc, f.poolAddress, f.trader1, SMALL));
      ids.push(await openShortFor(f.pool, f.usdc, f.poolAddress, f.trader2, SMALL));
    }
    await (await f.pool.connect(f.creator).closePool()).wait();
    await time.increase(7 * DAY + 45 * DAY);
    await (await f.pool.pokeFunding()).wait();
    return { ...f, ids };
  }

  it("releases every dust position it is given", async function () {
    const f = await abandoned();
    expect(await f.pool.openPositionCount()).to.equal(6n);

    const swept = await f.pool.connect(f.other).sweepDustBatch.staticCall(f.ids);
    expect(swept).to.equal(6n);

    await (await f.pool.connect(f.other).sweepDustBatch(f.ids)).wait();
    expect(await f.pool.openPositionCount()).to.equal(0n);
  });

  it("frees the LP's principal, which is the point", async function () {
    const f = await abandoned();
    await expect(f.pool.connect(f.creator).removeLiquidity())
      .to.be.revertedWithCustomError(f.pool, "OpenPositionsExist");

    await (await f.pool.connect(f.other).sweepDustBatch(f.ids)).wait();
    await expect(f.pool.connect(f.creator).removeLiquidity()).to.not.be.reverted;
  });

  it("skips what another sweeper already took, rather than losing the batch", async function () {
    const f = await abandoned();
    await (await f.pool.connect(f.other).sweepDust(f.ids[0]!)).wait();

    // The whole original list, including the id that is now gone.
    const swept = await f.pool.connect(f.other).sweepDustBatch.staticCall(f.ids);
    expect(swept).to.equal(5n);

    await (await f.pool.connect(f.other).sweepDustBatch(f.ids)).wait();
    expect(await f.pool.openPositionCount()).to.equal(0n);
  });

  it("skips a position that is not yet dust", async function () {
    const f = await loadFixture(fixture);
    const id = await openLongFor(f.pool, f.usdc, f.poolAddress, f.trader1, SMALL);

    expect(await f.pool.connect(f.other).sweepDustBatch.staticCall([id])).to.equal(0n);
    await (await f.pool.connect(f.other).sweepDustBatch([id])).wait();
    expect(await f.pool.openPositionCount()).to.equal(1n);
  });

  it("ignores ids that were never positions, and an empty list", async function () {
    const f = await abandoned();
    expect(await f.pool.connect(f.other).sweepDustBatch.staticCall([99_999n])).to.equal(0n);
    expect(await f.pool.connect(f.other).sweepDustBatch.staticCall([])).to.equal(0n);
    expect(await f.pool.openPositionCount()).to.equal(6n);
  });

  it("costs less per position than sweeping them one at a time", async function () {
    const one = await abandoned();
    let individual = 0n;
    for (const id of one.ids) {
      const rc = await (await one.pool.connect(one.other).sweepDust(id)).wait();
      individual += rc!.gasUsed;
    }

    const many = await abandoned();
    const batched = (await (await many.pool.connect(many.other).sweepDustBatch(many.ids)).wait())!
      .gasUsed;

    expect(batched).to.be.lessThan(individual);
  });
});
