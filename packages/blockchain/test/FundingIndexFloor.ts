import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { EXNIHILOPool, MockERC20 } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Funding rounding and domain.
 *
 * Audit findings that all come back to the same place: funding is a ratio of
 * indices applied to amounts, and both ends of that have limits.
 *
 *   - a side index that decays all the way to zero used to mint positions with
 *     fundingIndexAtOpen == 0, which _liveAt treated as malformed and valued at
 *     full opening size forever: never dust, never sweepable, openPositionCount
 *     stuck above zero and removeLiquidity bricked for good;
 *   - a position applies the shared index with downward rounding while the
 *     aggregates keep an upward-rounded amount, so a short's debt leg can floor
 *     to zero while its collateral leg has not. A zero debt prices the buyback
 *     at zero, handing the holder the whole remainder untaxed;
 *   - an interval whose aggregate release rounds to zero stays on the clock. An
 *     open used to reset that clock, forgiving the interval for the entire side,
 *     which is worth farming whenever a unit of collateral is valuable;
 *   - collateral large enough that amount x RAY exceeds a uint256 froze every
 *     entry point, including the two that exist to get out.
 *
 * The properties below are what stops each: nothing outlives its own debt, a
 * pool that empties gets its indices back, an open settles the interval it
 * found rather than discarding it, and the arithmetic has no upper domain.
 */

const RAY = 10n ** 27n;
const DAY = 24 * 3600;
const YEAR = 365 * DAY;

/** Factory, LpNFT and PositionNFT, wired as the live fixtures do. */
async function deployProtocol() {
  const signers = await ethers.getSigners();
  const [deployer, treasury, creator, trader1] = signers;

  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const usdc = (await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6)) as MockERC20;
  await usdc.waitForDeployment();

  const positionNFT = await (await ethers.getContractFactory("PositionNFT"))
    .connect(deployer).deploy();
  await positionNFT.waitForDeployment();

  const sysDeployer = signers[8];
  const poolDeployer = await (await ethers.getContractFactory("PoolDeployer"))
    .connect(sysDeployer).deploy();
  await poolDeployer.waitForDeployment();

  const predictedFactory = ethers.getCreateAddress({
    from: sysDeployer.address,
    nonce: await sysDeployer.getNonce(),
  });

  const lpNft = await (await ethers.getContractFactory("LpNFT"))
    .connect(deployer).deploy(predictedFactory);
  await lpNft.waitForDeployment();

  const factory = await (await ethers.getContractFactory("EXNIHILOFactory"))
    .connect(sysDeployer).deploy(
      await positionNFT.getAddress(),
      await lpNft.getAddress(),
      await usdc.getAddress(),
      treasury.address,
      await poolDeployer.getAddress(),
    );
  await factory.waitForDeployment();
  await (await positionNFT.connect(deployer).initFactory(await factory.getAddress())).wait();

  return { factory, positionNFT, usdc, deployer, treasury, creator, trader1 };
}

/** Mint USDC and `token` to everyone who trades in these tests. */
async function fund(
  usdc: MockERC20, token: MockERC20, who: HardhatEthersSigner[], tokenAmount: bigint,
) {
  for (const s of who) {
    await (await usdc.mint(s.address, 10_000_000n * 10n ** 6n)).wait();
    await (await token.mint(s.address, tokenAmount)).wait();
  }
}

/** An 18-decimal market seeded 100k USDC / 100k token. */
async function fixture() {
  const p = await deployProtocol();
  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const baseToken = (await MockERC20F.connect(p.deployer).deploy("Base", "BASE", 18)) as MockERC20;
  await baseToken.waitForDeployment();

  const LP_USDC = 100_000n * 10n ** 6n;
  const LP_TOKEN = 100_000n * 10n ** 18n;

  await fund(p.usdc, baseToken, [p.creator, p.trader1], LP_TOKEN * 10n);
  const pool = await seedMarket(p.factory, p.usdc, baseToken, p.creator, LP_USDC, LP_TOKEN);

  // Past the 24 h position-cap ramp; these tests are not about caps.
  await time.increase(DAY);

  return { ...p, pool, baseToken };
}

/**
 * The coarsest market the factory still allows: 6 decimals at 100 000 USDC per
 * whole token, so one token unit is worth 0.1 USDC — above the 0.05 USDC
 * open-fee floor, which is what makes the rounding asymmetry worth exploiting.
 * The decimals bound shuts the door on anything coarser; this is what is left
 * inside it, and why _liveAt still has to hold the line.
 */
