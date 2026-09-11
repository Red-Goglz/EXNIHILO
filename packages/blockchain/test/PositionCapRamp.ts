import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type {
  EXNIHILOFactory,
  EXNIHILOPool,
  LpNFT,
  MockERC20,
  PositionNFT,
} from "../typechain-types";

// ─────────────────────────────────────────────────────────────────────────────
// The per-position cap is not a parameter. It ramps linearly from 1 % of
// backedAirUsd at market creation to 20 % after 24 hours, then holds. Nobody —
// creator, LP holder, or deployer — can move it.
// ─────────────────────────────────────────────────────────────────────────────

const SWAP_FEE_BPS = 100n;
const BPS_DENOM    = 10_000n;

const START_BPS     = 100n;    // 1 %
const MAX_BPS       = 2_000n;  // 20 %
const RAMP_DURATION = 24n * 3600n;

const INITIAL_USDC  = ethers.parseUnits("100000", 6);
const INITIAL_TOKEN = ethers.parseEther("1000000");

/** Expected cap in bps at `elapsed` seconds after creation. */
function bpsAt(elapsed: bigint): bigint {
  if (elapsed >= RAMP_DURATION) return MAX_BPS;
  return START_BPS + ((MAX_BPS - START_BPS) * elapsed) / RAMP_DURATION;
}

/** See test/EXNIHILOFactory.ts for why LpNFT's factory immutable is patched. */
async function patchImmutableAddress(
  contractAddress: string,
  fromAddress: string,
  toAddress: string
): Promise<void> {
  const bytecode = await ethers.provider.getCode(contractAddress);
  const raw = bytecode.slice(2).toLowerCase();
  const fromPadded = "000000000000000000000000" + fromAddress.toLowerCase().slice(2);
  const toPadded = "000000000000000000000000" + toAddress.toLowerCase().slice(2);
  if (!raw.includes(fromPadded)) {
    throw new Error(`patchImmutableAddress: ${fromAddress} not found in ${contractAddress}`);
  }
  await ethers.provider.send("hardhat_setCode", [
    contractAddress,
    "0x" + raw.split(fromPadded).join(toPadded),
  ]);
}

async function deployFixture() {
  const signers = await ethers.getSigners();
  const [deployer, treasury, creator, trader] = signers;
  const throwaway = signers[7];
  const sysDeployer = signers[8];

  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const token = (await MockERC20F.connect(deployer).deploy("PEPE", "PEPE", 18)) as unknown as MockERC20;
  const usdc  = (await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6)) as unknown as MockERC20;

  const positionNFT = (await (await ethers.getContractFactory("PositionNFT"))
    .connect(deployer).deploy()) as unknown as PositionNFT;
  const lpNft = (await (await ethers.getContractFactory("LpNFT"))
    .connect(throwaway).deploy(throwaway.address)) as unknown as LpNFT;
  const poolDeployer = await (await ethers.getContractFactory("PoolDeployer"))
    .connect(sysDeployer).deploy();

  const factory = (await (await ethers.getContractFactory("EXNIHILOFactory"))
    .connect(sysDeployer)
    .deploy(
      await positionNFT.getAddress(), await lpNft.getAddress(), await usdc.getAddress(),
      treasury.address, await poolDeployer.getAddress()
    )) as unknown as EXNIHILOFactory;

  const factoryAddr = await factory.getAddress();
  await patchImmutableAddress(await lpNft.getAddress(), throwaway.address, factoryAddr);
  await positionNFT.connect(deployer).initFactory(factoryAddr);

  await token.mint(creator.address, INITIAL_TOKEN);
  await usdc.mint(creator.address, INITIAL_USDC);
  await token.connect(creator).approve(factoryAddr, ethers.MaxUint256);
  await usdc.connect(creator).approve(factoryAddr, ethers.MaxUint256);

  await factory.connect(creator).createMarket(
    await token.getAddress(), INITIAL_USDC, INITIAL_TOKEN);

  const poolAddr = await factory.allPools(0);
  const pool = (await ethers.getContractAt("EXNIHILOPool", poolAddr)) as unknown as EXNIHILOPool;

  await usdc.mint(trader.address, ethers.parseUnits("10000000", 6));
  await usdc.connect(trader).approve(poolAddr, ethers.MaxUint256);

  const createdAt = await pool.createdAt();
  return { deployer, treasury, creator, trader, token, usdc, factory, pool, poolAddr, createdAt };
}

