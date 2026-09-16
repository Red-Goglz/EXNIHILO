import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time, mine } from "@nomicfoundation/hardhat-network-helpers";
import { EXNIHILOPool, MockERC20 } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Audit R3 PoC scaffolding — not a regression suite. Archived outside the repo after the round.

const DAY = 24 * 3600;
const USDC = 10n ** 6n;
const TOKEN = 10n ** 18n;
const CLAMP_BLOCKS = 5;

async function fixture() {
  const signers = await ethers.getSigners();
  const [deployer, treasury, creator, trader1, trader2, victim] = signers;
  const M = await ethers.getContractFactory("MockERC20");
  const usdc = await M.deploy("USD Coin", "USDC", 6);
  const token = await M.deploy("Base", "BASE", 18);
  const positionNFT = await (await ethers.getContractFactory("PositionNFT")).deploy();
  const sys = signers[8];
  const poolDeployer = await (await ethers.getContractFactory("PoolDeployer")).connect(sys).deploy();
  const predicted = ethers.getCreateAddress({ from: sys.address, nonce: await sys.getNonce() });
  const lpNft = await (await ethers.getContractFactory("LpNFT")).deploy(predicted);
  const factory = await (await ethers.getContractFactory("EXNIHILOFactory")).connect(sys).deploy(
    await positionNFT.getAddress(), await lpNft.getAddress(), await usdc.getAddress(),
    treasury.address, await poolDeployer.getAddress());
  await positionNFT.initFactory(await factory.getAddress());
  for (const s of [creator, trader1, trader2, victim]) {
    await usdc.mint(s.address, 10_000_000n * USDC);
    await token.mint(s.address, 1_000_000n * TOKEN);
  }
  await usdc.connect(creator).approve(await factory.getAddress(), 100_000n * USDC);
  await token.connect(creator).approve(await factory.getAddress(), 100_000n * TOKEN);
  const rc = await (await factory.connect(creator).createMarket(
    await token.getAddress(), 100_000n * USDC, 100_000n * TOKEN)).wait();
  let addr = "";
  for (const l of rc!.logs) { try { const p = factory.interface.parseLog(l); if (p?.name === "MarketCreated") addr = p.args[0]; } catch {} }
  const pool = (await ethers.getContractAt("EXNIHILOPool", addr)) as unknown as EXNIHILOPool;
  // A twin market created one block later, for one-step-vs-many comparisons.
  const token2 = await M.deploy("Twin", "TWIN", 18);
  await token2.mint(creator.address, 100_000n * TOKEN);
  await usdc.connect(creator).approve(await factory.getAddress(), 100_000n * USDC);
  await token2.connect(creator).approve(await factory.getAddress(), 100_000n * TOKEN);
  const rc2 = await (await factory.connect(creator).createMarket(
    await token2.getAddress(), 100_000n * USDC, 100_000n * TOKEN)).wait();
  let addr2 = "";
  for (const l of rc2!.logs) { try { const p = factory.interface.parseLog(l); if (p?.name === "MarketCreated") addr2 = p.args[0]; } catch {} }
  const pool2 = (await ethers.getContractAt("EXNIHILOPool", addr2)) as unknown as EXNIHILOPool;
  await time.increase(DAY); // past the cap ramp
  return { pool, addr, pool2, addr2, usdc, token, positionNFT, creator, trader1, trader2, victim };
}

async function open(pool: EXNIHILOPool, usdc: MockERC20, addr: string, who: HardhatEthersSigner,
                    notional: bigint, isLong: boolean): Promise<bigint> {
  const fee = await pool.quoteOpenFee(notional, isLong);
  await usdc.connect(who).approve(addr, fee * 2n);
  const tx = isLong ? pool.connect(who).openLong(notional, 0n, who.address)
                    : pool.connect(who).openShort(notional, 0n, who.address);
  const rc = await (await tx).wait();
  for (const l of rc!.logs) { try { const p = pool.interface.parseLog(l); if (p?.name === "PositionOpened") return p.args[0]; } catch {} }
  throw new Error("no PositionOpened");
}