async function coarseFixture() {
  const p = await deployProtocol();
  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const tok = (await MockERC20F.connect(p.deployer).deploy("Coarse", "CRS", 6)) as MockERC20;
  await tok.waitForDeployment();

  const LP_USDC = 100_000n * 10n ** 6n; // 100k USDC
  const LP_TOKEN = 10n ** 6n;           // 1 whole token at 6 decimals

  await fund(p.usdc, tok, [p.creator, p.trader1], LP_TOKEN * 10_000n);
  const pool = await seedMarket(p.factory, p.usdc, tok, p.creator, LP_USDC, LP_TOKEN);
  await time.increase(DAY);

  return { ...p, pool, tok };
}

/**
 * An 18-decimal market whose token reserve is large enough that collateral x RAY
 * leaves the uint256 range. A compliant token may have any supply, so this is
 * reachable without a single odd interface.
 */
async function hugeReserveFixture() {
  const p = await deployProtocol();
  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const tok = (await MockERC20F.connect(p.deployer).deploy("Vast", "VAST", 18)) as MockERC20;
  await tok.waitForDeployment();

  const LP_USDC = 100_000n * 10n ** 6n;
  const LP_TOKEN = 10n ** 55n; // uint256 max / RAY is ~1.16e50

  await fund(p.usdc, tok, [p.creator, p.trader1], LP_TOKEN * 2n);
  const pool = await seedMarket(p.factory, p.usdc, tok, p.creator, LP_USDC, LP_TOKEN);
  await time.increase(DAY);

  return { ...p, pool, tok };
}

async function seedMarket(
  factory: any, usdc: MockERC20, token: MockERC20,
  creator: HardhatEthersSigner, usdcAmount: bigint, tokenAmount: bigint,
): Promise<EXNIHILOPool> {
  const factoryAddr = await factory.getAddress();
  await (await usdc.connect(creator).approve(factoryAddr, usdcAmount)).wait();
  await (await token.connect(creator).approve(factoryAddr, tokenAmount)).wait();
  const rc = await (
    await factory.connect(creator).createMarket(await token.getAddress(), usdcAmount, tokenAmount)
  ).wait();

  let poolAddress = "";
  for (const log of rc!.logs) {
    try {
      const p = factory.interface.parseLog(log);
      if (p?.name === "MarketCreated") poolAddress = p.args[0];
    } catch { /* skip */ }
  }
  return (await ethers.getContractAt("EXNIHILOPool", poolAddress)) as unknown as EXNIHILOPool;
}

async function openFor(
  pool: EXNIHILOPool, usdc: MockERC20, trader: HardhatEthersSigner,
  notional: bigint, isLong: boolean,
): Promise<bigint> {
  const poolAddress = await pool.getAddress();
  const fee = await pool.quoteOpenFee(notional, isLong);
  await (await usdc.connect(trader).approve(poolAddress, fee * 2n)).wait();
  const tx = isLong
    ? pool.connect(trader).openLong(notional, 0n, trader.address)
    : pool.connect(trader).openShort(notional, 0n, trader.address);
  const rc = await (await tx).wait();
  for (const log of rc!.logs) {
    try {
      const p = pool.interface.parseLog(log);
      if (p?.name === "PositionOpened") return p.args[0] as bigint;
    } catch { /* skip */ }
  }
  throw new Error("no PositionOpened");
}

