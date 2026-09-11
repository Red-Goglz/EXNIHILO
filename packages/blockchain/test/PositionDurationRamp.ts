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
// Position lifetime is not a parameter. It steps with market age:
//   < 1h → 1h,  < 8h → 8h,  < 24h → 24h,  < 7d → 7d,  >= 7d → 30d (ceiling).
//
// The non-decreasing property is load-bearing: closePool sets
// closeDate = now + currentPositionDuration(), and the guarantee that every
// outstanding position has expired by closeDate depends on no earlier position
// having been issued a longer lifetime.
// ─────────────────────────────────────────────────────────────────────────────

const SWAP_FEE_BPS = 100n;

const ONE_HOUR    = 3_600n;
const EIGHT_HOURS = 8n * ONE_HOUR;
const ONE_DAY     = 86_400n;
const ONE_WEEK    = 7n * ONE_DAY;
const THIRTY_DAYS = 30n * ONE_DAY;

const INITIAL_USDC  = ethers.parseUnits("100000", 6);
const INITIAL_TOKEN = ethers.parseEther("1000000");

/** Expected lifetime for a market of the given age. */
function durationAt(age: bigint): bigint {
  if (age < ONE_HOUR) return ONE_HOUR;
  if (age < EIGHT_HOURS) return EIGHT_HOURS;
  if (age < ONE_DAY) return ONE_DAY;
  if (age < ONE_WEEK) return ONE_WEEK;
  return THIRTY_DAYS;
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
  const usdc = (await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6)) as unknown as MockERC20;

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
    await token.getAddress(), INITIAL_USDC, INITIAL_TOKEN
  );

  const poolAddr = await factory.allPools(0);
  const pool = (await ethers.getContractAt("EXNIHILOPool", poolAddr)) as unknown as EXNIHILOPool;

  await usdc.mint(trader.address, ethers.parseUnits("1000000", 6));
  await usdc.connect(trader).approve(poolAddr, ethers.MaxUint256);

  return {
    deployer, treasury, creator, trader, token, usdc, factory, positionNFT,
    pool, poolAddr, createdAt: await pool.createdAt(),
  };
}

/** Open a long and return its NFT id. */
async function openLong(
  pool: EXNIHILOPool,
  trader: { address: string } & Parameters<EXNIHILOPool["connect"]>[0],
  notional: bigint
): Promise<bigint> {
  const tx = await pool.connect(trader).openLong(notional, 0n, trader.address);
  const receipt = await tx.wait();
  const log = receipt!.logs
    .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "PositionOpened")!;
  return log.args.nftId as bigint;
}

// ═════════════════════════════════════════════════════════════════════════════

