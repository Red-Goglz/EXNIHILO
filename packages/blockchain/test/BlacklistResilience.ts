import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type {
  EXNIHILOPool,
  EXNIHILOFactory,
  LpNFT,
  PositionNFT,
  MockERC20,
  BlacklistableERC20,
} from "../typechain-types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const INITIAL_USDC  = ethers.parseUnits("10000", 6);
const INITIAL_TOKEN = ethers.parseEther("1000000");
const TRADER_USDC   = ethers.parseUnits("5000", 6);
const SWAP_FEE_BPS  = 100n;
const MAX_POS_USD   = ethers.parseUnits("9000", 6);
const MAX_POS_BPS   = 9000n;
const SEVEN_DAYS    = 7n * 24n * 60n * 60n;

// ─────────────────────────────────────────────────────────────────────────────
// Bytecode-patch helper  (identical to Expiry.ts)
// ─────────────────────────────────────────────────────────────────────────────

async function patchImmutableAddress(
  contractAddress: string,
  fromAddress: string,
  toAddress: string,
): Promise<void> {
  const bytecode = await ethers.provider.getCode(contractAddress);
  const raw = bytecode.slice(2).toLowerCase();
  const fromPadded = "000000000000000000000000" + fromAddress.toLowerCase().slice(2);
  const toPadded   = "000000000000000000000000" + toAddress.toLowerCase().slice(2);
  if (!raw.includes(fromPadded)) {
    throw new Error(`patchImmutableAddress: ${fromAddress} not found in bytecode of ${contractAddress}`);
  }
  const patched = raw.split(fromPadded).join(toPadded);
  await ethers.provider.send("hardhat_setCode", [contractAddress, "0x" + patched]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture: pool backed by BlacklistableERC20 as USDC
// ─────────────────────────────────────────────────────────────────────────────

async function deployBlacklistPoolFixture() {
  const signers = await ethers.getSigners();
  const [deployer, treasury, creator, trader1, trader2, other] = signers;
  const throwaway   = signers[7];
  const sysDeployer = signers[8];

  // Blacklistable USDC mock
  const BlacklistF = await ethers.getContractFactory("BlacklistableERC20");
  const usdc = await BlacklistF.connect(deployer).deploy("USD Coin", "USDC", 6) as BlacklistableERC20;

  // Standard token for the underlying
  const MockF = await ethers.getContractFactory("MockERC20");
  const baseToken = await MockF.connect(deployer).deploy("PEPE", "PEPE", 18) as MockERC20;

  // PositionNFT
  const positionNFT = await (
    await ethers.getContractFactory("PositionNFT")
  ).connect(deployer).deploy() as PositionNFT;

  // LpNFT (throwaway → patched)
  const lpNft = await (
    await ethers.getContractFactory("LpNFT")
  ).connect(throwaway).deploy(throwaway.address) as unknown as LpNFT;

  // PoolDeployer
  const poolDeployer = await (await ethers.getContractFactory("PoolDeployer")).connect(sysDeployer).deploy();

  // Factory
  const factory = await (
    await ethers.getContractFactory("EXNIHILOFactory")
  ).connect(sysDeployer).deploy(
    await positionNFT.getAddress(),
    await lpNft.getAddress(),
    await usdc.getAddress(),
    treasury.address,
    SWAP_FEE_BPS,
    await poolDeployer.getAddress(),
  ) as unknown as EXNIHILOFactory;

  const factoryAddr = await factory.getAddress();
  await patchImmutableAddress(await lpNft.getAddress(), throwaway.address, factoryAddr);
  await positionNFT.connect(deployer).initFactory(factoryAddr);

  // Fund creator and create market
  await baseToken.mint(creator.address, INITIAL_TOKEN);
  await usdc.mint(creator.address, INITIAL_USDC);
  await baseToken.connect(creator).approve(factoryAddr, ethers.MaxUint256);
  await usdc.connect(creator).approve(factoryAddr, ethers.MaxUint256);

  const tx = await factory.connect(creator).createMarket(
    await baseToken.getAddress(),
    INITIAL_USDC,
    INITIAL_TOKEN,
    MAX_POS_USD,
    MAX_POS_BPS,
    0n, // 7-day default
    "airPEPE",
    "airPEPEUsd",
    18,
  );
  const receipt = await tx.wait();

  const iface = factory.interface;
  const log = receipt!.logs
    .map((l) => { try { return iface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "MarketCreated")!;

  const poolAddress: string = log.args.pool;
  const lpNftId: bigint     = log.args.lpNftId;
  const pool = await ethers.getContractAt("EXNIHILOPool", poolAddress) as EXNIHILOPool;

  // Fund traders
  for (const trader of [trader1, trader2, other]) {
    await usdc.mint(trader.address, TRADER_USDC);
    await baseToken.mint(trader.address, ethers.parseEther("100000"));
    await usdc.connect(trader).approve(poolAddress, ethers.MaxUint256);
    await baseToken.connect(trader).approve(poolAddress, ethers.MaxUint256);
  }

  return {
    pool, factory, positionNFT, lpNft, baseToken, usdc,
    deployer, treasury, creator, trader1, trader2, other,
    poolAddress, lpNftId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function openLong(pool: EXNIHILOPool, trader: HardhatEthersSigner, amount: bigint): Promise<bigint> {
  const tx = await pool.connect(trader).openLong(amount, 0n, trader.address);
  const receipt = await tx.wait();
  const log = receipt!.logs
    .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "PositionOpened")!;
  return log.args.nftId as bigint;
}

async function openShort(pool: EXNIHILOPool, trader: HardhatEthersSigner, amount: bigint): Promise<bigint> {
  const tx = await pool.connect(trader).openShort(amount, 0n, trader.address);
  const receipt = await tx.wait();
  const log = receipt!.logs
    .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "PositionOpened")!;
  return log.args.nftId as bigint;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Blacklist Resilience (DoS-2 fix)", function () {

  // ═════════════════════════════════════════════════════════════════════════════
  // 1. Baseline: expired position close works normally without blacklist
  // ═════════════════════════════════════════════════════════════════════════════

  describe("Baseline: normal expired close still works", function () {

    it("profitable expired long pays holder normally", async function () {
      const { pool, usdc, trader1, trader2, other } = await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));

      // Pump price
      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);

      await time.increase(Number(SEVEN_DAYS) + 1);

      const holderBefore = await usdc.balanceOf(trader1.address);
      await pool.connect(other).closePositionAfterDeadline(nftId, 0n);
      const holderAfter = await usdc.balanceOf(trader1.address);

      expect(holderAfter).to.be.gt(holderBefore);
      expect(await pool.openPositionCount()).to.equal(0n);
    });

    it("profitable expired short pays holder normally", async function () {
      const { pool, usdc, baseToken, trader1, trader2, other } = await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openShort(pool, trader1, ethers.parseUnits("100", 6));

      // Dump price
      await baseToken.mint(trader2.address, ethers.parseEther("500000"));
      await pool.connect(trader2).swap(ethers.parseEther("500000"), 0n, true, trader2.address);

      await time.increase(Number(SEVEN_DAYS) + 1);

      const holderBefore = await usdc.balanceOf(trader1.address);
      await pool.connect(other).closePositionAfterDeadline(nftId, 0n);
      const holderAfter = await usdc.balanceOf(trader1.address);

      expect(holderAfter).to.be.gt(holderBefore);
      expect(await pool.openPositionCount()).to.equal(0n);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 2. Blacklisted holder: position cleanup still succeeds
  // ═════════════════════════════════════════════════════════════════════════════

  describe("Blacklisted holder: cleanup succeeds with PayoutFailed", function () {

    it("profitable expired long: position cleaned up, emits PayoutFailed for holder", async function () {
      const { pool, usdc, trader1, trader2, other } = await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));

      // Pump price to make it profitable
      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);

      // Blacklist the holder
      await usdc.blacklist(trader1.address);

      await time.increase(Number(SEVEN_DAYS) + 1);

      // Should NOT revert — the try/catch catches the blacklist failure
      const tx = await pool.connect(other).closePositionAfterDeadline(nftId, 0n);

      // PayoutFailed emitted for the holder
      await expect(tx).to.emit(pool, "PayoutFailed").withArgs(
        trader1.address,
        (v: bigint) => v > 0n,
      );

      // Position cleaned up
      expect(await pool.openPositionCount()).to.equal(0n);

      // Holder did NOT receive USDC (blacklisted)
      // The USDC stays in the pool
    });

    it("profitable expired short: position cleaned up, emits PayoutFailed for holder", async function () {
      const { pool, usdc, baseToken, trader1, trader2, other } = await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openShort(pool, trader1, ethers.parseUnits("100", 6));

      // Dump price to make short profitable
      await baseToken.mint(trader2.address, ethers.parseEther("500000"));
      await pool.connect(trader2).swap(ethers.parseEther("500000"), 0n, true, trader2.address);

      // Blacklist the holder
      await usdc.blacklist(trader1.address);

      await time.increase(Number(SEVEN_DAYS) + 1);

      const tx = await pool.connect(other).closePositionAfterDeadline(nftId, 0n);

      await expect(tx).to.emit(pool, "PayoutFailed").withArgs(
        trader1.address,
        (v: bigint) => v > 0n,
      );

      expect(await pool.openPositionCount()).to.equal(0n);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 3. LP can removeLiquidity after blacklisted holder's position is cleaned up
  // ═════════════════════════════════════════════════════════════════════════════

  describe("LP exit unblocked after blacklisted position cleanup", function () {

    it("LP can removeLiquidity after cleaning up blacklisted holder's expired long", async function () {
      const { pool, usdc, baseToken, trader1, trader2, other, creator, lpNftId } =
        await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));

      // Pump to make profitable
      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);

      // Blacklist holder
      await usdc.blacklist(trader1.address);

      await time.increase(Number(SEVEN_DAYS) + 1);

      // Clean up the position (succeeds despite blacklist)
      await pool.connect(other).closePositionAfterDeadline(nftId, 0n);
      expect(await pool.openPositionCount()).to.equal(0n);

      // LP can now remove liquidity
      const lpUsdcBefore = await usdc.balanceOf(creator.address);
      const lpTokenBefore = await baseToken.balanceOf(creator.address);

      await pool.connect(creator).removeLiquidity();

      expect(await usdc.balanceOf(creator.address)).to.be.gt(lpUsdcBefore);
      expect(await baseToken.balanceOf(creator.address)).to.be.gt(lpTokenBefore);
    });

    it("LP can removeLiquidity after cleaning up blacklisted holder's expired short", async function () {
      const { pool, usdc, baseToken, trader1, trader2, other, creator } =
        await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openShort(pool, trader1, ethers.parseUnits("100", 6));

      // Dump to make short profitable
      await baseToken.mint(trader2.address, ethers.parseEther("500000"));
      await pool.connect(trader2).swap(ethers.parseEther("500000"), 0n, true, trader2.address);

      await usdc.blacklist(trader1.address);
      await time.increase(Number(SEVEN_DAYS) + 1);

      await pool.connect(other).closePositionAfterDeadline(nftId, 0n);
      expect(await pool.openPositionCount()).to.equal(0n);

      await pool.connect(creator).removeLiquidity();

      // LP successfully withdrew — no revert
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 4. Blacklisted treasury: position cleanup still succeeds
  // ═════════════════════════════════════════════════════════════════════════════

  describe("Blacklisted treasury: cleanup succeeds", function () {

    it("profitable expired long: emits PayoutFailed for treasury, holder still paid", async function () {
      const { pool, usdc, treasury, trader1, trader2, other } =
        await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));

      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);

      // Blacklist the treasury
      await usdc.blacklist(treasury.address);

      await time.increase(Number(SEVEN_DAYS) + 1);

      const holderBefore = await usdc.balanceOf(trader1.address);
      const tx = await pool.connect(other).closePositionAfterDeadline(nftId, 0n);

      // Treasury payout failed
      await expect(tx).to.emit(pool, "PayoutFailed").withArgs(
        treasury.address,
        (v: bigint) => v > 0n,
      );

      // Holder STILL received their payout (they are not blacklisted)
      expect(await usdc.balanceOf(trader1.address)).to.be.gt(holderBefore);

      expect(await pool.openPositionCount()).to.equal(0n);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 5. Both holder and treasury blacklisted: still cleans up
  // ═════════════════════════════════════════════════════════════════════════════

  describe("Both holder and treasury blacklisted", function () {

    it("position still cleans up, two PayoutFailed events emitted", async function () {
      const { pool, usdc, treasury, trader1, trader2, other } =
        await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));

      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);

      // Blacklist both
      await usdc.blacklist(trader1.address);
      await usdc.blacklist(treasury.address);

      await time.increase(Number(SEVEN_DAYS) + 1);

      const tx = await pool.connect(other).closePositionAfterDeadline(nftId, 0n);

      // Two PayoutFailed events
      const receipt = await tx.wait();
      const payoutFailedEvents = receipt!.logs
        .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
        .filter((l) => l?.name === "PayoutFailed");

      expect(payoutFailedEvents.length).to.equal(2);

      // Position cleaned up
      expect(await pool.openPositionCount()).to.equal(0n);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 5b. Failed payouts are socialized into lpFeesAccumulated and recoverable
  //     via claimFees (fix for the _trySendUsdc strand bug).
  // ═════════════════════════════════════════════════════════════════════════════

  describe("Failed payouts socialize to LP fees", function () {

    it("blacklisted holder: failed netSurplus is added to lpFeesAccumulated", async function () {
      const { pool, usdc, trader1, trader2, other } = await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);
      await usdc.blacklist(trader1.address);
      await time.increase(Number(SEVEN_DAYS) + 1);

      const feesBefore = await pool.lpFeesAccumulated();

      const tx = await pool.connect(other).closePositionAfterDeadline(nftId, 0n);
      const receipt = await tx.wait();

      // Extract the PayoutFailed amount for the holder
      const failedEvent = receipt!.logs
        .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
        .find((l) => l?.name === "PayoutFailed" && l.args.recipient === trader1.address)!;
      const failedAmount = failedEvent.args.amount as bigint;

      expect(failedAmount).to.be.gt(0n);

      const feesAfter = await pool.lpFeesAccumulated();
      expect(feesAfter - feesBefore).to.equal(failedAmount);
    });

    it("both holder and treasury blacklisted: both amounts socialized", async function () {
      const { pool, usdc, treasury, trader1, trader2, other } =
        await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);
      await usdc.blacklist(trader1.address);
      await usdc.blacklist(treasury.address);
      await time.increase(Number(SEVEN_DAYS) + 1);

      const feesBefore = await pool.lpFeesAccumulated();
      const tx = await pool.connect(other).closePositionAfterDeadline(nftId, 0n);
      const receipt = await tx.wait();

      const failedEvents = receipt!.logs
        .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
        .filter((l) => l?.name === "PayoutFailed");
      const totalFailed = failedEvents.reduce(
        (sum, ev) => sum + (ev!.args.amount as bigint),
        0n,
      );

      expect(failedEvents.length).to.equal(2);
      expect(await pool.lpFeesAccumulated() - feesBefore).to.equal(totalFailed);
    });

    it("LP can claim socialized amount via claimFees", async function () {
      const { pool, usdc, trader1, trader2, other, creator } =
        await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);
      await usdc.blacklist(trader1.address);
      await time.increase(Number(SEVEN_DAYS) + 1);

      await pool.connect(other).closePositionAfterDeadline(nftId, 0n);

      const claimable = await pool.lpFeesAccumulated();
      expect(claimable).to.be.gt(0n);

      const lpBefore = await usdc.balanceOf(creator.address);
      await pool.connect(creator).claimFees();
      const lpAfter  = await usdc.balanceOf(creator.address);

      expect(lpAfter - lpBefore).to.equal(claimable);
      expect(await pool.lpFeesAccumulated()).to.equal(0n);
    });

    it("successful payout does NOT socialize (only failures do)", async function () {
      const { pool, usdc, trader1, trader2, other } = await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);
      // NOT blacklisted
      await time.increase(Number(SEVEN_DAYS) + 1);

      const feesBefore = await pool.lpFeesAccumulated();
      await pool.connect(other).closePositionAfterDeadline(nftId, 0n);
      const feesAfter  = await pool.lpFeesAccumulated();

      // Only the open-time LP fee portion moves; no socialization delta.
      // The close-time payout went to holder + treasury successfully.
      expect(feesAfter).to.equal(feesBefore);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 6. Underwater expired positions are unaffected (no transfer to holder)
  // ═════════════════════════════════════════════════════════════════════════════

  describe("Underwater positions: unaffected by blacklist", function () {

    it("underwater expired long with blacklisted holder: same as before (no payout path)", async function () {
      const { pool, usdc, baseToken, trader1, trader2, other } =
        await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("500", 6));

      // Crash price
      await baseToken.mint(trader2.address, ethers.parseEther("5000000"));
      await pool.connect(trader2).swap(ethers.parseEther("5000000"), 0n, true, trader2.address);

      await usdc.blacklist(trader1.address);
      await time.increase(Number(SEVEN_DAYS) + 1);

      // No PayoutFailed — underwater path doesn't transfer to holder at all
      const tx = await pool.connect(other).closePositionAfterDeadline(nftId, 0n);
      const receipt = await tx.wait();
      const payoutFailedEvents = receipt!.logs
        .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
        .filter((l) => l?.name === "PayoutFailed");

      expect(payoutFailedEvents.length).to.equal(0);
      expect(await pool.openPositionCount()).to.equal(0n);
    });
  });
});