describe("Funding index floors", function () {
  // ───────────────────────────────────────────────────────────────────────────
  describe("an exhausted index", function () {
    const N = 20_000n * 10n ** 6n;

    /**
     * One accrual covering a long enough gap underflows (1 - rate)^weighted to
     * zero, which takes the whole side with it. Reaching that by decay alone
     * needs decades; the point is only that the index CAN land on zero.
     */
    async function exhaust() {
      const f = await loadFixture(fixture);
      await openFor(f.pool, f.usdc, f.trader1, N, true);
      await time.increase(60 * YEAR);
      await (await f.pool.pokeFunding()).wait();
      expect(await f.pool.fundingIndexLong()).to.equal(0n);
      return f;
    }

    it("can be reached at all", async function () {
      await exhaust();
    });

    it("refuses to mint a position that would be worth nothing", async function () {
      const { pool, usdc, trader1 } = await exhaust();
      const fee = await pool.quoteOpenFee(N, true);
      await (await usdc.connect(trader1).approve(await pool.getAddress(), fee * 2n)).wait();
      await expect(
        pool.connect(trader1).openLong(N, 0n, trader1.address)
      ).to.be.revertedWithCustomError(pool, "FundingIndexExhausted");
    });

    it("leaves the positions it decayed sweepable, not immortal", async function () {
      const f = await loadFixture(fixture);
      const id = await openFor(f.pool, f.usdc, f.trader1, N, true);
      await time.increase(60 * YEAR);
      await (await f.pool.pokeFunding()).wait();

      const [locked, debt, notional] = await f.pool.liveAmountsOf(id);
      expect(locked).to.equal(0n);
      expect(debt).to.equal(0n);
      expect(notional).to.equal(0n);

      await expect(f.pool.sweepDust(id)).to.not.be.reverted;
      expect(await f.pool.openPositionCount()).to.equal(0n);
    });

    /**
     * Zero is not the only unusable index. A position minted at a single-digit
     * index loses a large fraction of itself to truncation on the next accrual —
     * at one, all of it — while the aggregate sheds only the ordinary charge.
     * MIN_FUNDING_INDEX (RAY / 1e9) is the floor an open has to clear.
     */
    it("refuses to mint below the resolution floor, not just at zero", async function () {
      const f = await loadFixture(fixture);
      await openFor(f.pool, f.usdc, f.trader1, N, true);

      // Long enough to spend nine orders of magnitude, short of spending all 27.
      await time.increase(18 * YEAR);
      await (await f.pool.pokeFunding()).wait();

      const idx = await f.pool.fundingIndexLong();
      expect(idx).to.be.greaterThan(0n);
      expect(idx).to.be.lessThan(10n ** 18n);

      const fee = await f.pool.quoteOpenFee(N, true);
      await (await f.usdc.connect(f.trader1).approve(await f.pool.getAddress(), fee * 2n)).wait();
      await expect(
        f.pool.connect(f.trader1).openLong(N, 0n, f.trader1.address)
      ).to.be.revertedWithCustomError(f.pool, "FundingIndexExhausted");
    });

    it("rebases once the last position is gone, so the pool stays usable", async function () {
      const f = await loadFixture(fixture);
      const id = await openFor(f.pool, f.usdc, f.trader1, N, true);
      await time.increase(60 * YEAR);
      await (await f.pool.pokeFunding()).wait();
      await (await f.pool.sweepDust(id)).wait();

      expect(await f.pool.fundingIndexLong()).to.equal(RAY);
      expect(await f.pool.fundingIndexShort()).to.equal(RAY);

      // And the LP is not locked out.
      await expect(f.pool.connect(f.creator).removeLiquidity()).to.not.be.reverted;
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("a debt leg that rounds away", function () {
    // 0.2 USDC of notional mints exactly 2 token units of debt against 0.198 USDC
    // of collateral, so the debt floors to zero once the index halves while the
    // collateral is still worth more than the 0.05 USDC it cost to open.
    const N = 2n * 10n ** 5n;

    async function decayedShort() {
      const f = await coarseFixture();
      const id = await openFor(f.pool, f.usdc, f.trader1, N, false);

      const pos = await f.pool.liveAmountsOf(id);
      expect(pos[1]).to.equal(2n); // debt starts at 2 token units
      expect(pos[0]).to.be.greaterThan(10n ** 5n); // collateral is ~0.198 USDC

      // Past the halving: floor(2 x idx/opened) == 0 from here on.
      await time.increase(200 * DAY);
      await (await f.pool.pokeFunding()).wait();

      return { ...f, id };
    }

    it("reads the whole position as spent, not just the debt", async function () {
      const { pool, id } = await decayedShort();
      const [locked, debt, notional] = await pool.liveAmountsOf(id);
      expect(debt).to.equal(0n);
      expect(locked).to.equal(0n);
      expect(notional).to.equal(0n);
    });

    it("does not pay the holder out against a zero buyback cost", async function () {
      const { pool, trader1, id } = await decayedShort();
      await expect(
        pool.connect(trader1).closeShort(id, 0n, trader1.address)
      ).to.be.revertedWithCustomError(pool, "PositionUnderwater");
    });

    it("sweeps to the LP instead, crediting the holder nothing", async function () {
      const { pool, trader1, id } = await decayedShort();
      await (await pool.sweepDust(id)).wait();

      expect(await pool.claimable(trader1.address)).to.equal(0n);
      expect(await pool.openPositionCount()).to.equal(0n);
      expect(await pool.totalShortCollateral()).to.equal(0n);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("an interval carried on a residue", function () {
    // 10 USDC of notional locks 99 token units, so the aggregate release rounds
    // to zero until roughly 1 % has decayed — hours, not seconds.
    const HELD = 10n ** 7n;
    const DUST = 10n ** 6n;

    async function carried() {
      const f = await coarseFixture();
      const id = await openFor(f.pool, f.usdc, f.trader1, HELD, true);

      // Under the release threshold: the clock carries, the index does not move.
      await time.increase(2 * 3600);
      await (await f.pool.pokeFunding()).wait();

      expect(await f.pool.fundingIndexLong()).to.equal(RAY);
      expect(await f.pool.remainingSizeBps(id)).to.equal(10_000n);

      return { ...f, id };
    }

    it("is still carried, not charged, while nothing crosses the threshold", async function () {
      await carried();
    });

    it("is charged by an open on that side rather than forgiven", async function () {
      const { pool, usdc, trader1, id } = await carried();
      await openFor(pool, usdc, trader1, DUST, true);

      expect(await pool.fundingIndexLong()).to.be.lessThan(RAY);
      expect(await pool.remainingSizeBps(id)).to.be.lessThan(10_000n);
    });

    it("cannot be farmed by repeating the open before each threshold", async function () {
      const { pool, usdc, trader1, id } = await carried();

      // remainingSizeBps quantises hard at 99 units of collateral, so watch the
      // index: every repeat charges its interval instead of discarding it.
      let previous = await pool.fundingIndexLong();
      for (let i = 0; i < 4; i++) {
        await openFor(pool, usdc, trader1, DUST, true);
        const now = await pool.fundingIndexLong();
        expect(now).to.be.lessThan(previous);
        previous = now;
        await time.increase(2 * 3600);
      }
      expect(await pool.remainingSizeBps(id)).to.be.lessThan(9_700n);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("collateral past the multiplication domain", function () {
    const N = 10_000n * 10n ** 6n;

    it("locks more than uint256 max / RAY", async function () {
      const f = await hugeReserveFixture();
      await openFor(f.pool, f.usdc, f.trader1, N, true);
      expect(await f.pool.totalLongCollateral())
        .to.be.greaterThan((2n ** 256n - 1n) / RAY);
    });

    it("still accrues funding instead of freezing every entry point", async function () {
      const f = await hugeReserveFixture();
      const id = await openFor(f.pool, f.usdc, f.trader1, N, true);
      await time.increase(30 * DAY);

      await expect(f.pool.pokeFunding()).to.not.be.reverted;
      await expect(f.pool.liveAmountsOf(id)).to.not.be.reverted;
      expect(await f.pool.remainingSizeBps(id)).to.be.lessThan(10_000n);
    });

    it("leaves the LP a way out", async function () {
      const f = await hugeReserveFixture();
      await openFor(f.pool, f.usdc, f.trader1, N, true);
      await time.increase(30 * DAY);

      await expect(f.pool.connect(f.creator).closePool()).to.not.be.reverted;
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("the decimals a market will accept", function () {
    async function create(decimals: number) {
      const p = await deployProtocol();
      const MockERC20F = await ethers.getContractFactory("MockERC20");
      const tok = (await MockERC20F.connect(p.deployer).deploy("T", "T", decimals)) as MockERC20;
      await tok.waitForDeployment();

      const usdcAmount = 100_000n * 10n ** 6n;
      const tokenAmount = 1_000n * 10n ** BigInt(decimals);
      await fund(p.usdc, tok, [p.creator], tokenAmount * 10n);
      return { p, tok, usdcAmount, tokenAmount };
    }

    for (const d of [6, 8, 18]) {
      it(`accepts ${d}`, async function () {
        const { p, tok, usdcAmount, tokenAmount } = await create(d);
        await expect(seedMarket(p.factory, p.usdc, tok, p.creator, usdcAmount, tokenAmount))
          .to.not.be.reverted;
      });
    }

    // Below 6 a unit of collateral is valuable enough that sub-unit funding
    // residue is worth trading against; above 18 nothing legitimate lives.
    for (const d of [0, 2, 5, 19]) {
      it(`rejects ${d}`, async function () {
        const { p, tok, usdcAmount, tokenAmount } = await create(d);
        await expect(seedMarket(p.factory, p.usdc, tok, p.creator, usdcAmount, tokenAmount))
          .to.be.revertedWithCustomError(p.factory, "UnsupportedDecimals");
      });
    }
  });
});
