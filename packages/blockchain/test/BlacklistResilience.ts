import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time, mine } from "@nomicfoundation/hardhat-network-helpers";
import type {
  EXNIHILOPool,
  EXNIHILOFactory,
  LpNFT,
  PositionNFT,
  MockERC20,
  BlacklistableERC20,
} from "../typechain-types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Mine past the close-price clamp window (EXNIHILOPool CLAMP_BLOCKS): a close
// is priced against the worst block-open inside it, so a test that moves the
// price and then closes waits it out first to price against the moved curve.
const CLAMP_BLOCKS = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const INITIAL_USDC  = ethers.parseUnits("10000", 6);
const INITIAL_TOKEN = ethers.parseEther("1000000");
const TRADER_USDC   = ethers.parseUnits("5000", 6);
const SWAP_FEE_BPS  = 100n;
const SEVEN_DAYS    = 7n * 24n * 60n * 60n;

// ─────────────────────────────────────────────────────────────────────────────
// Bytecode-patch helper
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
    INITIAL_TOKEN); // 7-day default
  const receipt = await tx.wait();
  // Position caps ramp 1 %→20 % over 24 h. These tests are not about
  // caps, so start past the ramp where size is not the constraint.
  await time.increase(24 * 3600);

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
//   - Dust-sweep payouts are credited to `claimable` and withdrawn via
//     claimPayout(to); a voluntary close pays whoever the holder names.
// A blacklisted recipient therefore can never block any pool operation —
// blacklist DoS is structurally impossible, not merely handled.
// ─────────────────────────────────────────────────────────────────────────────

