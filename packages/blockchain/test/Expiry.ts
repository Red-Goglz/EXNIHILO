import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import {
  EXNIHILOPool,
  EXNIHILOFactory,
  LpNFT,
  PositionNFT,
  MockERC20,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const INITIAL_USDC   = ethers.parseUnits("10000", 6);   // 10,000 USDC (6 dec)
const INITIAL_TOKEN  = ethers.parseEther("1000000");     // 1,000,000 token (18 dec)
const TRADER_USDC    = ethers.parseUnits("1000", 6);     // 1,000 USDC per trader
const TRADER_TOKEN   = ethers.parseEther("10000");       // 10,000 token per trader
const SWAP_FEE_BPS   = 100n;                             // 1 %
const BPS_DENOM      = 10_000n;
const LP_FEE_BPS     = 300n;                             // 3 %
const PROTO_FEE_BPS  = 200n;                             // 2 %

// Hard caps large enough not to interfere with most tests
const MAX_POS_USD = ethers.parseUnits("9000", 6); // 9,000 USDC hard cap
const MAX_POS_BPS = 9000n;                        // 90 % of backedAirUsd

const SEVEN_DAYS  = 7n * 24n * 60n * 60n;         // 604800
const ONE_HOUR    = 3600n;
const ONE_YEAR    = 365n * 24n * 60n * 60n;

// ─────────────────────────────────────────────────────────────────────────────
// Bytecode-patch helper  (mirrors EXNIHILOPool.ts)
// ─────────────────────────────────────────────────────────────────────────────

async function patchImmutableAddress(
  contractAddress: string,
  fromAddress: string,
  toAddress: string
): Promise<void> {
  const bytecode = await ethers.provider.getCode(contractAddress);
  const raw = bytecode.slice(2).toLowerCase();
  const fromPadded = "000000000000000000000000" + fromAddress.toLowerCase().slice(2);
  const toPadded   = "000000000000000000000000" + toAddress.toLowerCase().slice(2);

  if (!raw.includes(fromPadded)) {
    throw new Error(
      `patchImmutableAddress: ${fromAddress} not found in bytecode of ${contractAddress}`
    );
  }

  const patched = raw.split(fromPadded).join(toPadded);
  await ethers.provider.send("hardhat_setCode", [contractAddress, "0x" + patched]);
}

async function deploySystem(
  treasuryAddr: string,
  positionNFTAddr: string,
  usdcAddr: string
): Promise<{ factory: EXNIHILOFactory; lpNft: LpNFT }> {
  const signers = await ethers.getSigners();
  const throwaway   = signers[7];
  const sysDeployer = signers[8];

  const lpNft = (await (await ethers.getContractFactory("LpNFT"))
    .connect(throwaway)
    .deploy(throwaway.address)) as unknown as LpNFT;

  const poolDeployer = await (await ethers.getContractFactory("PoolDeployer")).connect(sysDeployer).deploy();

  const factory = (await (await ethers.getContractFactory("EXNIHILOFactory"))
    .connect(sysDeployer)
    .deploy(
      positionNFTAddr,
      await lpNft.getAddress(),
      usdcAddr,
      treasuryAddr,
      SWAP_FEE_BPS,
      await poolDeployer.getAddress()
    )) as unknown as EXNIHILOFactory;

  const factoryAddr = await factory.getAddress();

  await patchImmutableAddress(await lpNft.getAddress(), throwaway.address, factoryAddr);

  const patchedFactory = await lpNft.factory();
  if (patchedFactory.toLowerCase() !== factoryAddr.toLowerCase()) {
    throw new Error(
      `LpNFT.factory mismatch after patch: expected=${factoryAddr} got=${patchedFactory}`
    );
  }

  return { factory, lpNft };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture  (default 7-day duration via positionDuration = 0)
// ─────────────────────────────────────────────────────────────────────────────

async function deployPoolFixture() {
  const [deployer, treasury, creator, trader1, trader2, trader3, other] =
    await ethers.getSigners();

  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const baseToken = (await MockERC20F.connect(deployer).deploy("PEPE", "PEPE", 18)) as unknown as MockERC20;
  const usdc      = (await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6)) as unknown as MockERC20;
  const positionNFT = (await (await ethers.getContractFactory("PositionNFT"))
    .connect(deployer).deploy()) as unknown as PositionNFT;

  const { factory, lpNft } = await deploySystem(
    treasury.address,
    await positionNFT.getAddress(),
    await usdc.getAddress()
  );

  const factoryAddr = await factory.getAddress();
  await positionNFT.connect(deployer).initFactory(factoryAddr);

  await baseToken.mint(creator.address, INITIAL_TOKEN);
  await usdc.mint(creator.address, INITIAL_USDC);
  await baseToken.connect(creator).approve(factoryAddr, ethers.MaxUint256);
  await usdc.connect(creator).approve(factoryAddr, ethers.MaxUint256);

  // positionDuration = 0 → defaults to 7 days
  const tx = await factory.connect(creator).createMarket(
    await baseToken.getAddress(),
    INITIAL_USDC,
    INITIAL_TOKEN,
    MAX_POS_USD,
    MAX_POS_BPS,
    0n,
    "airPEPE",
    "airPEPEUsd",
    18
  );
  const receipt = await tx.wait();

  const iface = factory.interface;
  const log = receipt!.logs
    .map((l) => { try { return iface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "MarketCreated")!;

  const poolAddress: string = log.args.pool;
  const lpNftId: bigint     = log.args.lpNftId;

  const pool = (await ethers.getContractAt("EXNIHILOPool", poolAddress)) as EXNIHILOPool;

  for (const trader of [trader1, trader2, trader3, other]) {
    await usdc.mint(trader.address, TRADER_USDC * 10n);
    await baseToken.mint(trader.address, TRADER_TOKEN * 10n);
    await usdc.connect(trader).approve(poolAddress, ethers.MaxUint256);
    await baseToken.connect(trader).approve(poolAddress, ethers.MaxUint256);
  }

  return {
    pool, factory, positionNFT, lpNft, baseToken, usdc,
    deployer, treasury, creator, trader1, trader2, trader3, other,
    poolAddress, lpNftId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture with custom 1-hour duration
// ─────────────────────────────────────────────────────────────────────────────

async function deployPoolFixture1h() {
  const [deployer, treasury, creator, trader1, trader2, trader3, other] =
    await ethers.getSigners();

  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const baseToken = (await MockERC20F.connect(deployer).deploy("PEPE", "PEPE", 18)) as unknown as MockERC20;
  const usdc      = (await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6)) as unknown as MockERC20;
  const positionNFT = (await (await ethers.getContractFactory("PositionNFT"))
    .connect(deployer).deploy()) as unknown as PositionNFT;

  const { factory, lpNft } = await deploySystem(
    treasury.address,
    await positionNFT.getAddress(),
    await usdc.getAddress()
  );

  const factoryAddr = await factory.getAddress();
  await positionNFT.connect(deployer).initFactory(factoryAddr);

  await baseToken.mint(creator.address, INITIAL_TOKEN);
  await usdc.mint(creator.address, INITIAL_USDC);
  await baseToken.connect(creator).approve(factoryAddr, ethers.MaxUint256);
  await usdc.connect(creator).approve(factoryAddr, ethers.MaxUint256);

  // positionDuration = 1 hour
  const tx = await factory.connect(creator).createMarket(
    await baseToken.getAddress(),
    INITIAL_USDC,
    INITIAL_TOKEN,
    MAX_POS_USD,
    MAX_POS_BPS,
    ONE_HOUR,
    "airPEPE",
    "airPEPEUsd",
    18
  );
  const receipt = await tx.wait();

  const iface = factory.interface;
  const log = receipt!.logs
    .map((l) => { try { return iface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "MarketCreated")!;

  const poolAddress: string = log.args.pool;
  const lpNftId: bigint     = log.args.lpNftId;

  const pool = (await ethers.getContractAt("EXNIHILOPool", poolAddress)) as EXNIHILOPool;

  for (const trader of [trader1, trader2, trader3, other]) {
    await usdc.mint(trader.address, TRADER_USDC * 10n);
    await baseToken.mint(trader.address, TRADER_TOKEN * 10n);
    await usdc.connect(trader).approve(poolAddress, ethers.MaxUint256);
    await baseToken.connect(trader).approve(poolAddress, ethers.MaxUint256);
  }

  return {
    pool, factory, positionNFT, lpNft, baseToken, usdc,
    deployer, treasury, creator, trader1, trader2, trader3, other,
    poolAddress, lpNftId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction helpers
// ─────────────────────────────────────────────────────────────────────────────

async function openLong(
  pool: EXNIHILOPool,
  trader: HardhatEthersSigner,
  usdcAmount: bigint
): Promise<bigint> {
  const tx = await pool.connect(trader).openLong(usdcAmount, 0n, trader.address);
  const receipt = await tx.wait();
  const log = receipt!.logs
    .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "PositionOpened")!;
  return log.args.nftId as bigint;
}

async function openShort(
  pool: EXNIHILOPool,
  trader: HardhatEthersSigner,
  usdcAmount: bigint
): Promise<bigint> {
  const tx = await pool.connect(trader).openShort(usdcAmount, 0n, trader.address);
  const receipt = await tx.wait();
  const log = receipt!.logs
    .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "PositionOpened")!;
  return log.args.nftId as bigint;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Expiry: cliff-based position expiry", function () {

  // ═════════════════════════════════════════════════════════════════════════════
  // 1. Position Duration Configuration
  // ═════════════════════════════════════════════════════════════════════════════

  describe("1. Position Duration Configuration", function () {

    it("positionDuration defaults to 7 days when 0 is passed to createMarket", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.positionDuration()).to.equal(SEVEN_DAYS);
    });

    it("custom duration (1 hour) works", async function () {
      const { pool } = await loadFixture(deployPoolFixture1h);
      expect(await pool.positionDuration()).to.equal(ONE_HOUR);
    });

  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 2. Deadline Tracking
  // ═════════════════════════════════════════════════════════════════════════════

  describe("2. Deadline Tracking", function () {

    it("Position NFT stores correct deadline (openedAt + positionDuration)", async function () {
      const { pool, positionNFT, trader1 } = await loadFixture(deployPoolFixture);
      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      const pos = await positionNFT.getPosition(nftId);
      expect(pos.deadline).to.equal(pos.openedAt + SEVEN_DAYS);
    });

    it("deadline is visible via getPosition()", async function () {
      const { pool, positionNFT, trader1 } = await loadFixture(deployPoolFixture);
      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      const pos = await positionNFT.getPosition(nftId);
      // deadline should be in the future (roughly now + 7 days)
      const latest = BigInt(await time.latest());
      expect(pos.deadline).to.be.gte(latest + SEVEN_DAYS - 10n);
      expect(pos.deadline).to.be.lte(latest + SEVEN_DAYS + 10n);
    });

    it("different pools can have different deadlines (1h vs 7d)", async function () {
      const fix7d = await loadFixture(deployPoolFixture);
      const fix1h = await loadFixture(deployPoolFixture1h);

      const nft7d = await openLong(fix7d.pool, fix7d.trader1, ethers.parseUnits("100", 6));
      const nft1h = await openLong(fix1h.pool, fix1h.trader1, ethers.parseUnits("100", 6));

      const pos7d = await fix7d.positionNFT.getPosition(nft7d);
      const pos1h = await fix1h.positionNFT.getPosition(nft1h);

      expect(pos7d.deadline - pos7d.openedAt).to.equal(SEVEN_DAYS);
      expect(pos1h.deadline - pos1h.openedAt).to.equal(ONE_HOUR);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 3. renewPosition
  // ═════════════════════════════════════════════════════════════════════════════

  describe("3. renewPosition", function () {

    it("charges base fee (5% of notional): check USDC transfer and lpFeesAccumulated", async function () {
      const { pool, positionNFT, usdc, treasury, trader1, other } =
        await loadFixture(deployPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      const pos = await positionNFT.getPosition(nftId);
      const notional = pos.airUsdMinted; // for longs, notional = airUsdMinted

      const protocolFee = (notional * PROTO_FEE_BPS) / BPS_DENOM;
      const lpFee       = (notional * LP_FEE_BPS)    / BPS_DENOM;
      const totalFee    = protocolFee + lpFee;

      // Fund and approve the renewer
      await usdc.mint(other.address, totalFee * 2n);
      await usdc.connect(other).approve(await pool.getAddress(), ethers.MaxUint256);

      const lpFeesBefore    = await pool.lpFeesAccumulated();
      const treasuryBefore  = await usdc.balanceOf(treasury.address);
      const otherUsdcBefore = await usdc.balanceOf(other.address);

      await pool.connect(other).renewPosition(nftId);

      // LP fees increased by lpFee
      expect(await pool.lpFeesAccumulated()).to.equal(lpFeesBefore + lpFee);
      // Treasury received protocolFee
      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore + protocolFee);
      // Caller spent totalFee
      expect(await usdc.balanceOf(other.address)).to.equal(otherUsdcBefore - totalFee);
    });

    it("extends deadline by positionDuration from current deadline", async function () {
      const { pool, positionNFT, usdc, trader1 } = await loadFixture(deployPoolFixture);
      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));

      const posBefore = await positionNFT.getPosition(nftId);
      const oldDeadline = posBefore.deadline;

      // Renew before expiry
      await pool.connect(trader1).renewPosition(nftId);

      const posAfter = await positionNFT.getPosition(nftId);
      expect(posAfter.deadline).to.equal(oldDeadline + SEVEN_DAYS);
    });

    it("anyone can renew (not just the holder)", async function () {
      const { pool, positionNFT, usdc, trader1, other } =
        await loadFixture(deployPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));

      // Fund other
      await usdc.mint(other.address, ethers.parseUnits("1000", 6));
      await usdc.connect(other).approve(await pool.getAddress(), ethers.MaxUint256);

      // Should not revert — other is not the holder
      await expect(pool.connect(other).renewPosition(nftId)).to.not.be.reverted;
    });

    it("works for both long and short positions", async function () {
      const { pool, positionNFT, usdc, trader1 } = await loadFixture(deployPoolFixture);

      const longId  = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      const shortId = await openShort(pool, trader1, ethers.parseUnits("100", 6));

      const longBefore  = await positionNFT.getPosition(longId);
      const shortBefore = await positionNFT.getPosition(shortId);

      await pool.connect(trader1).renewPosition(longId);
      await pool.connect(trader1).renewPosition(shortId);

      const longAfter  = await positionNFT.getPosition(longId);
      const shortAfter = await positionNFT.getPosition(shortId);

      expect(longAfter.deadline).to.equal(longBefore.deadline + SEVEN_DAYS);
      expect(shortAfter.deadline).to.equal(shortBefore.deadline + SEVEN_DAYS);
    });

    it("can renew an already-expired position (extends from now, not from old deadline)", async function () {
      const { pool, positionNFT, usdc, trader1 } = await loadFixture(deployPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));

      // Fast-forward past expiry (7 days + 1 day extra)
      await time.increase(Number(SEVEN_DAYS) + 86400);

      await pool.connect(trader1).renewPosition(nftId);

      const posAfter = await positionNFT.getPosition(nftId);
      const latest   = BigInt(await time.latest());

      // New deadline should be approximately now + 7 days
      // (since the position was expired, base = block.timestamp)
      expect(posAfter.deadline).to.be.gte(latest + SEVEN_DAYS - 10n);
      expect(posAfter.deadline).to.be.lte(latest + SEVEN_DAYS + 10n);
    });

    it("renewPosition succeeds and charges the correct fee", async function () {
      const { pool, positionNFT, usdc, trader1 } = await loadFixture(deployPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      const pos   = await positionNFT.getPosition(nftId);

      const notional    = pos.airUsdMinted;
      const protocolFee = (notional * PROTO_FEE_BPS) / BPS_DENOM;
      const lpFee       = (notional * LP_FEE_BPS)    / BPS_DENOM;
      const totalFee    = protocolFee + lpFee;

      const expectedNewDeadline = pos.deadline + SEVEN_DAYS;

      const usdcBefore = await usdc.balanceOf(trader1.address);
      await pool.connect(trader1).renewPosition(nftId);
      const usdcAfter = await usdc.balanceOf(trader1.address);
      expect(usdcBefore - usdcAfter).to.equal(totalFee);

      const posAfter = await positionNFT.getPosition(nftId);
      expect(posAfter.deadline).to.equal(expectedNewDeadline);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 4. closePositionAfterDeadline — profitable
  // ═════════════════════════════════════════════════════════════════════════════

  describe("4. closePositionAfterDeadline — profitable", function () {

    /** Open a long, pump the price, then advance time past expiry. */
    async function withProfitableExpiredLong() {
      const base = await deployPoolFixture();
      const nftId = await openLong(base.pool, base.trader1, ethers.parseUnits("100", 6));

      // Pump token price: swap 2000 USDC → token
      const pumpUsdc = ethers.parseUnits("2000", 6);
      await base.usdc.mint(base.trader2.address, pumpUsdc);
      await base.pool.connect(base.trader2).swap(pumpUsdc, 0n, false, base.trader2.address);

      // Advance past expiry
      await time.increase(Number(SEVEN_DAYS) + 1);

      return { ...base, nftId };
    }

    /** Open a short, dump the price, then advance time past expiry. */
    async function withProfitableExpiredShort() {
      const base = await deployPoolFixture();
      const nftId = await openShort(base.pool, base.trader1, ethers.parseUnits("100", 6));

      // Dump token price: swap a large amount of token → USDC
      const dumpToken = ethers.parseEther("500000");
      await base.baseToken.mint(base.trader2.address, dumpToken);
      await base.pool.connect(base.trader2).swap(dumpToken, 0n, true, base.trader2.address);

      // Advance past expiry
      await time.increase(Number(SEVEN_DAYS) + 1);

      return { ...base, nftId };
    }

    it("reverts with PositionNotExpired before deadline", async function () {
      const { pool, trader1 } = await loadFixture(deployPoolFixture);
      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));

      // Should revert — deadline not reached
      await expect(
        pool.connect(trader1).closePositionAfterDeadline(nftId, 0n)
      ).to.be.revertedWithCustomError(pool, "PositionNotExpired");
    });

    it("after deadline, anyone can close a profitable long (holder receives USDC minus 1% fee)", async function () {
      const { pool, usdc, trader1, other, nftId } =
        await loadFixture(withProfitableExpiredLong);

      const holderUsdcBefore = await usdc.balanceOf(trader1.address);

      // Other (not the holder) closes the expired position
      await pool.connect(other).closePositionAfterDeadline(nftId, 0n);

      const holderUsdcAfter = await usdc.balanceOf(trader1.address);
      // Holder should have received USDC profit
      expect(holderUsdcAfter).to.be.gt(holderUsdcBefore);
    });

    it("after deadline, anyone can close a profitable short", async function () {
      const { pool, usdc, trader1, other, nftId } =
        await loadFixture(withProfitableExpiredShort);

      const holderUsdcBefore = await usdc.balanceOf(trader1.address);

      await pool.connect(other).closePositionAfterDeadline(nftId, 0n);

      const holderUsdcAfter = await usdc.balanceOf(trader1.address);
      expect(holderUsdcAfter).to.be.gt(holderUsdcBefore);
    });

    it("emits PositionClosedAfterDeadline with payout > 0", async function () {
      const { pool, other, nftId } = await loadFixture(withProfitableExpiredLong);

      await expect(pool.connect(other).closePositionAfterDeadline(nftId, 0n))
        .to.emit(pool, "PositionClosedAfterDeadline")
        .withArgs(nftId, other.address, (v: bigint) => v > 0n);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 5. closePositionAfterDeadline — underwater
  // ═════════════════════════════════════════════════════════════════════════════

  describe("5. closePositionAfterDeadline — underwater", function () {

    /** Open a long, crash the price, advance past expiry. */
    async function withUnderwaterExpiredLong() {
      const base = await deployPoolFixture();
      const nftId = await openLong(base.pool, base.trader1, ethers.parseUnits("500", 6));

      // Crash: dump token into pool to push down price
      const dump = ethers.parseEther("5000000");
      await base.baseToken.mint(base.trader2.address, dump);
      await base.pool.connect(base.trader2).swap(dump, 0n, true, base.trader2.address);

      await time.increase(Number(SEVEN_DAYS) + 1);
      return { ...base, nftId };
    }

    /** Open a short, pump the price, advance past expiry. */
    async function withUnderwaterExpiredShort() {
      const base = await deployPoolFixture();
      const nftId = await openShort(base.pool, base.trader1, ethers.parseUnits("500", 6));

      // Pump: swap lots of USDC → token to push up price
      const pump = ethers.parseUnits("5000", 6);
      await base.usdc.mint(base.trader2.address, pump);
      await base.pool.connect(base.trader2).swap(pump, 0n, false, base.trader2.address);

      await time.increase(Number(SEVEN_DAYS) + 1);
      return { ...base, nftId };
    }

    it("underwater long after deadline: collateral returns to LP, no payout to holder", async function () {
      const { pool, usdc, trader1, other, nftId } =
        await loadFixture(withUnderwaterExpiredLong);

      const holderUsdcBefore  = await usdc.balanceOf(trader1.address);
      const backedTokenBefore = await pool.backedAirToken();

      await pool.connect(other).closePositionAfterDeadline(nftId, 0n);

      // Holder did NOT receive USDC
      expect(await usdc.balanceOf(trader1.address)).to.equal(holderUsdcBefore);
      // backedAirToken increased (collateral returned to LP)
      expect(await pool.backedAirToken()).to.be.gt(backedTokenBefore);
    });

    it("underwater short after deadline: collateral returns to LP, no payout to holder", async function () {
      const { pool, usdc, trader1, other, nftId } =
        await loadFixture(withUnderwaterExpiredShort);

      const holderUsdcBefore = await usdc.balanceOf(trader1.address);
      const backedUsdBefore  = await pool.backedAirUsd();

      await pool.connect(other).closePositionAfterDeadline(nftId, 0n);

      // Holder did NOT receive USDC
      expect(await usdc.balanceOf(trader1.address)).to.equal(holderUsdcBefore);
      // backedAirUsd increased (collateral returned to LP)
      expect(await pool.backedAirUsd()).to.be.gt(backedUsdBefore);
    });

    it("emits PositionClosedAfterDeadline with payout = 0", async function () {
      const { pool, other, nftId } = await loadFixture(withUnderwaterExpiredLong);

      await expect(pool.connect(other).closePositionAfterDeadline(nftId, 0n))
        .to.emit(pool, "PositionClosedAfterDeadline")
        .withArgs(nftId, other.address, 0n);
    });

    it("openPositionCount decrements", async function () {
      const { pool, other, nftId } = await loadFixture(withUnderwaterExpiredLong);

      const countBefore = await pool.openPositionCount();
      await pool.connect(other).closePositionAfterDeadline(nftId, 0n);
      expect(await pool.openPositionCount()).to.equal(countBefore - 1n);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 6. Holder can still close before deadline
  // ═════════════════════════════════════════════════════════════════════════════

  describe("6. Holder can still close before deadline", function () {

    it("closeLong works before deadline (holder closes own position normally)", async function () {
      const { pool, usdc, trader1, trader2 } = await loadFixture(deployPoolFixture);
      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));

      // Pump price to make it profitable
      const pump = ethers.parseUnits("2000", 6);
      await usdc.mint(trader2.address, pump);
      await pool.connect(trader2).swap(pump, 0n, false, trader2.address);

      const holderBefore = await usdc.balanceOf(trader1.address);

      // Close before deadline — should work
      await pool.connect(trader1).closeLong(nftId, 0n);

      expect(await usdc.balanceOf(trader1.address)).to.be.gt(holderBefore);
    });

    it("closeShort works before deadline", async function () {
      const { pool, baseToken, usdc, trader1, trader2 } = await loadFixture(deployPoolFixture);
      const nftId = await openShort(pool, trader1, ethers.parseUnits("100", 6));

      // Dump price to make short profitable
      const dump = ethers.parseEther("500000");
      await baseToken.mint(trader2.address, dump);
      await pool.connect(trader2).swap(dump, 0n, true, trader2.address);

      const holderBefore = await usdc.balanceOf(trader1.address);

      // Close before deadline
      await pool.connect(trader1).closeShort(nftId, 0n);

      expect(await usdc.balanceOf(trader1.address)).to.be.gt(holderBefore);
    });
  });
});
