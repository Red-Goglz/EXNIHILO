import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time, mine } from "@nomicfoundation/hardhat-network-helpers";
import { AtomicManipulator, EXNIHILOPool, MockERC20 } from "../typechain-types";

/**
 * Moving the price and trading against the move in one transaction (audit R4,
 * NM-R4-001 and NM-R4-002). Before the fix, a position opened and closed in the
 * same transaction had no clamp reference, and opens had no clamp at all:
 * measured +$17,467 and +$4,356 per $100k of pool USDC. Swaps are split into
 * chunks, as an attacker would split them, so the spot-value swap fee stays ~1 %.
 */

const USDC = 10n ** 6n;
const TOKEN = 10n ** 18n;
const DAY = 24 * 3600;
const CLAMP_BLOCKS = 5;

async function fixture() {
  const signers = await ethers.getSigners();
  const [deployer, treasury, creator, trader, mover] = signers;

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

  const att = (await (await ethers.getContractFactory("AtomicManipulator"))
    .deploy(addr, await usdc.getAddress(), await token.getAddress())) as unknown as AtomicManipulator;
  const attAddr = await att.getAddress();
  await usdc.mint(attAddr, 10_000_000n * USDC);
  await token.mint(attAddr, 1_000_000n * TOKEN);

  for (const s of [trader, mover]) {
    await usdc.mint(s.address, 10_000_000n * USDC);
    await token.mint(s.address, 1_000_000n * TOKEN);
    await usdc.connect(s).approve(addr, ethers.MaxUint256);
    await token.connect(s).approve(addr, ethers.MaxUint256);
  }

  await time.increase(DAY); // past the position-cap ramp
  await mine(CLAMP_BLOCKS + 1); // nothing recent in the ring
  return { pool, addr, usdc, token, positionNFT, att, attAddr, trader, mover };
}

/** EXNIHILOPool._cpAmountOut. */
function cp(a: bigint, ri: bigint, ro: bigint): bigint {
  if (ri === 0n || ro === 0n) return 0n;
  const raw = (a * ro) / (ri + a);
  const fn = a * ro * 100n, fd = ri * 10_000n;
  const fee = fn === 0n ? 0n : (fn + fd - 1n) / fd;
  return raw <= fee ? 0n : raw - fee;
}