describe("Blacklist Resilience (pull payments)", function () {

  // ═════════════════════════════════════════════════════════════════════════════
  // 1. Baseline: a close pays where the holder says
  // ═════════════════════════════════════════════════════════════════════════════

  describe("Baseline: a close pays where the holder says", function () {

    it("profitable long: the holder names the recipient", async function () {
      const { pool, usdc, trader1, trader2, other } = await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);
      await mine(CLAMP_BLOCKS);

      const before = await usdc.balanceOf(other.address);
      await pool.connect(trader1).closeLong(nftId, 0n, other.address);
      expect(await pool.openPositionCount()).to.equal(0n);
      expect(await usdc.balanceOf(other.address)).to.be.gt(before);
    });

    it("profitable short: the holder names the recipient", async function () {
      const { pool, usdc, baseToken, trader1, trader2, other } =
        await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openShort(pool, trader1, ethers.parseUnits("100", 6));
      await baseToken.mint(trader2.address, ethers.parseEther("500000"));
      await pool.connect(trader2).swap(ethers.parseEther("500000"), 0n, true, trader2.address);
      await mine(CLAMP_BLOCKS);

      const before = await usdc.balanceOf(other.address);
      await pool.connect(trader1).closeShort(nftId, 0n, other.address);
      expect(await pool.openPositionCount()).to.equal(0n);
      expect(await usdc.balanceOf(other.address)).to.be.gt(before);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 2. A blacklisted holder still has an exit
  // ═════════════════════════════════════════════════════════════════════════════

  describe("Blacklisted holder: still has an exit", function () {

    it("cannot be paid to itself, but can name a clean recipient", async function () {
      // This is what replaced the expiry path. A blacklisted holder used to be
      // able to wait for a third party to settle their expired position and
      // credit the payout; positions no longer expire, so the voluntary close
      // carries the recipient instead. Without that, removing expiry would have
      // stranded them — the pool has no other way to hand them their profit.
      const { pool, usdc, trader1, trader2, other } = await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);
      await mine(CLAMP_BLOCKS);
      await usdc.blacklist(trader1.address);

      // Paying themselves is blocked by the blacklist, as it must be.
      await expect(pool.connect(trader1).closeLong(nftId, 0n, trader1.address)).to.be.reverted;

      // Redirecting is not.
      const otherBefore = await usdc.balanceOf(other.address);
      await pool.connect(trader1).closeLong(nftId, 0n, other.address);
      expect(await usdc.balanceOf(other.address)).to.be.gt(otherBefore);
      expect(await pool.openPositionCount()).to.equal(0n);
    });

    it("can also exit by transferring the position to a clean address", async function () {
      const { pool, usdc, positionNFT, trader1, trader2, other } =
        await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);
      await mine(CLAMP_BLOCKS);
      await usdc.blacklist(trader1.address);

      await positionNFT.connect(trader1).transferFrom(trader1.address, other.address, nftId);
      const before = await usdc.balanceOf(other.address);
      await pool.connect(other).closeLong(nftId, 0n, other.address);
      expect(await usdc.balanceOf(other.address)).to.be.gt(before);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 3. LP can removeLiquidity after blacklisted holder's position is cleaned up
  // ═════════════════════════════════════════════════════════════════════════════

  describe("LP exit unblocked after blacklisted position cleanup", function () {

    it("LP can removeLiquidity after a blacklisted holder's long is cleaned up", async function () {
      const { pool, usdc, baseToken, trader1, trader2, other, creator } =
        await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));

      // Pump to make profitable
      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);
      await mine(CLAMP_BLOCKS);

      // Blacklist holder
      await usdc.blacklist(trader1.address);

      // The holder closes to a clean address — the blacklist cannot keep the
      // position open, and therefore cannot keep the LP's principal locked.
      await pool.connect(trader1).closeLong(nftId, 0n, other.address);
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
      await mine(CLAMP_BLOCKS);
      await usdc.blacklist(trader1.address);

      // A sweep is the only path that still credits rather than pushes, since
      // it is the only one a stranger can call. Wind the pool down so the
      // position decays into sweep range.
      await pool.connect(creator).closePool();
      await time.increase(Number(SEVEN_DAYS) + 45 * 24 * 60 * 60);
      await pool.pokeFunding();
      await pool.connect(other).sweepDust(nftId);

      const credited = await pool.claimable(trader1.address);
      await pool.connect(creator).removeLiquidity();

      // Whatever was credited stays fully backed by pool USDC after the LP
      // exits — removeLiquidity withdraws the backed reserves, never the
      // liabilities standing against them.
      expect(await usdc.balanceOf(await pool.getAddress())).to.be.gte(credited);
      if (credited > 0n) {
        const otherBefore = await usdc.balanceOf(other.address);
        await pool.connect(trader1).claimPayout(other.address);
        expect(await usdc.balanceOf(other.address)).to.equal(otherBefore + credited);
      }
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
      await mine(CLAMP_BLOCKS);
      await usdc.blacklist(treasury.address);

      const protoBefore = await pool.protocolFeesAccumulated();
      await pool.connect(trader1).closeLong(nftId, 0n, trader1.address);
      expect(await pool.protocolFeesAccumulated()).to.be.gt(protoBefore);
    });

    it("redirected close with blacklisted treasury: closeFee accrues, cleanup succeeds", async function () {
      const { pool, usdc, treasury, trader1, trader2, other } =
        await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      await pool.connect(trader2).swap(ethers.parseUnits("2000", 6), 0n, false, trader2.address);
      await mine(CLAMP_BLOCKS);
      await usdc.blacklist(treasury.address);

      // The close fee accrues rather than transferring, so a blacklisted
      // treasury can never block a close — including one paying out elsewhere.
      const protoBefore = await pool.protocolFeesAccumulated();
      await pool.connect(trader1).closeLong(nftId, 0n, other.address);
      expect(await pool.protocolFeesAccumulated()).to.be.gt(protoBefore);
      expect(await pool.openPositionCount()).to.equal(0n);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 5. Underwater positions: nothing credited, cleanup unaffected
  // ═════════════════════════════════════════════════════════════════════════════

  describe("Underwater positions: unaffected by blacklist", function () {

    it("underwater long with blacklisted holder: sweep succeeds, nothing credited", async function () {
      const { pool, usdc, baseToken, trader1, trader2, other, creator } =
        await loadFixture(deployBlacklistPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("500", 6));

      // Crash price
      await baseToken.mint(trader2.address, ethers.parseEther("5000000"));
      await pool.connect(trader2).swap(ethers.parseEther("5000000"), 0n, true, trader2.address);
      await mine(CLAMP_BLOCKS);

      await usdc.blacklist(trader1.address);

      // No deadline to settle at. The position decays until the wind-down puts
      // it in sweep range, and a stranger clears it then — crediting nothing,
      // because there is nothing to credit. The blacklist is irrelevant either
      // way: the sweep never transfers.
      await pool.connect(creator).closePool();
      await time.increase(Number(SEVEN_DAYS) + 45 * 24 * 60 * 60);
      await pool.pokeFunding();
      await pool.connect(other).sweepDust(nftId);

      expect(await pool.claimable(trader1.address)).to.equal(0n);
      expect(await pool.totalClaimable()).to.equal(0n);
      expect(await pool.openPositionCount()).to.equal(0n);
    });
  });
});