// ═════════════════════════════════════════════════════════════════════════════

describe("Position cap ramp", () => {

  describe("currentMaxPositionBps", () => {
    it("starts at 1 % in the creation block", async () => {
      // Read in the same block the market was created in, before it can tick.
      const base = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("MockERC20");
      const token2 = (await F.connect(base.deployer).deploy("D", "D", 18)) as unknown as MockERC20;
      await token2.mint(base.creator.address, INITIAL_TOKEN);
      await token2.connect(base.creator).approve(await base.factory.getAddress(), ethers.MaxUint256);
      await base.usdc.mint(base.creator.address, INITIAL_USDC);

      await base.factory.connect(base.creator).createMarket(
        await token2.getAddress(), INITIAL_USDC, INITIAL_TOKEN);
      const pool2 = await ethers.getContractAt("EXNIHILOPool", await base.factory.allPools(1));

      expect(await pool2.currentMaxPositionBps()).to.equal(START_BPS);
    });

    it("ramps linearly across the first 24 hours", async () => {
      const { pool, createdAt } = await loadFixture(deployFixture);

      for (const elapsed of [3600n, 6n * 3600n, 12n * 3600n, 18n * 3600n, 23n * 3600n]) {
        await time.increaseTo(createdAt + elapsed);
        expect(await pool.currentMaxPositionBps()).to.equal(bpsAt(elapsed));
      }
    });

    it("is exactly halfway at 12 hours", async () => {
      const { pool, createdAt } = await loadFixture(deployFixture);
      await time.increaseTo(createdAt + RAMP_DURATION / 2n);
      expect(await pool.currentMaxPositionBps()).to.equal((START_BPS + MAX_BPS) / 2n); // 10.5 %
    });

    it("reaches 20 % exactly at 24 hours", async () => {
      const { pool, createdAt } = await loadFixture(deployFixture);
      await time.increaseTo(createdAt + RAMP_DURATION);
      expect(await pool.currentMaxPositionBps()).to.equal(MAX_BPS);
    });

    it("holds at 20 % indefinitely", async () => {
      const { pool, createdAt } = await loadFixture(deployFixture);
      await time.increaseTo(createdAt + RAMP_DURATION * 365n);
      expect(await pool.currentMaxPositionBps()).to.equal(MAX_BPS);
    });

    it("never decreases", async () => {
      const { pool, createdAt } = await loadFixture(deployFixture);
      let previous = await pool.currentMaxPositionBps();

      for (let h = 1n; h <= 26n; h++) {
        await time.increaseTo(createdAt + h * 3600n);
        const now = await pool.currentMaxPositionBps();
        expect(now).to.be.gte(previous);
        previous = now;
      }
      expect(previous).to.equal(MAX_BPS);
    });
  });

  describe("effectiveLeverageCap", () => {
    it("applies the current bps to live pool depth", async () => {
      const { pool, createdAt } = await loadFixture(deployFixture);

      await time.increaseTo(createdAt + 6n * 3600n);
      const expected = ((await pool.backedAirUsd()) * bpsAt(6n * 3600n)) / BPS_DENOM;
      expect(await pool.effectiveLeverageCap()).to.equal(expected);
    });

    it("moves with pool depth as well as the clock", async () => {
      const { pool, trader, token, poolAddr, createdAt } = await loadFixture(deployFixture);
      await time.increaseTo(createdAt + RAMP_DURATION);

      const before = await pool.effectiveLeverageCap();

      // Deepen the USDC side with a swap; the cap is a fraction of it.
      await pool.connect(trader).swap(ethers.parseUnits("50000", 6), 0n, false, trader.address);

      const after = await pool.effectiveLeverageCap();
      expect(after).to.be.greaterThan(before);
      expect(after).to.equal(((await pool.backedAirUsd()) * MAX_BPS) / BPS_DENOM);
    });

    it("is 1 % of depth on a brand-new market", async () => {
      const { pool } = await loadFixture(deployFixture);
      // Only a couple of blocks have elapsed, so the ramp has barely moved.
      const cap = await pool.effectiveLeverageCap();
      const onePercent = ((await pool.backedAirUsd()) * START_BPS) / BPS_DENOM;
      expect(cap).to.be.gte(onePercent);
      expect(cap).to.be.lt((onePercent * 101n) / 100n);
    });
  });

  describe("Enforcement", () => {
    it("rejects a long above the cap and accepts one at it", async () => {
      const { pool, trader, createdAt } = await loadFixture(deployFixture);
      await time.increaseTo(createdAt + RAMP_DURATION);

      const cap = await pool.effectiveLeverageCap();

      await expect(
        pool.connect(trader).openLong(cap + 1n, 0n, trader.address)
      ).to.be.revertedWithCustomError(pool, "LeverageCapExceeded");

      await expect(pool.connect(trader).openLong(cap, 0n, trader.address)).to.not.be.reverted;
    });

    it("rejects a short above the cap and accepts one at it", async () => {
      const { pool, trader, createdAt } = await loadFixture(deployFixture);
      await time.increaseTo(createdAt + RAMP_DURATION);

      const cap = await pool.effectiveLeverageCap();

      await expect(
        pool.connect(trader).openShort(cap + 1n, 0n, trader.address)
      ).to.be.revertedWithCustomError(pool, "LeverageCapExceeded");

      await expect(pool.connect(trader).openShort(cap, 0n, trader.address)).to.not.be.reverted;
    });

    it("blocks at creation a size that is allowed a day later", async () => {
      // The whole point: the volatile opening period is the tightest.
      const { pool, trader, createdAt } = await loadFixture(deployFixture);

      const dayOneCap = ((await pool.backedAirUsd()) * MAX_BPS) / BPS_DENOM;

      await expect(
        pool.connect(trader).openLong(dayOneCap, 0n, trader.address)
      ).to.be.revertedWithCustomError(pool, "LeverageCapExceeded");

      await time.increaseTo(createdAt + RAMP_DURATION);
      await expect(
        pool.connect(trader).openLong(dayOneCap, 0n, trader.address)
      ).to.not.be.reverted;
    });

    it("widens progressively — each hour admits more than the last", async () => {
      const { pool, trader, createdAt } = await loadFixture(deployFixture);

      // A size rejected at t=0 but accepted at 12 h.
      await time.increaseTo(createdAt + 3600n);
      const atOneHour = await pool.effectiveLeverageCap();

      await time.increaseTo(createdAt + 12n * 3600n);
      const atTwelve = await pool.effectiveLeverageCap();
      expect(atTwelve).to.be.greaterThan(atOneHour);

      // The one-hour ceiling is comfortably inside the twelve-hour one.
      await expect(
        pool.connect(trader).openLong(atOneHour * 2n, 0n, trader.address)
      ).to.not.be.reverted;
    });
  });

  describe("Immutability", () => {
    it("exposes no setter and no cap parameters", async () => {
      const { pool } = await loadFixture(deployFixture);
      const fns = pool.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => (f as { name: string }).name);

      for (const gone of ["setPositionCaps", "maxPositionUsd", "maxPositionBps"]) {
        expect(fns).to.not.include(gone);
      }
      expect(fns).to.include("currentMaxPositionBps");
      expect(fns).to.include("createdAt");
    });

    it("createMarket takes no cap or duration arguments", async () => {
      const { factory } = await loadFixture(deployFixture);
      const frag = factory.interface.getFunction("createMarket");
      expect(frag.inputs.map((i) => i.name)).to.deep.equal(
        ["tokenAddress", "usdcAmount", "tokenAmount"]
      );
    });

    it("is identical for the LP holder and everyone else", async () => {
      const { pool, creator, trader, deployer, createdAt } = await loadFixture(deployFixture);
      await time.increaseTo(createdAt + RAMP_DURATION);

      const cap = await pool.effectiveLeverageCap();
      for (const who of [creator, trader, deployer]) {
        expect(await pool.connect(who).currentMaxPositionBps()).to.equal(MAX_BPS);
      }
      expect(cap).to.be.greaterThan(0n);
    });
  });
});
