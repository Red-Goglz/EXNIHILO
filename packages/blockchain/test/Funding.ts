import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time, mine } from "@nomicfoundation/hardhat-network-helpers";
import { EXNIHILOPool, PositionNFT, MockERC20 } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Funding.
 *
 * Positions do not expire and post no margin, so the premium for holding one
 * has to be charged continuously and can only be taken from the position's own
 * collateral. Funding does exactly that: every second, each side's locked
 * collateral is reduced by a fixed FRACTION and the released units are handed to
 * the matching backed reserve.
 *
 * The tests below are organised around the properties that make that safe
 * rather than around the functions that implement it:
 *
 *   - the charge is multiplicative, so a claim can never be driven negative and
 *     nothing ever needs liquidating;
 *   - one index per side describes the whole book, so no position is touched
 *     between open and close;
 *   - the aggregate counters never fall below the sum of the positions they
 *     stand for, which is what stops the last close out of a pool underflowing;
 *   - funding moves value into the reserves and NOT into the claimable fee
 *     accumulators;
 *   - both supply counters are untouched, because nothing is bought, sold, or
 *     paid out.
 */

const RAY = 10n ** 27n;
const BPS = 10_000n;
const HOUR = 3600;
const DAY = 24 * HOUR;

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

  // The position-size cap ramps 1 %→20 % over the first 24 h. These tests are
  // about funding, not caps, so start past the ramp where size is never the
  // binding constraint.
  await time.increase(DAY);

  return { pool, poolAddress, positionNFT, usdc, baseToken, factory,
           creator, trader1, trader2, trader3 };
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

/** Sum of every open position's LIVE collateral, debt and notional, per side. */
async function sumLive(
  pool: EXNIHILOPool, positionNFT: PositionNFT, ids: bigint[], isLong: boolean,
): Promise<{ locked: bigint; debt: bigint; notional: bigint }> {
  const sum = { locked: 0n, debt: 0n, notional: 0n };
  for (const id of ids) {
    try {
      const pos = await positionNFT.getPosition(id);
      if (pos.isLong !== isLong) continue;
      const [locked, debt, notional] = await pool.liveAmountsOf(id);
      sum.locked += locked;
      sum.debt += debt;
      sum.notional += notional;
    } catch { /* released */ }
  }
  return sum;
}

/** A second, independent market on the same factory, seeded like the fixture's. */
async function freshMarket(
  factory: any, usdc: MockERC20, creator: HardhatEthersSigner, name: string,
): Promise<{ pool: EXNIHILOPool; poolAddress: string }> {
  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const tok = await MockERC20F.deploy(name, name, 18);
  await tok.waitForDeployment();
  await (await tok.mint(creator.address, 10n ** 24n)).wait();
  await (await tok.connect(creator).approve(await factory.getAddress(), 10n ** 23n)).wait();
  await (await usdc.connect(creator).approve(await factory.getAddress(), 100_000n * 10n ** 6n)).wait();
  const rc = await (
    await factory.connect(creator).createMarket(
      await tok.getAddress(), 100_000n * 10n ** 6n, 100_000n * 10n ** 18n)
  ).wait();
  let poolAddress = "";
  for (const log of rc!.logs) {
    try {
      const pl = factory.interface.parseLog(log);
      if (pl?.name === "MarketCreated") poolAddress = pl.args[0];
    } catch { /* skip */ }
  }
  const pool = (await ethers.getContractAt("EXNIHILOPool", poolAddress)) as unknown as EXNIHILOPool;
  return { pool, poolAddress };
}