describe("Position duration ramp", () => {

  describe("currentPositionDuration", () => {
    it("is 1 hour in the creation block", async () => {
      const base = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("MockERC20");
      const token2 = (await F.connect(base.deployer).deploy("D", "D", 18)) as unknown as MockERC20;
      await token2.mint(base.creator.address, INITIAL_TOKEN);
      await token2.connect(base.creator).approve(await base.factory.getAddress(), ethers.MaxUint256);
      await base.usdc.mint(base.creator.address, INITIAL_USDC);

      await base.factory.connect(base.creator).createMarket(
        await token2.getAddress(), INITIAL_USDC, INITIAL_TOKEN
      );
      const pool2 = await ethers.getContractAt("EXNIHILOPool", await base.factory.allPools(1));

      expect(await pool2.currentPositionDuration()).to.equal(ONE_HOUR);
    });

    it("steps at each boundary", async () => {
      const { pool, createdAt } = await loadFixture(deployFixture);

      for (const age of [
        0n, ONE_HOUR - 1n,
        ONE_HOUR, EIGHT_HOURS - 1n,
        EIGHT_HOURS, ONE_DAY - 1n,
        ONE_DAY, ONE_WEEK - 1n,
        ONE_WEEK, ONE_WEEK + 1n,
      ]) {
        if (age > 0n) await time.increaseTo(createdAt + age);
        expect(await pool.currentPositionDuration(), `age=${age}`).to.equal(durationAt(age));
      }
    });

    it("holds at 30 days forever", async () => {
      const { pool, createdAt } = await loadFixture(deployFixture);
      await time.increaseTo(createdAt + ONE_WEEK * 200n);
      expect(await pool.currentPositionDuration()).to.equal(THIRTY_DAYS);
    });

    it("never decreases", async () => {
      // closePool's guarantee depends on this.
      const { pool, createdAt } = await loadFixture(deployFixture);
      let previous = await pool.currentPositionDuration();

      // Hourly for the first day so the 1h/8h/24h steps are all crossed, then
      // sparser out past the week boundary.
      for (let h = 1n; h <= 200n; h += (h < 26n ? 1n : 7n)) {
        await time.increaseTo(createdAt + h * 3600n);
        const now = await pool.currentPositionDuration();
        expect(now).to.be.gte(previous);
        previous = now;
      }
      expect(previous).to.equal(THIRTY_DAYS);
    });
  });

  describe("Applied to positions", () => {
    it("a position opened in a young market expires in an hour", async () => {
      const { pool, positionNFT, trader } = await loadFixture(deployFixture);
      const nftId = await openLong(pool, trader, ethers.parseUnits("100", 6));
      const pos = await positionNFT.getPosition(nftId);
      expect(pos.deadline - pos.openedAt).to.equal(ONE_HOUR);
    });

    it("issues 8-hour positions once past the first hour", async () => {
      const { pool, positionNFT, trader, createdAt } = await loadFixture(deployFixture);
      await time.increaseTo(createdAt + ONE_HOUR);

      const nftId = await openLong(pool, trader, ethers.parseUnits("500", 6));
      const pos = await positionNFT.getPosition(nftId);
      expect(pos.deadline - pos.openedAt).to.equal(EIGHT_HOURS);
    });

    it("issues 24-hour positions once past eight hours", async () => {
      const { pool, positionNFT, trader, createdAt } = await loadFixture(deployFixture);
      await time.increaseTo(createdAt + EIGHT_HOURS);

      const nftId = await openLong(pool, trader, ethers.parseUnits("1000", 6));
      const pos = await positionNFT.getPosition(nftId);
      expect(pos.deadline - pos.openedAt).to.equal(ONE_DAY);
    });

    it("the same market issues 7-day positions a day later", async () => {
      const { pool, positionNFT, trader, createdAt } = await loadFixture(deployFixture);
      await time.increaseTo(createdAt + ONE_DAY);

      const nftId = await openLong(pool, trader, ethers.parseUnits("1000", 6));
      const pos = await positionNFT.getPosition(nftId);
      expect(pos.deadline - pos.openedAt).to.equal(ONE_WEEK);
    });

    it("and 30-day positions once past a week", async () => {
      const { pool, positionNFT, trader, createdAt } = await loadFixture(deployFixture);
      await time.increaseTo(createdAt + ONE_WEEK);

      const nftId = await openLong(pool, trader, ethers.parseUnits("1000", 6));
      const pos = await positionNFT.getPosition(nftId);
      expect(pos.deadline - pos.openedAt).to.equal(THIRTY_DAYS);
    });

    it("an existing position keeps the lifetime it was opened under", async () => {
      // The step applies at open time; it never retroactively extends anyone.
      const { pool, positionNFT, trader, createdAt } = await loadFixture(deployFixture);
      const nftId = await openLong(pool, trader, ethers.parseUnits("100", 6));
      const before = await positionNFT.getPosition(nftId);

      await time.increaseTo(createdAt + ONE_WEEK);

      const after = await positionNFT.getPosition(nftId);
      expect(after.deadline).to.equal(before.deadline);
    });
  });

  describe("closePool coverage guarantee", () => {
    it("closeDate is at or beyond every outstanding deadline", async () => {
      // The reason the ramp must be non-decreasing: a position opened earlier
      // was issued a shorter (or equal) lifetime from an earlier start, so
      // now + currentDuration always covers it.
      const { pool, positionNFT, trader, creator, createdAt } = await loadFixture(deployFixture);

      const young = await openLong(pool, trader, ethers.parseUnits("100", 6));

      await time.increaseTo(createdAt + EIGHT_HOURS);
      const mid = await openLong(pool, trader, ethers.parseUnits("800", 6));

      await time.increaseTo(createdAt + ONE_DAY);
      const older = await openLong(pool, trader, ethers.parseUnits("1000", 6));

      await time.increaseTo(createdAt + ONE_WEEK);
      await pool.connect(creator).closePool();

      const closeDate = await pool.closeDate();
      for (const id of [young, mid, older]) {
        const pos = await positionNFT.getPosition(id);
        expect(closeDate).to.be.gte(pos.deadline);
      }
    });

    it("uses the duration current at close time", async () => {
      const { pool, creator, createdAt } = await loadFixture(deployFixture);
      await time.increaseTo(createdAt + ONE_WEEK);

      await pool.connect(creator).closePool();

      const closeDate = await pool.closeDate();
      const at = BigInt(await time.latest());
      expect(closeDate).to.equal(at + THIRTY_DAYS);
    });
  });

  describe("Immutability", () => {
    it("exposes no duration parameter or setter", async () => {
      const { pool, factory } = await loadFixture(deployFixture);

      const fns = pool.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => (f as { name: string }).name);
      expect(fns).to.not.include("positionDuration");
      expect(fns).to.not.include("setPositionDuration");
      expect(fns).to.include("currentPositionDuration");

      expect(factory.interface.getFunction("createMarket").inputs.map((i) => i.name))
        .to.deep.equal(["tokenAddress", "usdcAmount", "tokenAmount"]);
    });
  });
});