describe("Atomic manipulation — a position cannot trade against its own transaction's move", function () {
  describe("closing (NM-R4-001)", function () {
    it("refuses a short opened, dumped against and closed in one transaction", async function () {
      const { pool, att } = await loadFixture(fixture);
      await expect(att.shortDumpClose(20_000n * USDC, 1n, 95_000n * TOKEN, 1n))
        .to.be.revertedWithCustomError(pool, "PositionUnderwater");
    });

    it("refuses it with the dump split into chunks and three shorts", async function () {
      const { pool, att } = await loadFixture(fixture);
      await expect(att.shortDumpClose(20_000n * USDC, 3n, 580_000n * TOKEN, 20n))
        .to.be.revertedWithCustomError(pool, "PositionUnderwater");
    });

    it("refuses the long mirror with a chunked pump", async function () {
      const { pool, att } = await loadFixture(fixture);
      await expect(att.longPumpClose(20_000n * USDC, 220_000n * USDC, 20n))
        .to.be.revertedWithCustomError(pool, "PositionUnderwater");
    });

    it("sizes an open-block snapshot at the opening size, across a flush", async function () {
      const { pool, att, trader, positionNFT } = await loadFixture(fixture);
      // The only position decays to dust, so sweeping it flushes and rebases the index.
      await pool.connect(trader).openLong(20_000n * USDC, 0n, trader.address);
      const dustId = (await positionNFT.totalSupply()) - 1n;
      await time.increase(8 * 365 * DAY);
      await pool.pokeFunding();
      const pos = await positionNFT.getPosition(dustId);
      expect((await pool.effectiveLockedOf(dustId)) * 10_000n).to.be.lte(pos.lockedAmountAtOpen * 10n);
      expect(await pool.fundingIndexLong()).to.be.lt(10n ** 24n); // < 0.001 RAY

      await att.sweepThenOpenLong(dustId, 10_000n * USDC);
      const id = await att.lastId();
      expect(await pool.fundingIndexLong()).to.equal(10n ** 27n);

      // The open block's snapshot carries the pre-flush index. Sized by it, the new
      // position would be valued at under a thousandth of its size; at opening size
      // the snapshot prices it exactly as live does (the sweep moved neither SWAP-3 reserve).
      const [readyClamped, clamped] = await pool.quoteClose(id);
      const [readyLive, live] = await pool.quoteCloseUnclamped(id);
      expect(readyClamped).to.equal(true);
      expect(readyLive).to.equal(true);
      expect(clamped).to.equal(live);
    });
  });

  describe("opening (NM-R4-002)", function () {
    it("gives no profit to a short opened against its own pump", async function () {
      const { pool, att, usdc, attAddr } = await loadFixture(fixture);
      const u0 = await usdc.balanceOf(attAddr);
      await att.pumpOpenShort(160_000n * USDC, 30_000n * USDC, 2n, 20n);
      expect(await usdc.balanceOf(attAddr)).to.be.lt(u0);
      await mine(2 * CLAMP_BLOCKS);
      await expect(att.closeHeld()).to.be.revertedWithCustomError(pool, "PositionUnderwater");
    });

    it("gives no profit to a long opened against its own dump", async function () {
      const { pool, att } = await loadFixture(fixture);
      await att.dumpOpenLong(160_000n * TOKEN, 10_000n * USDC, 20n);
      await mine(2 * CLAMP_BLOCKS);
      await expect(att.closeHeld()).to.be.revertedWithCustomError(pool, "PositionUnderwater");
    });

    it("prices an open at the worst block open in the window, then at live once it passes", async function () {
      const { pool, trader, mover, positionNFT } = await loadFixture(fixture);
      const N = 5_000n * USDC;
      const [before] = await pool.quoteOpen(N, true);
      expect(before).to.equal(cp(N, await pool.airUsdSupply(), await pool.backedAirToken()));

      // A dump makes longs cheaper at live reserves; the open still pays the pre-dump price.
      await pool.connect(mover).swap(30_000n * TOKEN, 0n, true, mover.address);
      const liveAfterDump = cp(N, await pool.airUsdSupply(), await pool.backedAirToken());
      expect(liveAfterDump).to.be.gt(before);
      const [quoted] = await pool.quoteOpen(N, true);
      expect(quoted).to.equal(before);

      await pool.connect(trader).openLong(N, quoted, trader.address);
      const opened = await positionNFT.getPosition((await positionNFT.totalSupply()) - 1n);
      expect(opened.lockedAmountAtOpen).to.equal(quoted);

      await mine(CLAMP_BLOCKS + 1);
      const [later] = await pool.quoteOpen(N, true);
      expect(later).to.equal(cp(N, await pool.airUsdSupply(), await pool.backedAirToken()));
    });

    it("quotes a short exactly as it opens, at the pre-pump terms", async function () {
      const { pool, trader, mover, positionNFT } = await loadFixture(fixture);
      await pool.connect(mover).swap(20_000n * USDC, 0n, false, mover.address); // shorts now sell higher
      const N = 8_000n * USDC;
      const TS = await pool.airTokenSupply(), Y = await pool.backedAirUsd();
      const liveDebt = (N * TS) / Y;
      const liveLocked = cp(liveDebt, TS, Y);

      const [locked, debt] = await pool.quoteOpen(N, false);
      expect(debt).to.be.gt(liveDebt);     // more tokens owed at the lower pre-pump price
      expect(locked).to.be.lte(liveLocked);

      await pool.connect(trader).openShort(N, locked, trader.address);
      const opened = await positionNFT.getPosition((await positionNFT.totalSupply()) - 1n);
      expect(opened.lockedAmountAtOpen).to.equal(locked);
      expect(opened.airTokenMinted).to.equal(debt);
    });
  });
});