describe("Funding", function () {
  const N = 2_000n * 10n ** 6n;

  // ───────────────────────────────────────────────────────────────────────────
  describe("the index", function () {
    it("starts at RAY on both sides", async function () {
      const { pool } = await loadFixture(fixture);
      expect(await pool.fundingIndexLong()).to.equal(RAY);
      expect(await pool.fundingIndexShort()).to.equal(RAY);
    });

    it("does not move while the side carries no collateral", async function () {
      const { pool } = await loadFixture(fixture);
      await time.increase(30 * DAY);
      await (await pool.pokeFunding()).wait();
      expect(await pool.fundingIndexLong()).to.equal(RAY);
      expect(await pool.fundingIndexShort()).to.equal(RAY);
    });

    it("does not bill a position for idle time that predates it", async function () {
      const { pool, poolAddress, usdc, trader1 } = await loadFixture(fixture);

      // A month of silence, then a position. The clock advanced; the index did
      // not, so the position opens at RAY and owes nothing for the gap.
      await time.increase(30 * DAY);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);

      const pos = await pool.positionNFT();
      expect(pos).to.not.equal(ethers.ZeroAddress);
      expect(await pool.remainingSizeBps(id)).to.equal(BPS);
    });

    // An empty book is not the only idle side. Aggregates round up and positions
    // round down, so a side's last close normally leaves a unit or two behind, and
    // _flushResidue clears it only once BOTH sides are empty. A release on 1 unit
    // rounds to zero forever, which used to freeze the side's clock and bill the
    // whole frozen stretch to the next opener (audit R3, NM-R3-001).
    describe("does not bill a newcomer for time carried on a residue", function () {
      const CLAMP_BLOCKS = 5;
      const GAP = 30 * DAY;

      it("short side: residue left by a closed short while a long stays open", async function () {
        const { pool, poolAddress, usdc, baseToken, trader1, trader2, trader3 } =
          await loadFixture(fixture);
        await openLongFor(pool, usdc, poolAddress, trader1, N);
        const s = await openShortFor(pool, usdc, poolAddress, trader2, N);

        // Move the price down so the short can close in profit.
        await time.increase(HOUR);
        const dump = 30_000n * 10n ** 18n;
        await (await baseToken.connect(trader3).approve(poolAddress, dump)).wait();
        await (await pool.connect(trader3).swap(dump, 0n, true, trader3.address)).wait();
        await mine(CLAMP_BLOCKS);
        await (await pool.connect(trader2).closeShort(s, 0n, trader2.address)).wait();

        // The case under test: no shorts, a residue, and a long keeping it alive.
        expect(await pool.openPositionCount()).to.equal(1n);
        expect(await pool.totalShortCollateral()).to.be.gt(0n);

        await time.increase(GAP);
        const id = await openShortFor(pool, usdc, poolAddress, trader3, N);
        await (await pool.pokeFunding()).wait();
        expect(await pool.remainingSizeBps(id)).to.be.gte(BPS - 1n);
      });

      it("long side: residue left by a closed long while a short stays open", async function () {
        const { pool, poolAddress, usdc, trader1, trader2, trader3 } = await loadFixture(fixture);
        await openShortFor(pool, usdc, poolAddress, trader1, N);
        const l = await openLongFor(pool, usdc, poolAddress, trader2, N);

        // Move the price up so the long can close in profit.
        await time.increase(HOUR);
        const pump = 40_000n * 10n ** 6n;
        await (await usdc.connect(trader3).approve(poolAddress, pump)).wait();
        await (await pool.connect(trader3).swap(pump, 0n, false, trader3.address)).wait();
        await mine(CLAMP_BLOCKS);
        await (await pool.connect(trader2).closeLong(l, 0n, trader2.address)).wait();

        expect(await pool.openPositionCount()).to.equal(1n);
        expect(await pool.totalLongCollateral()).to.be.gt(0n);

        await time.increase(GAP);
        const id = await openLongFor(pool, usdc, poolAddress, trader3, N);
        await (await pool.pokeFunding()).wait();
        expect(await pool.remainingSizeBps(id)).to.be.gte(BPS - 1n);
      });

      it("a deliberate 1-unit dust short cannot freeze the clock for the next short", async function () {
        const { pool, poolAddress, usdc, creator, trader1 } = await loadFixture(fixture);
        // 3 units of notional sells for exactly 1 unit of collateral, for the 0.05 USDC fee floor.
        await openShortFor(pool, usdc, poolAddress, creator, 3n);
        expect(await pool.totalShortCollateral()).to.equal(1n);

        await time.increase(GAP);
        const id = await openShortFor(pool, usdc, poolAddress, trader1, N);
        await (await pool.pokeFunding()).wait();
        expect(await pool.remainingSizeBps(id)).to.be.gte(BPS - 1n);
      });
    });

    it("only ever decreases", async function () {
      const { pool, poolAddress, usdc, trader1, trader2 } = await loadFixture(fixture);
      await openLongFor(pool, usdc, poolAddress, trader1, N);

      let prev = await pool.fundingIndexLong();
      for (let i = 0; i < 5; i++) {
        await time.increase(6 * HOUR);
        await (await pool.pokeFunding()).wait();
        const now = await pool.fundingIndexLong();
        expect(now).to.be.lt(prev);
        prev = now;
      }
      // A second position on the same side does not disturb the index.
      await openShortFor(pool, usdc, poolAddress, trader2, N);
      expect(await pool.fundingIndexLong()).to.be.lte(prev);
    });

    it("accrues a multi-year gap within a sane gas budget", async function () {
      // _weightedElapsed walks the interval in pieces — one per wind-down
      // doubling and one per doubling of the funding window — so a pool left
      // alone for years costs more to poke than one poked every block. The walk
      // is bounded by _MAX_INTEGRATION_STEPS, but the bound is only useful if
      // the worst case actually fits in a block.
      const { pool, poolAddress, usdc, trader1, creator } = await loadFixture(fixture);
      await openLongFor(pool, usdc, poolAddress, trader1, N);
      await openShortFor(pool, usdc, poolAddress, trader1, N);
      await (await pool.connect(creator).closePool()).wait();

      await time.increase(5 * 365 * DAY);
      const rc = await (await pool.pokeFunding()).wait();
      expect(rc!.gasUsed).to.be.lt(400_000n);
    });

    it("survives an interval long enough to make a linear decay go negative", async function () {
      // At the opening rate of 10 %/hour a linear `RAY - rate * elapsed` turns
      // negative after 10 hours and would zero every position on the book. _rpow
      // compounds instead, so a year of silence still leaves a positive index.
      const { pool, poolAddress, usdc, trader1 } = await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);

      await time.increase(365 * DAY);
      await (await pool.pokeFunding()).wait();

      expect(await pool.fundingIndexLong()).to.be.gt(0n);
      expect(await pool.effectiveLockedOf(id)).to.be.gte(0n);
      expect(await pool.totalLongCollateral()).to.be.gte(0n);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("what it charges", function () {
    it("shrinks a long's collateral and debt together, returning the collateral to backedAirToken", async function () {
      const { pool, poolAddress, usdc, trader1 } = await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);

      const [lockedBefore, debtBefore] = await pool.liveAmountsOf(id);
      const backedBefore = await pool.backedAirToken();
      const tokenSupplyBefore = await pool.airTokenSupply();
      const usdSupplyBefore = await pool.airUsdSupply();
      const oiBefore = await pool.longOpenInterest();

      await time.increase(2 * DAY);
      await (await pool.pokeFunding()).wait();

      const [lockedAfter, debtAfter] = await pool.liveAmountsOf(id);
      const released = lockedBefore - lockedAfter;
      const cancelled = debtBefore - debtAfter;
      expect(released).to.be.gt(0n);
      expect(cancelled).to.be.gt(0n);

      // What the position lost, the reserve gained. The aggregate lands a hair
      // UNDER the position's own loss, never over: _released rounds the
      // aggregate's retained amount up while liveAmountsOf rounds the position's
      // down, and the gap is the margin that keeps the aggregate solvent.
      const gained = (await pool.backedAirToken()) - backedBefore;
      expect(gained).to.be.lte(released);
      expect(gained).to.be.closeTo(released, 4n);

      // The debt that collateral was locked against is burned out of airUsdSupply
      // and out of open interest by the same amount. The token supply does not
      // move: the collateral changed hands inside the pool, nothing was minted.
      const burned = usdSupplyBefore - (await pool.airUsdSupply());
      expect(burned).to.equal(oiBefore - (await pool.longOpenInterest()));
      expect(burned).to.be.lte(cancelled);
      expect(burned).to.be.closeTo(cancelled, 4n);
      expect(await pool.airTokenSupply()).to.equal(tokenSupplyBefore);
    });

    it("shrinks a short's collateral and debt together, returning the collateral to backedAirUsd", async function () {
      const { pool, poolAddress, usdc, trader1 } = await loadFixture(fixture);
      const id = await openShortFor(pool, usdc, poolAddress, trader1, N);

      const [lockedBefore, debtBefore, notionalBefore] = await pool.liveAmountsOf(id);
      const backedBefore = await pool.backedAirUsd();
      const usdSupplyBefore = await pool.airUsdSupply();
      const tokenSupplyBefore = await pool.airTokenSupply();
      const debtAggBefore = await pool.totalShortDebt();
      const oiBefore = await pool.shortOpenInterest();

      await time.increase(2 * DAY);
      await (await pool.pokeFunding()).wait();

      const [lockedAfter, debtAfter, notionalAfter] = await pool.liveAmountsOf(id);
      const released = lockedBefore - lockedAfter;
      expect(released).to.be.gt(0n);
      const gained = (await pool.backedAirUsd()) - backedBefore;
      expect(gained).to.be.lte(released);
      expect(gained).to.be.closeTo(released, 4n);

      // The airToken debt is burned out of airTokenSupply and totalShortDebt by
      // the same amount, and open interest falls with the notional. The airUsd
      // supply does not move: the collateral changed hands inside the pool.
      const cancelled = debtBefore - debtAfter;
      const burned = tokenSupplyBefore - (await pool.airTokenSupply());
      expect(burned).to.equal(debtAggBefore - (await pool.totalShortDebt()));
      expect(burned).to.be.lte(cancelled);
      expect(burned).to.be.closeTo(cancelled, 4n);
      expect(oiBefore - (await pool.shortOpenInterest()))
        .to.be.closeTo(notionalBefore - notionalAfter, 4n);
      expect(await pool.airUsdSupply()).to.equal(usdSupplyBefore);
    });

    it("is not a claimable fee", async function () {
      // Funding lands in the reserves the LP already owns, exactly as a close
      // would have returned it. Only the open fee and the close fee accrue.
      const { pool, poolAddress, usdc, trader1 } = await loadFixture(fixture);
      await openLongFor(pool, usdc, poolAddress, trader1, N);
      await openShortFor(pool, usdc, poolAddress, trader1, N);

      const lpFees = await pool.lpFeesAccumulated();
      const protoFees = await pool.protocolFeesAccumulated();

      await time.increase(5 * DAY);
      await (await pool.pokeFunding()).wait();

      expect(await pool.lpFeesAccumulated()).to.equal(lpFees);
      expect(await pool.protocolFeesAccumulated()).to.equal(protoFees);
    });

    it("scales collateral, debt and notional by exactly the index — no swap, no fee", async function () {
      const { pool, poolAddress, positionNFT, usdc, trader1 } = await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);
      const pos = await positionNFT.getPosition(id);

      await time.increase(3 * DAY);
      await (await pool.pokeFunding()).wait();

      const idxNow = await pool.fundingIndexLong();
      const [locked, debt, notional] = await pool.liveAmountsOf(id);
      expect(await pool.effectiveLockedOf(id)).to.equal(locked);
      expect(locked).to.equal((pos.lockedAmountAtOpen * idxNow) / pos.fundingIndexAtOpen);
      expect(debt).to.equal((pos.airUsdMinted * idxNow) / pos.fundingIndexAtOpen);
      expect(notional).to.equal((pos.usdcIn * idxNow) / pos.fundingIndexAtOpen);
    });

    it("emits FundingAccrued with the released collateral, the cancelled debt and the new index", async function () {
      const { pool, poolAddress, usdc, trader1 } = await loadFixture(fixture);
      await openLongFor(pool, usdc, poolAddress, trader1, N);

      await time.increase(DAY);
      const rc = await (await pool.pokeFunding()).wait();

      const events = rc!.logs
        .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
        .filter((p) => p?.name === "FundingAccrued");

      expect(events.length).to.equal(1);
      expect(events[0]!.args[0]).to.equal(true);     // isLong
      expect(events[0]!.args[1]).to.be.gt(0n);       // released collateral
      expect(events[0]!.args[2]).to.be.gt(0n);       // debt cancelled
      expect(events[0]!.args[3]).to.be.lt(RAY);      // newIndex
      expect(events[0]!.args[4]).to.be.gte(BigInt(DAY)); // elapsed
    });

    it("can never drive a claim below zero", async function () {
      // The whole reason the charge is multiplicative. Ten years of funding at
      // the wind-down rate still leaves a non-negative position, and the pool
      // still prices it.
      const { pool, poolAddress, usdc, trader1, creator } = await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);

      await (await pool.connect(creator).closePool()).wait();
      await time.increase(400 * DAY);
      await (await pool.pokeFunding()).wait();

      expect(await pool.effectiveLockedOf(id)).to.be.gte(0n);
      const [, pnl] = await pool.quoteClose(id);
      expect(pnl).to.be.lte(0n); // a loss, never an impossible negative collateral
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("what it does to the price", function () {
    it("long funding lowers spotPrice and longPrice, leaving shortPrice alone", async function () {
      const { pool, poolAddress, usdc, trader1 } = await loadFixture(fixture);
      await openLongFor(pool, usdc, poolAddress, trader1, N);

      const spot0 = await pool.spotPrice();
      const long0 = await pool.longPrice();
      const short0 = await pool.shortPrice();

      await time.increase(3 * DAY);
      await (await pool.pokeFunding()).wait();

      expect(await pool.spotPrice()).to.be.lt(spot0);
      expect(await pool.longPrice()).to.be.lt(long0);
      expect(await pool.shortPrice()).to.equal(short0);
    });

    it("short funding raises spotPrice and shortPrice, leaving longPrice alone", async function () {
      const { pool, poolAddress, usdc, trader1 } = await loadFixture(fixture);
      await openShortFor(pool, usdc, poolAddress, trader1, N);

      const spot0 = await pool.spotPrice();
      const long0 = await pool.longPrice();
      const short0 = await pool.shortPrice();

      await time.increase(3 * DAY);
      await (await pool.pokeFunding()).wait();

      expect(await pool.spotPrice()).to.be.gt(spot0);
      expect(await pool.shortPrice()).to.be.gt(short0);
      expect(await pool.longPrice()).to.equal(long0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("shrinks the whole position, not just its collateral", function () {
    it("keeps a long's break-even: collateral and debt fall by the same fraction", async function () {
      const { pool, poolAddress, positionNFT, usdc, trader1 } = await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);
      const pos = await positionNFT.getPosition(id);

      await time.increase(20 * DAY);
      await (await pool.pokeFunding()).wait();

      const [locked, debt] = await pool.liveAmountsOf(id);
      const fromLocked = (locked * BPS) / pos.lockedAmountAtOpen;
      const fromDebt = (debt * BPS) / pos.airUsdMinted;
      expect(fromLocked).to.be.lt(BPS);
      expect(fromLocked).to.be.closeTo(fromDebt, 1n);
    });

    it("charges a winner a share of its profit, not of its mark", async function () {
      const { pool, poolAddress, usdc, trader1, trader2 } = await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);

      const amt = 20_000n * 10n ** 6n;
      await (await usdc.connect(trader2).approve(poolAddress, amt)).wait();
      await (await pool.connect(trader2).swap(amt, 0n, false, trader2.address)).wait();
      await mine(6);

      const [, pnl0] = await pool.quoteClose(id);
      const rem0 = await pool.remainingSizeBps(id);
      expect(pnl0).to.be.gt(0n);

      await time.increase(10 * DAY);
      await mine();

      // A long's close is priced against backedAirUsd and airTokenSupply, and
      // long funding moves neither, so the payout follows the size: what is left
      // of the profit is what is left of the position. The old model took the
      // same fraction of the whole mark out of the profit instead.
      const [, pnl1] = await pool.quoteClose(id);
      const rem1 = await pool.remainingSizeBps(id);
      expect(rem1).to.be.lt(rem0);
      expect(pnl1 * rem0).to.be.closeTo(pnl0 * rem1, (pnl0 * rem1) / 500n);
    });

    it("lets a lone position live longer than the same position on a crowded side", async function () {
      // Utilization is the side's open interest over depth, so the same position
      // decays faster when the rest of its side is crowded.
      async function remainingAfter(extraOi: bigint): Promise<bigint> {
        const { pool, poolAddress, usdc, trader1, trader2, trader3 } = await loadFixture(fixture);
        const id = await openLongFor(pool, usdc, poolAddress, trader1, N);
        if (extraOi > 0n) {
          await openLongFor(pool, usdc, poolAddress, trader2, extraOi);
          await openLongFor(pool, usdc, poolAddress, trader3, extraOi);
        }
        await time.increase(10 * DAY);
        await mine();
        return pool.remainingSizeBps(id);
      }

      const lone = await remainingAfter(0n);
      const crowded = await remainingAfter(15_000n * 10n ** 6n);
      expect(crowded).to.be.lt(lone);
    });

    it("decays open interest with its positions, so the impact fee falls on its own", async function () {
      const { pool, poolAddress, usdc, trader1 } = await loadFixture(fixture);
      await openLongFor(pool, usdc, poolAddress, trader1, 15_000n * 10n ** 6n);

      const oi0 = await pool.longOpenInterest();
      const fee0 = await pool.quoteOpenFee(N, true);

      await time.increase(10 * DAY);
      await (await pool.pokeFunding()).wait();

      expect(await pool.longOpenInterest()).to.be.lt(oi0);
      expect(await pool.quoteOpenFee(N, true)).to.be.lt(fee0);
    });

    it("quotes the open fee off open interest net of funding not yet written", async function () {
      const { pool, poolAddress, usdc, trader1, trader2 } = await loadFixture(fixture);
      await openLongFor(pool, usdc, poolAddress, trader1, 15_000n * 10n ** 6n);
      await time.increase(10 * DAY);
      await mine();

      // No accrual has been written, but the open that uses this quote accrues
      // first — so the quote must already see the smaller open interest, or a
      // router pulling exactly the quoted fee would over-collect.
      const quoted = await pool.quoteOpenFee(N, true);
      const before = await usdc.balanceOf(trader2.address);
      await (await usdc.connect(trader2).approve(poolAddress, quoted)).wait();
      await (await pool.connect(trader2).openLong(N, 0n, trader2.address)).wait();
      const paid = before - (await usdc.balanceOf(trader2.address));
      expect(paid).to.be.lte(quoted);
      expect(paid).to.be.closeTo(quoted, quoted / 10_000n + 1n);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("the rate", function () {
    it("opens at a one-hour window and widens by one second per second", async function () {
      const { pool } = await loadFixture(fixture);
      // The fixture already advanced a day past creation.
      const w0 = await pool.fundingWindow();
      expect(w0).to.be.closeTo(BigInt(HOUR + DAY), 10n);

      await time.increase(7 * DAY);
      await mine();
      expect(await pool.fundingWindow()).to.be.closeTo(BigInt(HOUR + 8 * DAY), 10n);
    });

    it("caps the window at 30 days", async function () {
      const { pool } = await loadFixture(fixture);
      await time.increase(400 * DAY);
      await mine();
      expect(await pool.fundingWindow()).to.equal(BigInt(30 * DAY));
    });

    it("rises with open interest", async function () {
      const { pool, poolAddress, usdc, trader1, trader2 } = await loadFixture(fixture);
      const r0 = await pool.fundingRatePerSecond(true);

      await openLongFor(pool, usdc, poolAddress, trader1, N);
      const r1 = await pool.fundingRatePerSecond(true);
      expect(r1).to.be.gt(r0);

      await openLongFor(pool, usdc, poolAddress, trader2, N * 3n);
      expect(await pool.fundingRatePerSecond(true)).to.be.gt(r1);
    });

    it("prices each side off its own open interest", async function () {
      const { pool, poolAddress, usdc, trader1 } = await loadFixture(fixture);
      await openLongFor(pool, usdc, poolAddress, trader1, N * 4n);

      // Longs are crowded; shorts are not. Each side pays for its own crowding,
      // because the two curves are independent and funding is rent on capital
      // rather than a balancing transfer between the sides.
      expect(await pool.fundingRatePerSecond(true))
        .to.be.gt(await pool.fundingRatePerSecond(false));
    });

    it("stays far below RAY at the utilization cap", async function () {
      const { pool, poolAddress, usdc, trader1, trader2, trader3 } = await loadFixture(fixture);
      for (const t of [trader1, trader2, trader3]) {
        await openLongFor(pool, usdc, poolAddress, t, 15_000n * 10n ** 6n);
      }
      const r = await pool.fundingRatePerSecond(true);
      expect(r).to.be.lt(RAY / 2n);
      expect(r).to.be.gt(0n);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("the aggregate never falls below the sum of its positions", function () {
    it("holds across an arbitrary interleaving of opens, closes, swaps and time", async function () {
      const { pool, poolAddress, positionNFT, usdc, baseToken, trader1, trader2, trader3 } =
        await loadFixture(fixture);

      const open: bigint[] = [];
      const traders = [trader1, trader2, trader3];

      // Deterministic pseudo-random schedule — a fixed seed so a failure is
      // reproducible, but an ordering no hand-written case would have chosen.
      let seed = 1234567n;
      const next = (n: bigint) => { seed = (seed * 1103515245n + 12345n) % (1n << 31n); return seed % n; };

      for (let step = 0; step < 40; step++) {
        const action = next(4n);
        const t = traders[Number(next(3n))];

        if (action === 0n) {
          const notional = (500n + next(2_000n)) * 10n ** 6n;
          open.push(await openLongFor(pool, usdc, poolAddress, t, notional));
        } else if (action === 1n) {
          const notional = (500n + next(2_000n)) * 10n ** 6n;
          open.push(await openShortFor(pool, usdc, poolAddress, t, notional));
        } else if (action === 2n && open.length > 0) {
          const idx = Number(next(BigInt(open.length)));
          const id = open[idx];
          const pos = await positionNFT.getPosition(id);
          const owner = await positionNFT.ownerOf(id);
          const signer = traders.find((s) => s.address === owner);
          const [ready, pnl] = await pool.quoteClose(id);
          if (signer && ready && pnl > 0n) {
            if (pos.isLong) await (await pool.connect(signer).closeLong(id, 0n, signer.address)).wait();
            else await (await pool.connect(signer).closeShort(id, 0n, signer.address)).wait();
            open.splice(idx, 1);
          }
        } else {
          // A swap, to move the curve under the open book.
          const amt = (10n + next(400n)) * 10n ** 18n;
          await (await baseToken.connect(t).approve(poolAddress, amt)).wait();
          await (await pool.connect(t).swap(amt, 0n, true, t.address)).wait();
        }

        await time.increase(Number(next(20_000n)) + 1);
        await (await pool.pokeFunding()).wait();

        // The property under test. _projectFunding rounds the aggregate's
        // retained collateral UP while effectiveLocked rounds each position's
        // DOWN, so the aggregate must always run at or ahead of the sum. The
        // reverse bias would let the last close out of the pool underflow.
        const L = await sumLive(pool, positionNFT, open, true);
        const S = await sumLive(pool, positionNFT, open, false);
        expect(await pool.totalLongCollateral()).to.be.gte(L.locked, `long collateral, step ${step}`);
        expect(await pool.totalShortCollateral()).to.be.gte(S.locked, `short collateral, step ${step}`);
        // The debt and notional aggregates decay by the same factor and are
        // subtracted from at settlement the same way, so the same bound holds.
        expect(await pool.longOpenInterest()).to.be.gte(L.debt, `long debt, step ${step}`);
        expect(await pool.totalShortDebt()).to.be.gte(S.debt, `short debt, step ${step}`);
        expect(await pool.shortOpenInterest()).to.be.gte(S.notional, `short OI, step ${step}`);

        // And both supply identities stay exact through all of it.
        expect(await pool.airUsdSupply()).to.equal(
          (await pool.backedAirUsd()) + (await pool.totalShortCollateral()) +
          (await pool.longOpenInterest()),
          `airUsd identity, step ${step}`);
        expect(await pool.airTokenSupply()).to.equal(
          (await pool.backedAirToken()) + (await pool.totalLongCollateral()) +
          (await pool.totalShortDebt()),
          `airToken identity, step ${step}`);
      }
    });

    it("returns every aggregate to zero once the last position leaves", async function () {
      const { pool, poolAddress, usdc, trader1, creator } = await loadFixture(fixture);
      const a = await openLongFor(pool, usdc, poolAddress, trader1, N);
      const b = await openShortFor(pool, usdc, poolAddress, trader1, N);

      await (await pool.connect(creator).closePool()).wait();
      await time.increase(200 * DAY);
      await (await pool.pokeFunding()).wait();

      await (await pool.sweepDust(a)).wait();
      await (await pool.sweepDust(b)).wait();

      expect(await pool.openPositionCount()).to.equal(0n);
      // The residue left by the opposed rounding is flushed to the LP, so
      // removeLiquidity is not blocked by a few wei of nobody's collateral.
      expect(await pool.totalLongCollateral()).to.equal(0n);
      expect(await pool.totalShortCollateral()).to.equal(0n);
      expect(await pool.longOpenInterest()).to.equal(0n);
      expect(await pool.shortOpenInterest()).to.equal(0n);
      expect(await pool.totalShortDebt()).to.equal(0n);

      await (await pool.connect(creator).removeLiquidity()).wait();
      // With the residue burned, nothing is left in either supply counter.
      expect(await pool.airTokenSupply()).to.equal(0n);
      expect(await pool.airUsdSupply()).to.equal(0n);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("wind-down", function () {
    it("does not bend the rate before closeDate", async function () {
      const { pool, poolAddress, usdc, trader1, creator } = await loadFixture(fixture);
      await openLongFor(pool, usdc, poolAddress, trader1, N);

      const before = await pool.fundingRatePerSecond(true);
      await (await pool.connect(creator).closePool()).wait();

      expect(await pool.windDownShift()).to.equal(0n);
      // Within the grace period the rate is unchanged but for the widening
      // window, which only ever lowers it.
      expect(await pool.fundingRatePerSecond(true)).to.be.lte(before);
    });

    it("doubles the rate once per doubling period past closeDate", async function () {
      const { pool, poolAddress, usdc, trader1, creator } = await loadFixture(fixture);
      await openLongFor(pool, usdc, poolAddress, trader1, N);
      await (await pool.connect(creator).closePool()).wait();

      await time.increase(7 * DAY + 10);
      await mine();
      expect(await pool.windDownShift()).to.equal(0n);

      await time.increase(DAY);
      await mine();
      expect(await pool.windDownShift()).to.equal(1n);

      await time.increase(DAY);
      await mine();
      expect(await pool.windDownShift()).to.equal(2n);
    });

    it("caps the shift so the rate cannot overflow on a long-abandoned pool", async function () {
      const { pool, creator } = await loadFixture(fixture);
      await (await pool.connect(creator).closePool()).wait();
      await time.increase(5 * 365 * DAY);
      await mine();
      expect(await pool.windDownShift()).to.equal(16n);
      expect(await pool.fundingRatePerSecond(true)).to.be.lte(RAY / 2n);
    });

    it("decays an abandoned position to dust about eleven days past closeDate", async function () {
      const { pool, poolAddress, usdc, trader1, creator } = await loadFixture(fixture);
      // The slowest case: a mature market, whose funding window has reached its
      // 30-day ceiling and so charges the lowest base rate there is. A younger
      // market's narrower window only gets there sooner.
      await time.increase(30 * DAY);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);
      await (await pool.connect(creator).closePool()).wait();

      // The LP's exit guarantee expressed as a measurement rather than an
      // assertion in a comment, pinned from both sides so the documented figure
      // cannot drift: still real ten days past closeDate, dust by eleven and a
      // half. Loosening WIND_DOWN_DOUBLING or the funding rate fails the second
      // check; tightening either fails the first.
      const closeDate = await pool.closeDate();
      await time.increaseTo(closeDate + BigInt(10 * DAY));
      await mine();
      expect(await pool.remainingSizeBps(id)).to.be.gt(10n);

      await time.increase(DAY + DAY / 2);
      await (await pool.pokeFunding()).wait();

      // Below the 0.1 % sweep threshold, which is what finally lets the LP out.
      expect(await pool.remainingSizeBps(id)).to.be.lt(10n);
      await expect(pool.sweepDust(id)).to.emit(pool, "PositionSwept");
    });

    it("charges the same whether a stretch is accrued in one step or many", async function () {
      // The property the weighted-elapsed integral exists to guarantee. The
      // wind-down multiplier doubles geometrically, so sampling it once per
      // accrual would make the total charge depend on how often the pool
      // happened to be touched — and a holder who kept it quiet would pay less.
      // Here the same span is charged to two markets built alike, once in a
      // single accrual and once in sixty, and the two must agree.
      const { usdc, factory, creator, trader1 } = await loadFixture(fixture);

      // Two fresh markets created together, so their ages — and therefore their
      // funding windows — track each other for the whole test.
      const MockERC20F = await ethers.getContractFactory("MockERC20");
      const twins: EXNIHILOPool[] = [];
      const twinAddrs: string[] = [];
      for (const name of ["TwinA", "TwinB"]) {
        const tok = await MockERC20F.deploy(name, name, 18);
        await tok.waitForDeployment();
        await (await tok.mint(creator.address, 10n ** 24n)).wait();
        await (await tok.connect(creator).approve(await factory.getAddress(), 10n ** 23n)).wait();
        await (await usdc.connect(creator)
          .approve(await factory.getAddress(), 100_000n * 10n ** 6n)).wait();
        const rc = await (
          await factory.connect(creator).createMarket(
            await tok.getAddress(), 100_000n * 10n ** 6n, 100_000n * 10n ** 18n)
        ).wait();
        let addr = "";
        for (const log of rc!.logs) {
          try {
            const pl = factory.interface.parseLog(log);
            if (pl?.name === "MarketCreated") addr = pl.args[0];
          } catch { /* skip */ }
        }
        twinAddrs.push(addr);
        twins.push((await ethers.getContractAt("EXNIHILOPool", addr)) as unknown as EXNIHILOPool);
      }

      // Past the 1 %→20 % position-cap ramp on both.
      await time.increase(DAY);

      const idOne = await openLongFor(twins[0], usdc, twinAddrs[0], trader1, N);
      const idMany = await openLongFor(twins[1], usdc, twinAddrs[1], trader1, N);

      await (await twins[0].connect(creator).closePool()).wait();
      await (await twins[1].connect(creator).closePool()).wait();

      // Poke the second pool twice a day; leave the first untouched. Both cover
      // the same eleven days — the grace period and four doublings, short of
      // dust, where a difference would still show.
      for (let k = 0; k < 22; k++) {
        await time.increase(DAY / 2);
        await (await twins[1].pokeFunding()).wait();
      }
      await (await twins[0].pokeFunding()).wait();

      const a = await twins[0].remainingSizeBps(idOne);
      const b = await twins[1].remainingSizeBps(idMany);
      expect(a).to.be.lt(9_900n);
      expect(a).to.be.gt(1_000n);
      expect(a).to.be.closeTo(b, 2n);
    });

    it("charges a crowded side the same whether accrued in one step or many", async function () {
      // Open interest decays with funding, so a crowded side's rate falls as it
      // goes. _decayFactor integrates that feedback in closed form; holding the
      // opening rate for the interval would charge the quiet pool more than the
      // busy one.
      const { usdc, factory, creator, trader1, trader2 } = await loadFixture(fixture);
      const one = await freshMarket(factory, usdc, creator, "CrowdA");
      const many = await freshMarket(factory, usdc, creator, "CrowdB");
      await time.increase(DAY); // past the position-cap ramp

      const ids: bigint[] = [];
      for (const m of [one, many]) {
        ids.push(await openLongFor(m.pool, usdc, m.poolAddress, trader1, N));
        await openLongFor(m.pool, usdc, m.poolAddress, trader2, 20_000n * 10n ** 6n);
        await openLongFor(m.pool, usdc, m.poolAddress, trader2, 20_000n * 10n ** 6n);
      }

      for (let k = 0; k < 40; k++) {
        await time.increase(DAY / 2);
        await (await many.pool.pokeFunding()).wait();
      }
      await (await one.pool.pokeFunding()).wait();

      const a = await one.pool.remainingSizeBps(ids[0]);
      const b = await many.pool.remainingSizeBps(ids[1]);
      expect(a).to.be.lt(9_000n); // the utilization term is doing real work
      // The closed form composes exactly. What is left is the numerical integral
      // of the widening window — Simpson's rule on a convex 1/window, which
      // overestimates — so the single long accrual charges a hair MORE, never
      // less, and nobody gains by keeping a pool quiet. The gap grows with the
      // size of the charge, so the tolerance is relative to it.
      expect(a).to.be.lte(b);
      expect(b - a).to.be.lte(b / 1_000n + 2n);
    });

    it("can only be started by the LP; the factory has no role that can", async function () {
      // The factory's emergency deployer role was removed (audit R3, NM-R3-005):
      // closePool decays every open position, and one key able to do that to
      // every pool — launchpad markets included — was more power than a brake needs.
      const { pool, factory, trader1 } = await loadFixture(fixture);
      const factoryDeployer = (await ethers.getSigners())[8];

      for (const who of [factoryDeployer, trader1]) {
        await expect(pool.connect(who).closePool())
          .to.be.revertedWithCustomError(pool, "OnlyLpHolder");
      }
      expect(await pool.closeDate()).to.equal(0n);

      const fns = factory.interface.fragments
        .filter((f: any) => f.type === "function")
        .map((f: any) => f.name);
      expect(fns).to.not.include("deployer");
      expect(fns).to.not.include("setDeployer");
    });

    it("blocks new positions immediately", async function () {
      const { pool, poolAddress, usdc, trader1, creator } = await loadFixture(fixture);
      await (await pool.connect(creator).closePool()).wait();

      const fee = await pool.quoteOpenFee(N, true);
      await (await usdc.connect(trader1).approve(poolAddress, fee * 2n)).wait();
      await expect(pool.connect(trader1).openLong(N, 0n, trader1.address))
        .to.be.revertedWithCustomError(pool, "PoolClosing");
    });

    it("still lets a holder close voluntarily during wind-down", async function () {
      const { pool, poolAddress, usdc, baseToken, trader1, trader2, creator } =
        await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);

      // Push the position into profit so the voluntary path is available.
      const amt = 20_000n * 10n ** 6n;
      await (await usdc.connect(trader2).approve(poolAddress, amt)).wait();
      await (await pool.connect(trader2).swap(amt, 0n, false, trader2.address)).wait();

      await (await pool.connect(creator).closePool()).wait();
      await time.increase(10 * DAY);
      await mine(6);

      const [ready, pnl] = await pool.quoteClose(id);
      expect(ready).to.equal(true);
      if (pnl > 0n) {
        await expect(pool.connect(trader1).closeLong(id, 0n, trader1.address)).to.not.be.reverted;
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("sweepDust", function () {
    it("refuses a position that is not yet dust", async function () {
      const { pool, poolAddress, usdc, trader1 } = await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);

      await time.increase(7 * DAY);
      await expect(pool.sweepDust(id)).to.be.revertedWithCustomError(pool, "PositionNotDust");
    });

    it("lets anyone clear a decayed position", async function () {
      const { pool, poolAddress, usdc, trader1, trader3, creator } = await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);

      await (await pool.connect(creator).closePool()).wait();
      await time.increase(120 * DAY);
      await (await pool.pokeFunding()).wait();

      // trader3 has no stake in this position at all.
      await expect(pool.connect(trader3).sweepDust(id))
        .to.emit(pool, "PositionSwept");
      expect(await pool.openPositionCount()).to.equal(0n);
    });

    it("finds the debt already burned by funding, and retires the rest", async function () {
      const { pool, poolAddress, positionNFT, usdc, trader1, creator } = await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);
      const debtAtOpen = (await positionNFT.getPosition(id)).airUsdMinted;

      await (await pool.connect(creator).closePool()).wait();
      await time.increase(120 * DAY);
      await (await pool.pokeFunding()).wait();

      // Collateral and debt decay together, so by the time a position is dust its
      // debt is dust too — the curve stopped carrying it long before the sweep.
      const [, debtLeft] = await pool.liveAmountsOf(id);
      expect(debtLeft * 1_000n).to.be.lte(debtAtOpen);

      const supplyBefore = await pool.airUsdSupply();
      await (await pool.sweepDust(id)).wait();
      expect(supplyBefore - (await pool.airUsdSupply())).to.be.gte(debtLeft);
      expect(await pool.longOpenInterest()).to.equal(0n);
    });

    it("rejects a position from another pool", async function () {
      const { pool, poolAddress, usdc, trader1, factory, baseToken, creator } =
        await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);
      expect(id).to.be.gte(0n);

      const MockERC20F = await ethers.getContractFactory("MockERC20");
      const other = await MockERC20F.deploy("Other", "OTH", 18);
      await other.waitForDeployment();
      await (await other.mint(creator.address, 10n ** 24n)).wait();
      await (await other.connect(creator).approve(await factory.getAddress(), 10n ** 24n)).wait();
      await (await usdc.connect(creator).approve(await factory.getAddress(), 10_000n * 10n ** 6n)).wait();
      const rc = await (
        await factory.connect(creator).createMarket(
          await other.getAddress(), 10_000n * 10n ** 6n, 10n ** 22n)
      ).wait();
      let other2 = "";
      for (const log of rc!.logs) {
        try {
          const p = factory.interface.parseLog(log);
          if (p?.name === "MarketCreated") other2 = p.args[0];
        } catch { /* skip */ }
      }
      const pool2 = await ethers.getContractAt("EXNIHILOPool", other2);
      await expect(pool2.sweepDust(id))
        .to.be.revertedWithCustomError(pool2, "PositionNotFromThisPool");
      expect(baseToken).to.not.equal(undefined);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("quotes see funding that has not been written yet", function () {
    it("prices a close net of unaccrued funding", async function () {
      const { pool, poolAddress, usdc, trader1, trader2 } = await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);

      const amt = 20_000n * 10n ** 6n;
      await (await usdc.connect(trader2).approve(poolAddress, amt)).wait();
      await (await pool.connect(trader2).swap(amt, 0n, false, trader2.address)).wait();
      await mine(6);

      const [, pnlFresh] = await pool.quoteClose(id);

      // Ten days pass with nobody touching the pool. The stored index is stale,
      // but the quote must not be: a holder reading it should see what they will
      // actually get, not what they would have got ten days ago.
      await time.increase(10 * DAY);
      await mine();
      const [, pnlStale] = await pool.quoteClose(id);
      expect(pnlStale).to.be.lt(pnlFresh);

      // And the executed close agrees with the quote to within a block of drift.
      const before = await usdc.balanceOf(trader1.address);
      await (await pool.connect(trader1).closeLong(id, 0n, trader1.address)).wait();
      const got = (await usdc.balanceOf(trader1.address)) - before;
      expect(got).to.be.closeTo(pnlStale, pnlStale / 1000n + 10n);
    });

    it("reports effectiveLockedOf net of unaccrued funding", async function () {
      const { pool, poolAddress, usdc, trader1 } = await loadFixture(fixture);
      const id = await openLongFor(pool, usdc, poolAddress, trader1, N);

      const atOpen = await pool.effectiveLockedOf(id);
      await time.increase(10 * DAY);
      await mine();

      // No mutation has happened, so the stored index is unchanged — but the
      // view projects.
      expect(await pool.fundingIndexLong()).to.equal(RAY);
      expect(await pool.effectiveLockedOf(id)).to.be.lt(atOpen);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("reserve identities", function () {
    it("keeps airUsdSupply == backedAirUsd + longOI + shortCollateral", async function () {
      const { pool, poolAddress, usdc, trader1, trader2 } = await loadFixture(fixture);
      await openLongFor(pool, usdc, poolAddress, trader1, N);
      await openShortFor(pool, usdc, poolAddress, trader2, N * 2n);

      for (let i = 0; i < 4; i++) {
        await time.increase(2 * DAY);
        await (await pool.pokeFunding()).wait();
        expect(await pool.airUsdSupply()).to.equal(
          (await pool.backedAirUsd()) +
          (await pool.longOpenInterest()) +
          (await pool.totalShortCollateral()),
        );
      }
    });

    it("keeps airTokenSupply == backedAirToken + longCollateral + shortDebt", async function () {
      const { pool, poolAddress, positionNFT, usdc, trader1, trader2 } = await loadFixture(fixture);
      const a = await openLongFor(pool, usdc, poolAddress, trader1, N);
      const b = await openShortFor(pool, usdc, poolAddress, trader2, N * 2n);
      expect(a).to.not.equal(b);

      const shortDebtAtOpen = (await positionNFT.getPosition(b)).airTokenMinted;
      expect(await pool.totalShortDebt()).to.equal(shortDebtAtOpen);

      for (let i = 0; i < 4; i++) {
        await time.increase(2 * DAY);
        await (await pool.pokeFunding()).wait();
        expect(await pool.airTokenSupply()).to.equal(
          (await pool.backedAirToken()) +
          (await pool.totalLongCollateral()) +
          (await pool.totalShortDebt()),
        );
      }
      // The short's debt decayed with it rather than standing at its opening size.
      expect(await pool.totalShortDebt()).to.be.lt(shortDebtAtOpen);
    });
  });
});
