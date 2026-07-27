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
    0n); // 7-day default
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
//
// Pull-payment model: the pool never pushes USDC to third parties.
//   - Fees accrue and are claimed (claimFees / claimProtocolFees).
//   - Expired-position payouts are credited to `claimable` and withdrawn via
//     claimPayout(to).
// A blacklisted recipient therefore can never block any pool operation —
// blacklist DoS is structurally impossible, not merely handled.
// ─────────────────────────────────────────────────────────────────────────────

describe("Blacklist Resilience (pull payments)", function () {

  // ═════════════════════════════════════════════════════════════════════════════
  // 1. Baseline: expired close credits payout, holder claims
  // ═════════════════════════════════════════════════════════════════════════════

  describe("Baseline: expired close credits claimable payout", function () {

    it("profitable expired long: payout credited, holder claims it", async function () {
      const { pool, usdc, trader1, trader2, other } = await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));

      // Pump price
      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);

      await time.increase(Number(SEVEN_DAYS) + 1);

      await pool.connect(other).closePositionAfterDeadline(nftId, 0n);
      expect(await pool.openPositionCount()).to.equal(0n);

      const credited = await pool.claimable(trader1.address);
      expect(credited).to.be.gt(0n);

      const holderBefore = await usdc.balanceOf(trader1.address);
      await pool.connect(trader1).claimPayout(trader1.address);
      expect(await usdc.balanceOf(trader1.address)).to.equal(holderBefore + credited);
    });

    it("profitable expired short: payout credited, holder claims it", async function () {
      const { pool, usdc, baseToken, trader1, trader2, other } = await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openShort(pool, trader1, ethers.parseUnits("100", 6));

      // Dump price
      await baseToken.mint(trader2.address, ethers.parseEther("500000"));
      await pool.connect(trader2).swap(ethers.parseEther("500000"), 0n, true, trader2.address);

      await time.increase(Number(SEVEN_DAYS) + 1);

      await pool.connect(other).closePositionAfterDeadline(nftId, 0n);
      expect(await pool.openPositionCount()).to.equal(0n);

      const credited = await pool.claimable(trader1.address);
      expect(credited).to.be.gt(0n);

      const holderBefore = await usdc.balanceOf(trader1.address);
      await pool.connect(trader1).claimPayout(trader1.address);
      expect(await usdc.balanceOf(trader1.address)).to.equal(holderBefore + credited);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 2. Blacklisted holder: cleanup succeeds, payout stays claimable
  // ═════════════════════════════════════════════════════════════════════════════

  describe("Blacklisted holder: cleanup succeeds, payout redirectable", function () {

    it("profitable expired long: cleanup succeeds, payout credited despite blacklist", async function () {
      const { pool, usdc, trader1, trader2, other } = await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));

      // Pump price to make it profitable
      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);

      // Blacklist the holder
      await usdc.blacklist(trader1.address);

      await time.increase(Number(SEVEN_DAYS) + 1);

      // Crediting is a pure state write — the blacklist cannot interfere.
      await expect(pool.connect(other).closePositionAfterDeadline(nftId, 0n))
        .to.emit(pool, "PayoutCredited");

      expect(await pool.openPositionCount()).to.equal(0n);
      expect(await pool.claimable(trader1.address)).to.be.gt(0n);
    });

    it("blacklisted holder redirects the claim to a clean address", async function () {
      const { pool, usdc, trader1, trader2, other } = await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);
      await usdc.blacklist(trader1.address);
      await time.increase(Number(SEVEN_DAYS) + 1);

      await pool.connect(other).closePositionAfterDeadline(nftId, 0n);
      const credited = await pool.claimable(trader1.address);

      // Claiming to self reverts (blacklisted recipient)...
      await expect(pool.connect(trader1).claimPayout(trader1.address)).to.be.reverted;

      // ...but redirecting to a clean address works.
      const otherBefore = await usdc.balanceOf(other.address);
      await pool.connect(trader1).claimPayout(other.address);
      expect(await usdc.balanceOf(other.address)).to.equal(otherBefore + credited);
      expect(await pool.claimable(trader1.address)).to.equal(0n);
    });

    it("blacklisted holder: voluntary close reverts (push to self), expiry path still works", async function () {
      const { pool, usdc, trader1, trader2, other } = await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);
      await usdc.blacklist(trader1.address);

      // Voluntary close pays the holder directly — blocked by the blacklist.
      await expect(pool.connect(trader1).closeLong(nftId, 0n)).to.be.reverted;

      // The expiry path credits instead of pushing — always succeeds.
      await time.increase(Number(SEVEN_DAYS) + 1);
      await pool.connect(other).closePositionAfterDeadline(nftId, 0n);
      expect(await pool.claimable(trader1.address)).to.be.gt(0n);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 3. LP can removeLiquidity after blacklisted holder's position is cleaned up
  // ═════════════════════════════════════════════════════════════════════════════

  describe("LP exit unblocked after blacklisted position cleanup", function () {

    it("LP can removeLiquidity after cleaning up blacklisted holder's expired long", async function () {
      const { pool, usdc, baseToken, trader1, trader2, other, creator } =
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

    it("removeLiquidity leaves the credited payout claimable (solvency held back)", async function () {
      const { pool, usdc, trader1, trader2, other, creator } =
        await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);
      await usdc.blacklist(trader1.address);
      await time.increase(Number(SEVEN_DAYS) + 1);

      await pool.connect(other).closePositionAfterDeadline(nftId, 0n);
      const credited = await pool.claimable(trader1.address);

      await pool.connect(creator).removeLiquidity();

      // The credited payout is still fully backed by pool USDC after LP exit.
      expect(await usdc.balanceOf(await pool.getAddress())).to.be.gte(credited);
      const otherBefore = await usdc.balanceOf(other.address);
      await pool.connect(trader1).claimPayout(other.address);
      expect(await usdc.balanceOf(other.address)).to.equal(otherBefore + credited);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 4. Blacklisted LP holder / treasury: fees accrue regardless, claims redirect
  // ═════════════════════════════════════════════════════════════════════════════

  describe("Fee accrual is blacklist-proof", function () {

    it("blacklisted LP holder: open succeeds, lpFee accrues, claimable to custom address", async function () {
      const { pool, usdc, creator, trader1, other } =
        await loadFixture(deployBlacklistPoolFixture);

      await usdc.blacklist(creator.address);

      // Opens never transfer to the LP — nothing to fail.
      await pool.connect(trader1).openLong(ethers.parseUnits("100", 6), 0n, trader1.address);

      const accrued = await pool.lpFeesAccumulated();
      expect(accrued).to.be.gt(0n);
      expect(await pool.lpFeesPaidTotal()).to.equal(0n);

      // Blacklisted LP redirects the claim to a clean address.
      const otherBefore = await usdc.balanceOf(other.address);
      await pool.connect(creator).claimFees(other.address);
      expect(await usdc.balanceOf(other.address)).to.equal(otherBefore + accrued);
      expect(await pool.lpFeesAccumulated()).to.equal(0n);
      expect(await pool.lpFeesPaidTotal()).to.equal(accrued);
    });

    it("blacklisted treasury: open succeeds, protocolFee accrues, claimable to custom address", async function () {
      const { pool, usdc, treasury, trader1, other } =
        await loadFixture(deployBlacklistPoolFixture);

      await usdc.blacklist(treasury.address);

      await pool.connect(trader1).openLong(ethers.parseUnits("100", 6), 0n, trader1.address);

      const accrued = await pool.protocolFeesAccumulated();
      expect(accrued).to.be.gt(0n);

      // Blacklisted treasury redirects the claim to another address.
      const otherBefore = await usdc.balanceOf(other.address);
      await pool.connect(treasury).claimProtocolFees(other.address);
      expect(await usdc.balanceOf(other.address)).to.equal(otherBefore + accrued);
      expect(await pool.protocolFeesAccumulated()).to.equal(0n);
      expect(await pool.protocolFeesPaidTotal()).to.equal(accrued);
    });

    it("blacklisted treasury: voluntary closeLong still succeeds, closeFee accrues", async function () {
      const { pool, usdc, treasury, trader1, trader2 } =
        await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);
      await usdc.blacklist(treasury.address);

      const protoBefore = await pool.protocolFeesAccumulated();
      await pool.connect(trader1).closeLong(nftId, 0n);
      expect(await pool.protocolFeesAccumulated()).to.be.gt(protoBefore);
    });

    it("expired close with blacklisted treasury: closeFee accrues, cleanup succeeds", async function () {
      const { pool, usdc, treasury, trader1, trader2, other } =
        await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);
      await usdc.blacklist(treasury.address);
      await time.increase(Number(SEVEN_DAYS) + 1);

      const protoBefore = await pool.protocolFeesAccumulated();
      await pool.connect(other).closePositionAfterDeadline(nftId, 0n);
      expect(await pool.protocolFeesAccumulated()).to.be.gt(protoBefore);
      expect(await pool.openPositionCount()).to.equal(0n);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 5. Underwater expired positions: nothing credited, cleanup unaffected
  // ═════════════════════════════════════════════════════════════════════════════

  describe("Underwater positions: unaffected by blacklist", function () {

    it("underwater expired long with blacklisted holder: cleanup succeeds, nothing credited", async function () {
      const { pool, usdc, baseToken, trader1, trader2, other } =
        await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("500", 6));

      // Crash price
      await baseToken.mint(trader2.address, ethers.parseEther("5000000"));
      await pool.connect(trader2).swap(ethers.parseEther("5000000"), 0n, true, trader2.address);

      await usdc.blacklist(trader1.address);
      await time.increase(Number(SEVEN_DAYS) + 1);

      await pool.connect(other).closePositionAfterDeadline(nftId, 0n);

      expect(await pool.claimable(trader1.address)).to.equal(0n);
      expect(await pool.totalClaimable()).to.equal(0n);
      expect(await pool.openPositionCount()).to.equal(0n);
    });
  });
});