async function releasedOnPoke(pool: EXNIHILOPool): Promise<{ released: bigint; elapsed: bigint }> {
  const rc = await (await pool.pokeFunding()).wait();
  let released = 0n, elapsed = 0n;
  for (const l of rc!.logs) {
    try { const p = pool.interface.parseLog(l);
      if (p?.name === "FundingAccrued" && p.args[0] === false) { released = p.args[1]; elapsed = p.args[4]; }
    } catch {}
  }
  return { released, elapsed };
}

describe("AUDIT R3 PoC — F-1 frozen funding clock", function () {
  const N = 10_000n * USDC;
  const GAP = 30 * DAY;

  it("control: an empty short book forgives idle time", async function () {
    const { pool, addr, usdc, trader1, victim } = await loadFixture(fixture);
    await open(pool, usdc, addr, trader1, N, true);          // long book non-empty
    await time.increase(GAP);
    const id = await open(pool, usdc, addr, victim, N, false);
    const r = await releasedOnPoke(pool);
    const bps = await pool.remainingSizeBps(id);
    console.log(`      control: remainingSizeBps=${bps} released=${r.released} elapsed=${r.elapsed}s`);
    expect(bps).to.be.gte(9_999n);
  });

  it("organic: residue from a closed short freezes the clock and bills the next short", async function () {
    const { pool, addr, usdc, token, trader1, trader2, victim } = await loadFixture(fixture);
    await open(pool, usdc, addr, trader1, N, true);          // long stays open throughout
    const s = await open(pool, usdc, addr, trader2, N, false);
    await time.increase(3600);
    await token.connect(trader1).approve(addr, 30_000n * TOKEN);
    await pool.connect(trader1).swap(30_000n * TOKEN, 0n, true, trader1.address); // price down
    await mine(CLAMP_BLOCKS);
    await pool.connect(trader2).closeShort(s, 0n, trader2.address);

    const tsc = await pool.totalShortCollateral();
    const frozenAt = await pool.lastFundingShort();
    console.log(`      after last short closed: openPositionCount=${await pool.openPositionCount()} totalShortCollateral=${tsc} shortOI=${await pool.shortOpenInterest()}`);
    expect(await pool.openPositionCount()).to.equal(1n);
    expect(tsc).to.be.gt(0n);

    // A month of ordinary trading: every swap accrues, the short clock never moves.
    for (let i = 0; i < 6; i++) {
      await time.increase(GAP / 6);
      await usdc.connect(trader1).approve(addr, 100n * USDC);
      await pool.connect(trader1).swap(100n * USDC, 0n, false, trader1.address);
    }
    expect(await pool.lastFundingShort()).to.equal(frozenAt);

    const id = await open(pool, usdc, addr, victim, N, false);
    const [lockedAtOpen] = await pool.liveAmountsOf(id); // view already projects the charge
    const posAtOpen = await (await ethers.getContractAt("PositionNFT", await pool.positionNFT())).getPosition(id);
    const r = await releasedOnPoke(pool);
    const bps = await pool.remainingSizeBps(id);
    console.log(`      victim opened ${ethers.formatUnits(N, 6)} USDC short; collateral at open ${ethers.formatUnits(posAtOpen.lockedAmountAtOpen, 6)}`);
    console.log(`      one block later: remainingSizeBps=${bps}, released to LP=${ethers.formatUnits(r.released, 6)} USDC, elapsed billed=${Number(r.elapsed) / DAY} days`);
    expect(bps).to.be.lt(9_000n);
  });

  it("long side, 18-dec token: residue in totalLongCollateral freezes the long clock", async function () {
    const { pool, addr, usdc, trader1, trader2, victim } = await loadFixture(fixture);
    await open(pool, usdc, addr, trader1, N, false);         // short stays open throughout
    const l = await open(pool, usdc, addr, trader2, N, true);
    await time.increase(3600);
    await usdc.connect(trader1).approve(addr, 40_000n * USDC);
    await pool.connect(trader1).swap(40_000n * USDC, 0n, false, trader1.address); // price up
    await mine(CLAMP_BLOCKS);
    await pool.connect(trader2).closeLong(l, 0n, trader2.address);

    const tlc = await pool.totalLongCollateral();
    const frozenAt = await pool.lastFundingLong();
    console.log(`      after last long closed: totalLongCollateral=${tlc} wei, longOI=${await pool.longOpenInterest()}`);
    expect(tlc).to.be.gt(0n);

    await time.increase(GAP);
    await pool.pokeFunding();
    expect(await pool.lastFundingLong()).to.equal(frozenAt);

    const id = await open(pool, usdc, addr, victim, N, true);
    await pool.pokeFunding();
    const bps = await pool.remainingSizeBps(id);
    console.log(`      long victim one block after open: remainingSizeBps=${bps}`);
    expect(bps).to.be.lt(9_000n);
  });

  it("attacker: a 3-unit short (0.05 USDC fee) pins totalShortCollateral at 1 forever", async function () {
    const { pool, addr, usdc, creator, trader1, victim } = await loadFixture(fixture);
    await open(pool, usdc, addr, trader1, N, true);
    const dust = await open(pool, usdc, addr, creator, 3n, false);
    console.log(`      dust short: totalShortCollateral=${await pool.totalShortCollateral()}`);
    expect(await pool.totalShortCollateral()).to.equal(1n);

    await time.increase(GAP);
    await expect(pool.sweepDust(dust)).to.be.revertedWithCustomError(pool, "PositionNotDust");

    const id = await open(pool, usdc, addr, victim, N, false);
    const r = await releasedOnPoke(pool);
    const bps = await pool.remainingSizeBps(id);
    console.log(`      victim one block after open: remainingSizeBps=${bps}, released to LP=${ethers.formatUnits(r.released, 6)} USDC, elapsed billed=${Number(r.elapsed) / DAY} days`);
    expect(bps).to.be.lt(9_000n);
  });

  it("wind-down: how long the 1-unit dust blocks LP exit vs a real position", async function () {
    const { pool, addr, usdc, creator, trader1 } = await loadFixture(fixture);
    const real = await open(pool, usdc, addr, trader1, N, false);
    const dust = await open(pool, usdc, addr, creator, 3n, false);
    await pool.connect(creator).closePool();
    let realDay = -1, dustDay = -1;
    for (let d = 1; d <= 45 && (realDay < 0 || dustDay < 0); d++) {
      await time.increase(DAY);
      await pool.pokeFunding();
      if (realDay < 0) { try { await pool.sweepDust.staticCall(real); realDay = d; } catch {} }
      if (dustDay < 0) { try { await pool.sweepDust.staticCall(dust); dustDay = d; } catch {} }
    }
    console.log(`      days after closePool until sweepable: real 10k short=${realDay}, 3-unit dust=${dustDay}`);
  });

  it("wind-down: a LONE 1-unit dust short, the only position on the pool", async function () {
    const { pool, addr, usdc, creator } = await loadFixture(fixture);
    const dust = await open(pool, usdc, addr, creator, 3n, false);
    await time.increase(30 * DAY);
    await pool.connect(creator).closePool();
    let dustDay = -1;
    for (let d = 1; d <= 60 && dustDay < 0; d++) {
      await time.increase(DAY);
      await pool.pokeFunding();
      try { await pool.sweepDust.staticCall(dust); dustDay = d; } catch {}
    }
    console.log(`      lone dust: days after closePool until sweepable=${dustDay}; removeLiquidity blocked until then`);
  });
});

describe("AUDIT R3 PoC — C8 short-side path dependence", function () {
  it("crowded short side: one accrual vs forty", async function () {
    const { pool, addr, pool2, addr2, usdc, trader1, trader2, victim } = await loadFixture(fixture);
    const ids: bigint[] = [];
    for (const [p, a] of [[pool, addr], [pool2, addr2]] as [EXNIHILOPool, string][]) {
      await open(p, usdc, a, trader1, 15_000n * USDC, false);
      await open(p, usdc, a, trader2, 12_000n * USDC, false);
      ids.push(await open(p, usdc, a, victim, 10_000n * USDC, false));
    }
    for (let k = 0; k < 40; k++) { await time.increase(DAY / 2); await pool2.pokeFunding(); }
    await pool.pokeFunding();
    const one = await pool.remainingSizeBps(ids[0]);
    const many = await pool2.remainingSizeBps(ids[1]);
    console.log(`      remainingSizeBps one-step=${one} forty-steps=${many} (existing long-side test tolerates b/1000+2)`);
  });
});
