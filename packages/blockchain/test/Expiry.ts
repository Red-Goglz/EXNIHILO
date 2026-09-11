import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time, mine } from "@nomicfoundation/hardhat-network-helpers";
import {
  EXNIHILOPool,
  EXNIHILOFactory,
  LpNFT,
  PositionNFT,
  MockERC20,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Mine past the expiry settlement guard window (EXNIHILOPool
// SETTLE_GUARD_BLOCKS): these price moves are far above the 1 %-of-reserves
// arming threshold, and the tests then jump days of wall time — hundreds of
// thousands of Avalanche blocks — before a third party settles.
const SETTLE_GUARD_BLOCKS = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const INITIAL_USDC   = ethers.parseUnits("10000", 6);   // 10,000 USDC (6 dec)
const INITIAL_TOKEN  = ethers.parseEther("1000000");     // 1,000,000 token (18 dec)
const TRADER_USDC    = ethers.parseUnits("1000", 6);     // 1,000 USDC per trader
const TRADER_TOKEN   = ethers.parseEther("10000");       // 10,000 token per trader
const SWAP_FEE_BPS   = 100n;                             // 1 %
const BPS_DENOM      = 10_000n;
const LP_FEE_BPS     = 400n;                             // 4 %
const PROTO_FEE_BPS  = 100n;                             // 1 %

// Hard caps large enough not to interfere with most tests

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
// Shared fixture — warps 24 h, so the market is aged into the 7-day duration step
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

  const tx = await factory.connect(creator).createMarket(
    await baseToken.getAddress(),
    INITIAL_USDC,
    INITIAL_TOKEN);
  // Position caps ramp 1 %→20 % over 24 h. These tests are not about
  // caps, so start past the ramp where size is not the constraint.
  await time.increase(24 * 3600);
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

async function deployYoungPoolFixture() {
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

  // A *young* market: under an hour old, so positions get the 1-hour lifetime.
  // Deliberately does not warp — both the duration step and the size cap are
  // functions of market age, and this fixture exists to exercise the youngest one.
  const tx = await factory.connect(creator).createMarket(
    await baseToken.getAddress(),
    INITIAL_USDC,
    INITIAL_TOKEN);
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

    it("a market under an hour old issues 1-hour positions", async function () {
      const { pool } = await loadFixture(deployYoungPoolFixture);
      expect(await pool.currentPositionDuration()).to.equal(ONE_HOUR);
    });

    it("a market a day old issues 7-day positions", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.currentPositionDuration()).to.equal(SEVEN_DAYS);
    });

    it("takes no duration parameter and has no setter", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const fns = pool.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => (f as { name: string }).name);
      expect(fns).to.not.include("positionDuration");
      expect(fns).to.include("currentPositionDuration");
    });

  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 2. Deadline Tracking
  // ═════════════════════════════════════════════════════════════════════════════

  describe("2. Deadline Tracking", function () {

    it("Position NFT stores correct deadline (openedAt + current duration)", async function () {
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

    it("market age decides the deadline (young 1h vs aged 7d)", async function () {
      // Only one loadFixture per test: a second call reverts the chain to that
      // fixture's snapshot and takes the first fixture's contracts with it.
      const fix7d = await loadFixture(deployPoolFixture);
      const fix1h = await deployYoungPoolFixture();

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

    it("charges the dynamic fee (base on mark + OI impact slice): check accruals", async function () {
      const { pool, positionNFT, usdc, treasury, creator, trader1, other } =
        await loadFixture(deployPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      const pos = await positionNFT.getPosition(nftId);
      const notional = pos.airUsdMinted; // for longs, notional = airUsdMinted

      // Fresh position: surplus = 0 (slippage + fees), so mark = notional and
      // the base fee matches the old flat 5%. The impact slice is priced at
      // current OI (this position is the only one → offset = 0).
      const IMPACT_FEE_BPS = 1500n;
      const backed = await pool.backedAirUsd();
      const oi     = await pool.longOpenInterest();
      const offset = oi - notional;
      const impactFee   = (IMPACT_FEE_BPS * notional * (2n * offset + notional))
                        / (2n * backed * BPS_DENOM);
      const protocolFee = (notional * PROTO_FEE_BPS) / BPS_DENOM;
      const lpFee       = (notional * LP_FEE_BPS)    / BPS_DENOM + impactFee;
      const totalFee    = protocolFee + lpFee;

      // quoteRenewFee must match the fee the pool actually charges
      expect(await pool.quoteRenewFee(nftId)).to.equal(totalFee);

      const lpAccruedBefore    = await pool.lpFeesAccumulated();
      const protoAccruedBefore = await pool.protocolFeesAccumulated();
      const holderBefore       = await usdc.balanceOf(trader1.address);

      await pool.connect(trader1).renewPosition(nftId, totalFee);

      // Fees accrue (pull payment) — LP and treasury claim later.
      expect(await pool.lpFeesAccumulated()).to.equal(lpAccruedBefore + lpFee);
      expect(await pool.protocolFeesAccumulated()).to.equal(protoAccruedBefore + protocolFee);
      // Holder spent totalFee
      expect(await usdc.balanceOf(trader1.address)).to.equal(holderBefore - totalFee);
    });

    it("reverts RenewalFeeExceedsMax when the fee moves above maxFee", async function () {
      const { pool, trader1 } = await loadFixture(deployPoolFixture);
      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      const quote = await pool.quoteRenewFee(nftId);
      await expect(
        pool.connect(trader1).renewPosition(nftId, quote - 1n)
      ).to.be.revertedWithCustomError(pool, "RenewalFeeExceedsMax");
    });

    it("extends deadline by the current duration from the current deadline", async function () {
      const { pool, positionNFT, usdc, trader1 } = await loadFixture(deployPoolFixture);
      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));

      const posBefore = await positionNFT.getPosition(nftId);
      const oldDeadline = posBefore.deadline;

      // Renew before expiry
      await pool.connect(trader1).renewPosition(nftId, ethers.MaxUint256);

      const posAfter = await positionNFT.getPosition(nftId);
      expect(posAfter.deadline).to.equal(oldDeadline + SEVEN_DAYS);
    });

    it("non-holder cannot renew (griefing protection)", async function () {
      const { pool, positionNFT, usdc, trader1, other } =
        await loadFixture(deployPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));

      // Fund other
      await usdc.mint(other.address, ethers.parseUnits("1000", 6));
      await usdc.connect(other).approve(await pool.getAddress(), ethers.MaxUint256);

      // Reverts — only the position holder may renew
      await expect(
        pool.connect(other).renewPosition(nftId, ethers.MaxUint256)
      ).to.be.revertedWithCustomError(pool, "OnlyPositionHolder");
    });

    it("works for both long and short positions", async function () {
      const { pool, positionNFT, usdc, trader1 } = await loadFixture(deployPoolFixture);

      const longId  = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      const shortId = await openShort(pool, trader1, ethers.parseUnits("100", 6));

      const longBefore  = await positionNFT.getPosition(longId);
      const shortBefore = await positionNFT.getPosition(shortId);

      await pool.connect(trader1).renewPosition(longId, ethers.MaxUint256);
      await pool.connect(trader1).renewPosition(shortId, ethers.MaxUint256);

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

      await pool.connect(trader1).renewPosition(nftId, ethers.MaxUint256);

      const posAfter = await positionNFT.getPosition(nftId);
      const latest   = BigInt(await time.latest());

      // Extends from now, since the position was expired. The step comes from
      // market age — by this point the market is past a week old, so it is the
      // 30-day step rather than the 7-day one the position opened under.
      const dur = await pool.currentPositionDuration();
      expect(posAfter.deadline).to.be.gte(latest + dur - 10n);
      expect(posAfter.deadline).to.be.lte(latest + dur + 10n);
    });

    it("renewPosition succeeds and charges the correct fee", async function () {
      const { pool, positionNFT, usdc, trader1 } = await loadFixture(deployPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      const pos   = await positionNFT.getPosition(nftId);

      // quoteRenewFee is the single source of truth for the dynamic fee.
      const totalFee = await pool.quoteRenewFee(nftId);

      const expectedNewDeadline = pos.deadline + SEVEN_DAYS;

      const usdcBefore = await usdc.balanceOf(trader1.address);
      await pool.connect(trader1).renewPosition(nftId, totalFee);
      const usdcAfter = await usdc.balanceOf(trader1.address);
      expect(usdcBefore - usdcAfter).to.equal(totalFee);

      const posAfter = await positionNFT.getPosition(nftId);
      expect(posAfter.deadline).to.equal(expectedNewDeadline);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 3b. renewPosition — the RENEW_HORIZON bound (audit finding H-3)
  //
  // renewPosition extends from the EXISTING deadline, so renewals stack. The
  // only bound used to be closeDate, which is zero until the LP closes the
  // pool — and removeLiquidity reverts while openPositionCount != 0. A dust
  // position renewed at the MIN_POSITION_FEE floor could therefore walk its
  // deadline out for decades and freeze 100 % of LP principal, at a cost
  // independent of pool size. Measured in the audit: $60.85 for 100 years.
  //
  // RENEW_HORIZON = 2 x DURATION_MAX = 60 days caps how far past NOW a renewal
  // may land. Short-dated positions still renew many times over; one already on
  // the 30-day ceiling gets exactly one renewal and must then be allowed to run
  // down. The tests below pin both ends of that, and the boundary itself.
  // ═════════════════════════════════════════════════════════════════════════════

  describe("3b. renewPosition — RENEW_HORIZON (H-3)", function () {
    const THIRTY_DAYS   = 30n * 24n * 60n * 60n;
    const RENEW_HORIZON = 2n * THIRTY_DAYS;

    /** Age the market past DURATION_AGE_4, so an open gets the 30-day ceiling. */
    async function agedToCeiling() {
      const fix = await loadFixture(deployPoolFixture);
      await time.increase(8 * 24 * 3600);
      expect(await fix.pool.currentPositionDuration()).to.equal(THIRTY_DAYS);
      return fix;
    }

    it("a 7-day position renews many times over, until the horizon stops it", async function () {
      const { pool, positionNFT, trader1 } = await loadFixture(deployPoolFixture);
      expect(await pool.currentPositionDuration()).to.equal(SEVEN_DAYS);

      const nftId  = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      const opened = (await positionNFT.getPosition(nftId)).deadline;

      // Back-to-back, so the market never ages out of the 7-day step and each
      // renewal adds exactly 7 days. 8 x 7 = 56 fits under the 60-day horizon.
      for (let i = 1n; i <= 7n; i++) {
        await pool.connect(trader1).renewPosition(nftId, ethers.MaxUint256);
        expect((await positionNFT.getPosition(nftId)).deadline)
          .to.equal(opened + i * SEVEN_DAYS);
      }

      // The eighth would be 63 days out with 60 available.
      await expect(pool.connect(trader1).renewPosition(nftId, ethers.MaxUint256))
        .to.be.revertedWithCustomError(pool, "RenewalExceedsHorizon");
    });

    it("a position on the 30-day ceiling renews exactly once", async function () {
      const { pool, positionNFT, trader1 } = await agedToCeiling();

      const nftId  = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      const opened = (await positionNFT.getPosition(nftId)).deadline;

      // The one renewal a holder always has in hand: 30 + 30 lands on the
      // horizon, so nobody has to race their own deadline to use it.
      await pool.connect(trader1).renewPosition(nftId, ethers.MaxUint256);
      expect((await positionNFT.getPosition(nftId)).deadline).to.equal(opened + THIRTY_DAYS);

      await expect(pool.connect(trader1).renewPosition(nftId, ethers.MaxUint256))
        .to.be.revertedWithCustomError(pool, "RenewalExceedsHorizon");
    });

    it("the bound is exact: rejected a second early, accepted on the horizon", async function () {
      const { pool, positionNFT, trader1 } = await agedToCeiling();

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      await pool.connect(trader1).renewPosition(nftId, ethers.MaxUint256);

      // Renewing writes deadline + 30d, which must be <= now + 60d. The first
      // moment that holds is exactly deadline - 30d — i.e. the position has to
      // run down to a 30-day remaining life before it can be extended again.
      const deadline = (await positionNFT.getPosition(nftId)).deadline;
      const earliest = deadline - THIRTY_DAYS;

      await time.setNextBlockTimestamp(Number(earliest) - 1);
      await expect(pool.connect(trader1).renewPosition(nftId, ethers.MaxUint256))
        .to.be.revertedWithCustomError(pool, "RenewalExceedsHorizon");

      await time.setNextBlockTimestamp(Number(earliest));
      await pool.connect(trader1).renewPosition(nftId, ethers.MaxUint256);

      const renewed = (await positionNFT.getPosition(nftId)).deadline;
      expect(renewed).to.equal(deadline + THIRTY_DAYS);
      // Exactly the horizon, not a second more.
      expect(renewed).to.equal(BigInt(await time.latest()) + RENEW_HORIZON);
    });

    it("quoteRenewDeadline reports what renewPosition writes, and when it would revert", async function () {
      const { pool, positionNFT, trader1 } = await agedToCeiling();

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));

      const [quoted, allowed] = await pool.quoteRenewDeadline(nftId);
      expect(allowed).to.equal(true);
      await pool.connect(trader1).renewPosition(nftId, ethers.MaxUint256);
      expect((await positionNFT.getPosition(nftId)).deadline).to.equal(quoted);

      // Past the horizon the quote still reports the deadline that WOULD be
      // written, so a frontend can show how far the position must run down
      // rather than only that the button is disabled.
      const [nextQuoted, nextAllowed] = await pool.quoteRenewDeadline(nftId);
      expect(nextAllowed).to.equal(false);
      expect(nextQuoted).to.equal(quoted + THIRTY_DAYS);
      await expect(pool.connect(trader1).renewPosition(nftId, ethers.MaxUint256))
        .to.be.revertedWithCustomError(pool, "RenewalExceedsHorizon");
    });

    it("H-3: no sequence of renewals puts a deadline further out than the horizon", async function () {
      const { pool, positionNFT, trader1 } = await loadFixture(deployPoolFixture);

      // The shape of the original finding: the cheapest position the pool will
      // issue, renewed at the MIN_POSITION_FEE floor for as long as it is let.
      const nftId = await openLong(pool, trader1, ethers.parseUnits("1", 6));

      let renewals = 0;
      while (renewals <= 100) {
        const [, allowed] = await pool.quoteRenewDeadline(nftId);
        if (!allowed) break;
        await pool.connect(trader1).renewPosition(nftId, ethers.MaxUint256);
        renewals++;
      }

      // Bounded at all, and bounded by the horizon rather than by anything
      // incidental like the holder running out of USDC.
      expect(renewals, "renewals are bounded").to.be.lte(100);
      expect(renewals, "renewal still works").to.be.gt(0);
      await expect(pool.connect(trader1).renewPosition(nftId, ethers.MaxUint256))
        .to.be.revertedWithCustomError(pool, "RenewalExceedsHorizon");

      // The property the LP actually needs: however the holder spends, the
      // pool's last outstanding deadline is at most RENEW_HORIZON away.
      const deadline = (await positionNFT.getPosition(nftId)).deadline;
      expect(deadline - BigInt(await time.latest())).to.be.lte(RENEW_HORIZON);
    });

    it("closeDate still binds renewals made after the pool starts closing", async function () {
      const { pool, positionNFT, lpNft, creator, trader1 } = await loadFixture(deployPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));

      // closePool sets closeDate = now + currentPositionDuration() = now + 7d,
      // while the position already expires at open + 7d. Extending it by
      // another 7 lands past closeDate and must be refused — inside the
      // horizon, so this is the closeDate branch and not the new one.
      expect(await lpNft.ownerOf(await pool.lpNftId())).to.equal(creator.address);
      await pool.connect(creator).closePool();

      const [quoted, allowed] = await pool.quoteRenewDeadline(nftId);
      expect(quoted).to.be.gt(await pool.closeDate());
      expect(quoted - BigInt(await time.latest())).to.be.lt(RENEW_HORIZON);
      expect(allowed).to.equal(false);

      await expect(pool.connect(trader1).renewPosition(nftId, ethers.MaxUint256))
        .to.be.revertedWithCustomError(pool, "RenewalExceedsCloseDate");
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
      await mine(SETTLE_GUARD_BLOCKS);

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
      await mine(SETTLE_GUARD_BLOCKS);

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

    it("after deadline, anyone can close a profitable long (payout credited, holder claims)", async function () {
      const { pool, usdc, trader1, other, nftId } =
        await loadFixture(withProfitableExpiredLong);

      // Other (not the holder) closes the expired position — payout is
      // CREDITED (pull payment), not pushed.
      await expect(pool.connect(other).closePositionAfterDeadline(nftId, 0n))
        .to.emit(pool, "PayoutCredited");

      const credited = await pool.claimable(trader1.address);
      expect(credited).to.be.gt(0n);

      // Holder withdraws the credited payout.
      const holderUsdcBefore = await usdc.balanceOf(trader1.address);
      await expect(pool.connect(trader1).claimPayout(trader1.address))
        .to.emit(pool, "PayoutClaimed")
        .withArgs(trader1.address, trader1.address, credited);
      expect(await usdc.balanceOf(trader1.address)).to.equal(holderUsdcBefore + credited);
      expect(await pool.claimable(trader1.address)).to.equal(0n);
      expect(await pool.totalClaimable()).to.equal(0n);
    });

    it("after deadline, anyone can close a profitable short (payout credited)", async function () {
      const { pool, usdc, trader1, other, nftId } =
        await loadFixture(withProfitableExpiredShort);

      await pool.connect(other).closePositionAfterDeadline(nftId, 0n);

      const credited = await pool.claimable(trader1.address);
      expect(credited).to.be.gt(0n);

      const holderUsdcBefore = await usdc.balanceOf(trader1.address);
      await pool.connect(trader1).claimPayout(trader1.address);
      expect(await usdc.balanceOf(trader1.address)).to.equal(holderUsdcBefore + credited);
    });

    it("claimPayout reverts with ZeroAmount when nothing is credited", async function () {
      const { pool, other } = await loadFixture(withProfitableExpiredLong);
      await expect(
        pool.connect(other).claimPayout(other.address)
      ).to.be.revertedWithCustomError(pool, "ZeroAmount");
    });

    it("claimPayout can redirect to a different recipient", async function () {
      const { pool, usdc, trader1, other, nftId } =
        await loadFixture(withProfitableExpiredLong);

      await pool.connect(other).closePositionAfterDeadline(nftId, 0n);
      const credited = await pool.claimable(trader1.address);

      const otherBefore = await usdc.balanceOf(other.address);
      await pool.connect(trader1).claimPayout(other.address);
      expect(await usdc.balanceOf(other.address)).to.equal(otherBefore + credited);
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
      await mine(SETTLE_GUARD_BLOCKS);

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
      await mine(SETTLE_GUARD_BLOCKS);

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
      await mine(SETTLE_GUARD_BLOCKS);

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
      await mine(SETTLE_GUARD_BLOCKS);

      const holderBefore = await usdc.balanceOf(trader1.address);

      // Close before deadline
      await pool.connect(trader1).closeShort(nftId, 0n);

      expect(await usdc.balanceOf(trader1.address)).to.be.gt(holderBefore);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Audit NM-R2-005 — the guard must not outlive the pool.
//
// Arming is relative to depth, so in a thin market an ordinary trade clears
// SETTLE_GUARD_BPS and the guard is armed essentially always. Combined with
// removeLiquidity's openPositionCount == 0 requirement, one abandoned expired
// position would then lock the LP's principal permanently: the holder can
// always close, but nobody can make them, and no third party was allowed to
// clean up on their behalf.
//
// _priceCloseClamped still prices these settlements against the worst open in
// the same window, so the exemption gives up the blunt lockout and keeps the
// protection that actually sets the price.
// ═════════════════════════════════════════════════════════════════════════════

describe("Expiry — the settlement guard yields to a closing pool", function () {
  /** An expired long, with the guard freshly armed and NOT mined past. */
  async function expiredLongUnderArmedGuard() {
    const base = await deployPoolFixture();
    const nftId = await openLong(base.pool, base.trader1, ethers.parseUnits("100", 6));

    await time.increase(Number(SEVEN_DAYS) + 1);

    // Arm it: 2,000 USDC into a 10,000 USDC pool is far past the 1 % threshold.
    const pump = ethers.parseUnits("2000", 6);
    await base.usdc.mint(base.trader2.address, pump);
    await base.pool.connect(base.trader2).swap(pump, 0n, false, base.trader2.address);

    expect(await base.pool.lastLargeSwapBlock()).to.be.gt(0n);
    return { ...base, nftId };
  }

  it("blocks a third party while the pool is live", async function () {
    const { pool, other, nftId } = await loadFixture(expiredLongUnderArmedGuard);

    expect(await pool.settlementGuardedUntilBlock()).to.be.gt(0n);
    await expect(pool.connect(other).closePositionAfterDeadline(nftId, 0n))
      .to.be.revertedWithCustomError(pool, "SettlementGuardActive");
  });

  it("lets a third party clean up once closePool has been called", async function () {
    const { pool, creator, other, nftId } = await loadFixture(expiredLongUnderArmedGuard);

    await pool.connect(creator).closePool();

    // The guard is still armed — this is the exemption, not the window expiring.
    expect(await pool.lastLargeSwapBlock()).to.be.gt(0n);
    expect(await pool.settlementGuardedUntilBlock()).to.equal(0n);

    await expect(pool.connect(other).closePositionAfterDeadline(nftId, 0n)).to.not.be.reverted;
    expect(await pool.openPositionCount()).to.equal(0n);
  });

  it("frees the LP's principal, which is the point", async function () {
    const { pool, creator, other, nftId } = await loadFixture(expiredLongUnderArmedGuard);

    await pool.connect(creator).closePool();
    await pool.connect(other).closePositionAfterDeadline(nftId, 0n);

    // closeDate has to pass before the LP can withdraw; the guard must not be
    // what stands in the way once it has.
    await time.increase(Number(SEVEN_DAYS) + 1);
    await expect(pool.connect(creator).removeLiquidity()).to.not.be.reverted;
  });

  it("the holder was never blocked either way", async function () {
    const { pool, trader1, nftId } = await loadFixture(expiredLongUnderArmedGuard);

    // Unchanged behaviour, asserted next to the exemption so the two rules stay
    // legible together: an armed guard never traps the holder.
    await expect(pool.connect(trader1).closePositionAfterDeadline(nftId, 0n)).to.not.be.reverted;
  });
});
