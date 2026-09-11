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

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const INITIAL_USDC   = ethers.parseUnits("10000", 6);
const INITIAL_TOKEN  = ethers.parseEther("1000000");
const TRADER_USDC    = ethers.parseUnits("1000", 6);
const TRADER_TOKEN   = ethers.parseEther("10000");
const SWAP_FEE_BPS   = 100n;
const BPS_DENOM      = 10_000n;
const LP_FEE_BPS     = 400n;
const PROTO_FEE_BPS  = 100n;
const IMPACT_FEE_BPS = 1500n;


const SEVEN_DAYS = 7n * 24n * 60n * 60n;

// ─────────────────────────────────────────────────────────────────────────────
// System deployment (mirrors Expiry.ts)
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
    throw new Error(`patchImmutableAddress: ${fromAddress} not found in bytecode`);
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

  const poolDeployer = await (await ethers.getContractFactory("PoolDeployer"))
    .connect(sysDeployer).deploy();

  const factory = (await (await ethers.getContractFactory("EXNIHILOFactory"))
    .connect(sysDeployer)
    .deploy(
      positionNFTAddr,
      await lpNft.getAddress(),
      usdcAddr,
      treasuryAddr,
      await poolDeployer.getAddress()
    )) as unknown as EXNIHILOFactory;

  await patchImmutableAddress(
    await lpNft.getAddress(),
    throwaway.address,
    await factory.getAddress()
  );

  return { factory, lpNft };
}

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

  const log = receipt!.logs
    .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "MarketCreated")!;

  const poolAddress: string = log.args.pool;
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
    poolAddress,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function openLong(
  pool: EXNIHILOPool, trader: HardhatEthersSigner, usdcAmount: bigint
): Promise<bigint> {
  const tx = await pool.connect(trader).openLong(usdcAmount, 0n, trader.address);
  const receipt = await tx.wait();
  const log = receipt!.logs
    .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "PositionOpened")!;
  return log.args.nftId as bigint;
}

async function openShort(
  pool: EXNIHILOPool, trader: HardhatEthersSigner, usdcAmount: bigint
): Promise<bigint> {
  const tx = await pool.connect(trader).openShort(usdcAmount, 0n, trader.address);
  const receipt = await tx.wait();
  const log = receipt!.logs
    .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "PositionOpened")!;
  return log.args.nftId as bigint;
}

/**
 * Blocks the expiry settlement guard holds third parties off after a large swap
 * (EXNIHILOPool.SETTLE_GUARD_BLOCKS). These helpers move the price by far more
 * than the 1 %-of-reserves arming threshold, so they mine past the window — the
 * tests below then jump days of wall time, which on Avalanche is hundreds of
 * thousands of blocks. Tests that exercise the guard itself swap directly
 * instead of going through these.
 */
const SETTLE_GUARD_BLOCKS = 5;

/** Pump the token price (longs profit): trader swaps USDC → token. */
async function pumpPrice(fix: Awaited<ReturnType<typeof deployPoolFixture>>, usdcIn: bigint) {
  await fix.pool.connect(fix.trader2).swap(usdcIn, 0n, false, fix.trader2.address);
  await mine(SETTLE_GUARD_BLOCKS);
}

/** Dump the token price (shorts profit, longs drown): trader sells tokens. */
async function dumpPrice(fix: Awaited<ReturnType<typeof deployPoolFixture>>, tokenIn: bigint) {
  await fix.baseToken.mint(fix.trader2.address, tokenIn);
  await fix.pool.connect(fix.trader2).swap(tokenIn, 0n, true, fix.trader2.address);
  await mine(SETTLE_GUARD_BLOCKS);
}

/** Replicates _cpAmountOut (constant product with spot-value swap fee). */
function cpAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (reserveIn === 0n || reserveOut === 0n) return 0n;
  const rawOut = (amountIn * reserveOut) / (reserveIn + amountIn);
  const feeNum = amountIn * reserveOut * SWAP_FEE_BPS;
  const feeDen = reserveIn * BPS_DENOM;
  // Ceil, matching the contract: a positive fee never truncates to zero.
  const fee    = feeNum === 0n ? 0n : (feeNum + feeDen - 1n) / feeDen;
  return rawOut <= fee ? 0n : rawOut - fee;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Dynamic renewal fee properties
// ─────────────────────────────────────────────────────────────────────────────

describe("AutoRenew: dynamic renewal fee", function () {

  it("fee matches the formula exactly for a profitable long (base on mark + OI slice)", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openLong(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    await pumpPrice(fix, ethers.parseUnits("2000", 6));

    const pos = await fix.positionNFT.getPosition(nftId);
    const n   = pos.airUsdMinted;

    // Replicate _priceClose for the long.
    const airTokenSupply = await fix.pool.airTokenSupply();
    const backedAirUsd   = await fix.pool.backedAirUsd();
    const airUsdOut = cpAmountOut(pos.lockedAmount, airTokenSupply - pos.lockedAmount, backedAirUsd);
    expect(airUsdOut).to.be.gt(n); // sanity: position is in profit
    const surplus = airUsdOut - n;

    const mark   = n + surplus;
    const oi     = await fix.pool.longOpenInterest();
    const offset = oi - n;
    const expected =
      (mark * PROTO_FEE_BPS) / BPS_DENOM +
      (mark * LP_FEE_BPS) / BPS_DENOM +
      (IMPACT_FEE_BPS * n * (2n * offset + n)) / (2n * backedAirUsd * BPS_DENOM);

    expect(await fix.pool.quoteRenewFee(nftId)).to.equal(expected);
  });

  it("fee is monotone in profit: pumping the price raises a long's renewal fee", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openLong(fix.pool, fix.trader1, ethers.parseUnits("100", 6));

    const quoteFlat = await fix.pool.quoteRenewFee(nftId);
    await pumpPrice(fix, ethers.parseUnits("2000", 6));
    const quotePumped = await fix.pool.quoteRenewFee(nftId);

    expect(quotePumped).to.be.gt(quoteFlat);
  });

  it("fee is monotone in OI: crowding the same side raises the renewal fee by the exact slice delta", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const nA = ethers.parseUnits("100", 6);
    const nB = ethers.parseUnits("400", 6);
    const idA = await openLong(fix.pool, fix.trader1, nA);

    const quoteBefore = await fix.pool.quoteRenewFee(idA);
    await openLong(fix.pool, fix.trader3, nB); // does not move A's surplus, only OI

    const backed = await fix.pool.backedAirUsd();
    // offset for A grows 0 → nB, so the slice grows by IMPACT × nA × nB / (backed × BPS)
    const expectedDelta = (IMPACT_FEE_BPS * nA * nB) / (backed * BPS_DENOM);

    expect(await fix.pool.quoteRenewFee(idA)).to.equal(quoteBefore + expectedDelta);
  });

  it("floor at status quo: an underwater position pays full original size, never less", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openLong(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    const pos = await fix.positionNFT.getPosition(nftId);
    const n   = pos.airUsdMinted;

    const quoteFlat = await fix.pool.quoteRenewFee(nftId);
    await dumpPrice(fix, ethers.parseEther("500000")); // long deeply underwater

    // surplus term is 0; only the impact slice's denominator (backedAirUsd)
    // moved with the dump. Recompute the slice at current reserves.
    const backed = await fix.pool.backedAirUsd();
    const expected =
      (n * PROTO_FEE_BPS) / BPS_DENOM +
      (n * LP_FEE_BPS) / BPS_DENOM +
      (IMPACT_FEE_BPS * n * n) / (2n * backed * BPS_DENOM);

    expect(await fix.pool.quoteRenewFee(nftId)).to.equal(expected);
    // and the base component never dropped below the flat 5% of original size
    expect(await fix.pool.quoteRenewFee(nftId)).to.be.gte(quoteFlat);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Auto-renew opt-in on the PositionNFT
// ─────────────────────────────────────────────────────────────────────────────

describe("AutoRenew: opt-in flag", function () {

  it("holder can set and unset; getAutoRenew reflects it; event emitted", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openLong(fix.pool, fix.trader1, ethers.parseUnits("100", 6));

    const cap = ethers.parseUnits("10", 6);
    await expect(fix.positionNFT.connect(fix.trader1).setAutoRenew(nftId, true, cap))
      .to.emit(fix.positionNFT, "AutoRenewSet").withArgs(nftId, true, cap);

    let [enabled, maxFee] = await fix.positionNFT.getAutoRenew(nftId);
    expect(enabled).to.equal(true);
    expect(maxFee).to.equal(cap);

    await expect(fix.positionNFT.connect(fix.trader1).setAutoRenew(nftId, false, 0n))
      .to.emit(fix.positionNFT, "AutoRenewSet").withArgs(nftId, false, 0n);

    [enabled, maxFee] = await fix.positionNFT.getAutoRenew(nftId);
    expect(enabled).to.equal(false);
    expect(maxFee).to.equal(0n);
  });

  it("non-holder cannot set the flag", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openLong(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    await expect(
      fix.positionNFT.connect(fix.trader2).setAutoRenew(nftId, true, 1n)
    ).to.be.revertedWithCustomError(fix.positionNFT, "OnlyTokenOwner");
  });

  it("transfer clears the flag — a buyer does not inherit the opt-in", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openLong(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    await fix.positionNFT.connect(fix.trader1).setAutoRenew(nftId, true, ethers.MaxUint256);

    await expect(
      fix.positionNFT.connect(fix.trader1)
        .transferFrom(fix.trader1.address, fix.trader2.address, nftId)
    ).to.emit(fix.positionNFT, "AutoRenewSet").withArgs(nftId, false, 0n);

    const [enabled] = await fix.positionNFT.getAutoRenew(nftId);
    expect(enabled).to.equal(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. settleExpired — keeper close (no opt-in, no bounty)
// ─────────────────────────────────────────────────────────────────────────────

describe("AutoRenew: settleExpired close path", function () {

  it("reverts before the deadline", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openLong(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    await expect(
      fix.pool.connect(fix.other).settleExpired(nftId, 0n)
    ).to.be.revertedWithCustomError(fix.pool, "PositionNotExpired");
  });

  it("profitable close: the holder is credited the whole payout, the caller earns nothing", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openLong(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    await pumpPrice(fix, ethers.parseUnits("2000", 6));
    await time.increase(Number(SEVEN_DAYS) + 1);

    // quoteClose returns surplus net of the 1% close fee.
    const [ready, pnl] = await fix.pool.quoteClose(nftId);
    expect(ready).to.equal(true);
    expect(pnl).to.be.gt(0);

    const keeperBefore = await fix.usdc.balanceOf(fix.other.address);
    await fix.pool.connect(fix.other).settleExpired(nftId, 0n);

    // Settling is unpaid, so nothing can be carved out of the holder's payout —
    // the bug this replaced let a flat bounty exceed the surplus it came from
    // and hand the caller 100% of a holder's profit.
    expect(await fix.usdc.balanceOf(fix.other.address)).to.equal(keeperBefore);
    expect(await fix.pool.claimable(fix.trader1.address)).to.equal(BigInt(pnl));
    await expect(fix.positionNFT.ownerOf(nftId)).to.be.reverted; // burned
  });

  it("underwater close: collateral returns to the LP untouched, holder gets nothing", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openLong(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    await dumpPrice(fix, ethers.parseEther("500000"));
    await time.increase(Number(SEVEN_DAYS) + 1);

    const keeperBefore = await fix.usdc.balanceOf(fix.other.address);
    const backedBefore = await fix.pool.backedAirUsd();

    await fix.pool.connect(fix.other).settleExpired(nftId, 0n);

    expect(await fix.usdc.balanceOf(fix.other.address)).to.equal(keeperBefore);
    expect(await fix.pool.backedAirUsd()).to.equal(backedBefore);
    expect(await fix.pool.claimable(fix.trader1.address)).to.equal(0n);
    await expect(fix.positionNFT.ownerOf(nftId)).to.be.reverted; // burned
  });

  it("underwater short close: the whole locked collateral returns to the LP", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openShort(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    await pumpPrice(fix, ethers.parseUnits("3000", 6)); // price up → short underwater
    await time.increase(Number(SEVEN_DAYS) + 1);

    const pos = await fix.positionNFT.getPosition(nftId);
    const keeperBefore = await fix.usdc.balanceOf(fix.other.address);
    const backedBefore = await fix.pool.backedAirUsd();

    await fix.pool.connect(fix.other).settleExpired(nftId, 0n);

    expect(await fix.usdc.balanceOf(fix.other.address)).to.equal(keeperBefore);
    expect(await fix.pool.backedAirUsd())
      .to.equal(backedBefore + pos.lockedAmount);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. settleExpired — auto-renewal from position equity
// ─────────────────────────────────────────────────────────────────────────────

describe("AutoRenew: equity-funded auto-renewal", function () {

  async function profitableExpiredLong() {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openLong(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    await fix.positionNFT.connect(fix.trader1).setAutoRenew(nftId, true, ethers.MaxUint256);
    await pumpPrice(fix, ethers.parseUnits("2000", 6));
    await time.increase(Number(SEVEN_DAYS) + 1);
    return { fix, nftId };
  }

  it("long: debt grows by the fee, deadline extends, caller unpaid, fees accrue", async function () {
    const { fix, nftId } = await profitableExpiredLong();

    const posBefore = await fix.positionNFT.getPosition(nftId);
    const fee  = await fix.pool.quoteRenewFee(nftId);
    const cost = fee;

    const keeperBefore = await fix.usdc.balanceOf(fix.other.address);
    const backedBefore = await fix.pool.backedAirUsd();
    const supplyBefore = await fix.pool.airUsdSupply();
    const oiBefore     = await fix.pool.longOpenInterest();
    const lpBefore     = await fix.pool.lpFeesAccumulated();
    const protoBefore  = await fix.pool.protocolFeesAccumulated();

    await expect(fix.pool.connect(fix.other).settleExpired(nftId, 0n))
      .to.emit(fix.pool, "PositionRenewed");

    const posAfter = await fix.positionNFT.getPosition(nftId);
    const latest   = BigInt(await time.latest());

    // Position: debt grew by cost, collateral untouched, deadline from now.
    expect(posAfter.airUsdMinted).to.equal(posBefore.airUsdMinted + cost);
    expect(posAfter.lockedAmount).to.equal(posBefore.lockedAmount);
    expect(posAfter.feesPaid).to.equal(posBefore.feesPaid + fee);
    // Duration steps with market age, so read what the pool would issue now
    // rather than assuming the 7-day step the position was opened under.
    const dur = await fix.pool.currentPositionDuration();
    expect(posAfter.deadline).to.be.gte(latest + dur - 10n);
    expect(posAfter.deadline).to.be.lte(latest + dur + 10n);

    // Pool accounting: reserves fund the fee now, recouped at close via the
    // grown debt; supply counter net unchanged; OI tracks the new debt.
    expect(await fix.pool.backedAirUsd()).to.equal(backedBefore - cost);
    expect(await fix.pool.airUsdSupply()).to.equal(supplyBefore);
    expect(await fix.pool.longOpenInterest()).to.equal(oiBefore + cost);

    // The whole cost is the fee, and it goes to the LP and the protocol —
    // the caller who triggered the renewal is paid nothing.
    expect(await fix.usdc.balanceOf(fix.other.address)).to.equal(keeperBefore);
    const lpDelta    = (await fix.pool.lpFeesAccumulated()) - lpBefore;
    const protoDelta = (await fix.pool.protocolFeesAccumulated()) - protoBefore;
    expect(lpDelta + protoDelta).to.equal(fee);

    // Position is still open and closable by the holder afterwards.
    expect(await fix.positionNFT.ownerOf(nftId)).to.equal(fix.trader1.address);
    await fix.pool.connect(fix.trader1).closeLong(nftId, 0n);
  });

  it("short: locked collateral shrinks by the fee, deadline extends", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openShort(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    await fix.positionNFT.connect(fix.trader1).setAutoRenew(nftId, true, ethers.MaxUint256);
    await dumpPrice(fix, ethers.parseEther("300000")); // price down → short profits
    await time.increase(Number(SEVEN_DAYS) + 1);

    const posBefore = await fix.positionNFT.getPosition(nftId);
    const fee  = await fix.pool.quoteRenewFee(nftId);
    const cost = fee;

    const keeperBefore = await fix.usdc.balanceOf(fix.other.address);
    const backedBefore = await fix.pool.backedAirUsd();
    const supplyBefore = await fix.pool.airUsdSupply();
    const oiBefore     = await fix.pool.shortOpenInterest();

    await fix.pool.connect(fix.other).settleExpired(nftId, 0n);

    const posAfter = await fix.positionNFT.getPosition(nftId);
    expect(posAfter.lockedAmount).to.equal(posBefore.lockedAmount - cost);
    expect(posAfter.airTokenMinted).to.equal(posBefore.airTokenMinted);

    // Locked collateral leaves supply accounting; backed reserves untouched;
    // short OI (original notional) unchanged.
    expect(await fix.pool.airUsdSupply()).to.equal(supplyBefore - cost);
    expect(await fix.pool.backedAirUsd()).to.equal(backedBefore);
    expect(await fix.pool.shortOpenInterest()).to.equal(oiBefore);
    expect(await fix.usdc.balanceOf(fix.other.address)).to.equal(keeperBefore);

    await fix.pool.connect(fix.trader1).closeShort(nftId, 0n);
  });

  it("falls through to close when the position cannot fund the fee (underwater)", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openLong(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    await fix.positionNFT.connect(fix.trader1).setAutoRenew(nftId, true, ethers.MaxUint256);
    await dumpPrice(fix, ethers.parseEther("500000"));
    await time.increase(Number(SEVEN_DAYS) + 1);

    await fix.pool.connect(fix.other).settleExpired(nftId, 0n);
    await expect(fix.positionNFT.ownerOf(nftId)).to.be.reverted; // closed, not renewed
  });

  it("falls through to close when the fee exceeds the holder's cap", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openLong(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    await fix.positionNFT.connect(fix.trader1).setAutoRenew(nftId, true, 1n); // absurdly low cap
    await pumpPrice(fix, ethers.parseUnits("2000", 6));
    await time.increase(Number(SEVEN_DAYS) + 1);

    await fix.pool.connect(fix.other).settleExpired(nftId, 0n);
    await expect(fix.positionNFT.ownerOf(nftId)).to.be.reverted; // closed
    expect(await fix.pool.claimable(fix.trader1.address)).to.be.gt(0n); // profit credited
  });

  it("does not renew past closeDate: a closing pool settles instead", async function () {
    const { fix, nftId } = await profitableExpiredLong();

    await fix.pool.connect(fix.creator).closePool();
    await fix.pool.connect(fix.other).settleExpired(nftId, 0n);
    await expect(fix.positionNFT.ownerOf(nftId)).to.be.reverted; // closed
  });

  it("closePositionAfterDeadline cannot bypass an executable auto-renewal", async function () {
    const { fix, nftId } = await profitableExpiredLong();

    await expect(
      fix.pool.connect(fix.other).closePositionAfterDeadline(nftId, 0n)
    ).to.be.revertedWithCustomError(fix.pool, "AutoRenewActive");

    // settleExpired renews it instead.
    await fix.pool.connect(fix.other).settleExpired(nftId, 0n);
    expect(await fix.positionNFT.ownerOf(nftId)).to.equal(fix.trader1.address);
  });

  it("closePositionAfterDeadline still closes when the opt-in cannot execute", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openLong(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    await fix.positionNFT.connect(fix.trader1).setAutoRenew(nftId, true, ethers.MaxUint256);
    await dumpPrice(fix, ethers.parseEther("500000")); // underwater → not fundable
    await time.increase(Number(SEVEN_DAYS) + 1);

    await fix.pool.connect(fix.other).closePositionAfterDeadline(nftId, 0n);
    await expect(fix.positionNFT.ownerOf(nftId)).to.be.reverted; // burned
  });

  it("a winning position can sustain itself across several cycles", async function () {
    const { fix, nftId } = await profitableExpiredLong();

    for (let i = 0; i < 3; i++) {
      await fix.pool.connect(fix.other).settleExpired(nftId, 0n);
      expect(await fix.positionNFT.ownerOf(nftId)).to.equal(fix.trader1.address);
      // Each renewal extends by whatever step the market's age now sits in —
      // 7 days early on, 30 days once it is past a week old. Warping a fixed
      // 7 days would leave the position unexpired on later cycles.
      const dur = await fix.pool.currentPositionDuration();
      await time.increase(Number(dur) + 1);
    }

    // Still closable with profit at the end.
    const [ready, pnl] = await fix.pool.quoteClose(nftId);
    expect(ready).to.equal(true);
    expect(pnl).to.be.gt(0);
    await fix.pool.connect(fix.trader1).closeLong(nftId, 0n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Expiry settlement guard — swap-driven manipulation of the renew/close
//    decision and of the settled payout
// ─────────────────────────────────────────────────────────────────────────────

const SETTLE_GUARD_BPS = 100n;
const RENEW_MARGIN_BPS = 200n;

/** Replicates _priceClose's surplus for a long at current reserves. */
async function longSurplus(
  fix: Awaited<ReturnType<typeof deployPoolFixture>>, nftId: bigint
): Promise<bigint> {
  const pos = await fix.positionNFT.getPosition(nftId);
  const airTokenSupply = await fix.pool.airTokenSupply();
  const backedAirUsd   = await fix.pool.backedAirUsd();
  const airUsdOut = cpAmountOut(
    pos.lockedAmount, airTokenSupply - pos.lockedAmount, backedAirUsd
  );
  return airUsdOut > pos.airUsdMinted ? airUsdOut - pos.airUsdMinted : 0n;
}

/**
 * Probes the auto-renew verdict without mutating state: closePositionAfterDeadline
 * reverts with AutoRenewActive exactly when _autoRenewQuote says renewable.
 */
async function isRenewable(
  fix: Awaited<ReturnType<typeof deployPoolFixture>>, nftId: bigint
): Promise<boolean> {
  try {
    await fix.pool.connect(fix.other).closePositionAfterDeadline.staticCall(nftId, 0n);
    return false;
  } catch (err) {
    if (String(err).includes("AutoRenewActive")) return true;
    throw err;
  }
}

describe("Swap fee: no free dust swaps", function () {

  /**
   * The spot-value fee is a fraction of the OUTPUT token, so a trade small
   * enough that its fee is below one output atom used to floor to zero and hand
   * back the full raw CP output — a swap with no LP yield, contradicting
   * the 1 % swapFeeBps constant. The fee now ceils, so such trades either pay one atom or
   * produce zero output and revert.
   */
  it("a dust swap never returns the full raw constant-product output", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const reserveIn  = await fix.pool.backedAirToken();
    const reserveOut = await fix.pool.backedAirUsd();

    // token → USDC is the exposed direction: the fee is a fraction of the
    // OUTPUT token, and USDC has only 6 decimals against the token's 18. On a
    // 1e24 token / 1e10 USDC pool, 0.001 token yields 10 USDC atoms while the
    // mathematical fee is 0.1 of an atom — which floored to nothing.
    const amountIn = 10n ** 15n;
    const rawOut = (amountIn * reserveOut) / (reserveIn + amountIn);
    expect(rawOut).to.be.gt(0n); // the trade would otherwise succeed for free
    const flooredFee = (amountIn * reserveOut * SWAP_FEE_BPS) / (reserveIn * BPS_DENOM);
    expect(flooredFee).to.equal(0n); // the old behaviour: a fee-free swap

    const netOut = cpAmountOut(amountIn, reserveIn, reserveOut);
    expect(netOut).to.equal(rawOut - 1n); // charged the minimum representable fee

    const before = await fix.usdc.balanceOf(fix.trader2.address);
    await fix.pool.connect(fix.trader2).swap(amountIn, 0n, true, fix.trader2.address);
    const received = (await fix.usdc.balanceOf(fix.trader2.address)) - before;

    expect(received).to.equal(netOut);
    expect(received).to.be.lt(rawOut); // the pool kept fee value
  });

  it("a trade whose raw output cannot cover one atom of fee is rejected", async function () {
    const fix = await loadFixture(deployPoolFixture);

    // token → USDC: 1 token wei out of a 1e24 token reserve rounds to no USDC
    // at all, so netOut is 0 and the existing guard rejects it rather than
    // taking the input for nothing.
    await expect(
      fix.pool.connect(fix.trader2).swap(1n, 0n, true, fix.trader2.address)
    ).to.be.revertedWithCustomError(fix.pool, "InsufficientOutput");
  });

  it("the fee is unchanged for ordinary trade sizes (ceil costs at most one atom)", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const reserveIn  = await fix.pool.backedAirUsd();
    const reserveOut = await fix.pool.backedAirToken();
    const amountIn   = ethers.parseUnits("100", 6);

    const rawOut = (amountIn * reserveOut) / (reserveIn + amountIn);
    const floored = rawOut - (amountIn * reserveOut * SWAP_FEE_BPS) / (reserveIn * BPS_DENOM);
    const ceiled  = cpAmountOut(amountIn, reserveIn, reserveOut);

    expect(floored - ceiled).to.be.lte(1n);

    const before = await fix.baseToken.balanceOf(fix.trader2.address);
    await fix.pool.connect(fix.trader2).swap(amountIn, 0n, false, fix.trader2.address);
    expect((await fix.baseToken.balanceOf(fix.trader2.address)) - before).to.equal(ceiled);
  });
});

describe("AutoRenew: expiry settlement guard", function () {

  /** Renewable expired long, guard window already elapsed. */
  async function renewableExpiredLong() {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openLong(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    await fix.positionNFT.connect(fix.trader1).setAutoRenew(nftId, true, ethers.MaxUint256);
    await pumpPrice(fix, ethers.parseUnits("2000", 6)); // mines past the window
    await time.increase(Number(SEVEN_DAYS) + 1);
    expect(await isRenewable(fix, nftId)).to.equal(true);
    return { fix, nftId };
  }

  /** Expired long, guard window already elapsed. Not necessarily renewable. */
  async function expiredLong() {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openLong(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    await pumpPrice(fix, ethers.parseUnits("2000", 6)); // mines past the window
    await time.increase(Number(SEVEN_DAYS) + 1);
    return { fix, nftId };
  }

  /** Expired short, guard window already elapsed. */
  async function expiredShort() {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openShort(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    await dumpPrice(fix, ethers.parseEther("20000")); // shorts profit; mines past window
    await time.increase(Number(SEVEN_DAYS) + 1);
    return { fix, nftId };
  }

  /**
   * The old settlementGuardArmingSize(): SETTLE_GUARD_BPS of live USDC depth.
   * The contract no longer exposes this — arming is net price displacement over
   * a block, not the size of one call — but it remains a useful yardstick for
   * sizing swaps around the threshold in these tests.
   */
  async function armingSize(
    fix: Awaited<ReturnType<typeof deployPoolFixture>>
  ): Promise<bigint> {
    return ((await fix.pool.backedAirUsd()) * SETTLE_GUARD_BPS) / BPS_DENOM;
  }

  /** Relative move of a ratio, in bps. */
  function movedBps(num0: bigint, den0: bigint, num1: bigint, den1: bigint): bigint {
    const a = num1 * den0;
    const b = num0 * den1;
    const delta = a > b ? a - b : b - a;
    return (delta * BPS_DENOM) / (num0 * den1);
  }

  it("a fresh pool is unguarded — never-armed is not a live window", async function () {
    const fix = await loadFixture(deployPoolFixture);
    expect(await fix.pool.lastLargeSwapBlock()).to.equal(0n);
    expect(await fix.pool.settlementGuardedUntilBlock()).to.equal(0n);
  });

  it("blocks the atomic attack: a swap that flips the verdict also arms the guard", async function () {
    const { fix, nftId } = await renewableExpiredLong();

    // The dump needed to push surplus below the fee + margin is far above the
    // 1 %-of-reserves arming threshold, so it cannot be hidden from the guard.
    await fix.baseToken.mint(fix.trader2.address, ethers.parseEther("400000"));
    await fix.pool.connect(fix.trader2).swap(
      ethers.parseEther("400000"), 0n, true, fix.trader2.address
    );
    expect(await fix.pool.lastLargeSwapBlock()).to.be.gt(0n);
    expect(await fix.pool.settlementGuardedUntilBlock()).to.be.gt(0n);

    // Both expiry entry points are shut to the attacker for the window.
    await expect(fix.pool.connect(fix.trader2).settleExpired(nftId, 0n))
      .to.be.revertedWithCustomError(fix.pool, "SettlementGuardActive");
    await expect(fix.pool.connect(fix.trader2).closePositionAfterDeadline(nftId, 0n))
      .to.be.revertedWithCustomError(fix.pool, "SettlementGuardActive");

    // And the dump really did flip the verdict — the guard, not a missing
    // effect, is what stopped it. Holding the manipulation across the window is
    // the arbitrage exposure that makes the attack cost something.
    await mine(SETTLE_GUARD_BLOCKS);
    expect(await fix.pool.settlementGuardedUntilBlock()).to.equal(0n);
    expect(await isRenewable(fix, nftId)).to.equal(false);
  });

  it("guard also covers the payout: no settling an expired position inside the window", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openLong(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    await pumpPrice(fix, ethers.parseUnits("2000", 6));
    await time.increase(Number(SEVEN_DAYS) + 1);

    // No auto-renew opt-in at all: the position would simply close. A third
    // party still cannot pick the price it closes at.
    await fix.baseToken.mint(fix.trader2.address, ethers.parseEther("200000"));
    await fix.pool.connect(fix.trader2).swap(
      ethers.parseEther("200000"), 0n, true, fix.trader2.address
    );

    await expect(fix.pool.connect(fix.trader2).settleExpired(nftId, 0n))
      .to.be.revertedWithCustomError(fix.pool, "SettlementGuardActive");
  });

  it("dust cannot grief settlement: a sub-threshold swap does not arm the guard", async function () {
    const { fix, nftId } = await renewableExpiredLong();

    const armedBefore = await fix.pool.lastLargeSwapBlock();

    // Comfortably under the threshold. Arming is now measured as displacement
    // of the settlement ratio rather than as raw input size, and a USDC → token
    // swap moves both terms of it, so a trade at threshold-minus-one-wei sits
    // on the boundary rather than safely below it. Half the yardstick is
    // unambiguously dust.
    await fix.pool.connect(fix.trader2).swap(
      (await armingSize(fix)) / 2n, 0n, false, fix.trader2.address
    );

    expect(await fix.pool.lastLargeSwapBlock()).to.equal(armedBefore);
    expect(await fix.pool.settlementGuardedUntilBlock()).to.equal(0n);

    // Settlement still works — repeating this every block cannot stall cleanup.
    await fix.pool.connect(fix.other).settleExpired(nftId, 0n);
    expect(await fix.positionNFT.ownerOf(nftId)).to.equal(fix.trader1.address);
  });

  it("a swap at exactly the arming size does arm it", async function () {
    const { fix, nftId } = await renewableExpiredLong();

    await fix.pool.connect(fix.trader2).swap(
      await armingSize(fix), 0n, false, fix.trader2.address
    );

    expect(await fix.pool.settlementGuardedUntilBlock()).to.be.gt(0n);
    await expect(fix.pool.connect(fix.other).settleExpired(nftId, 0n))
      .to.be.revertedWithCustomError(fix.pool, "SettlementGuardActive");
  });

  it("the margin bounds what a non-arming swap can do: surplus swing stays under it", async function () {
    const { fix, nftId } = await renewableExpiredLong();

    const pos = await fix.positionNFT.getPosition(nftId);

    // Largest swap that still slips under the guard, in the direction that
    // suppresses a long's surplus: scale down until its USDC leg is under the
    // arming size, so this is the worst case the guard lets through.
    const backedToken  = await fix.pool.backedAirToken();
    const backedUsd    = await fix.pool.backedAirUsd();
    const tokenSupply  = await fix.pool.airTokenSupply();
    const usdSupply    = await fix.pool.airUsdSupply();

    // Largest swap that still slips under the guard. Arming is now the net
    // displacement of EITHER settlement ratio over the block, and a token → USDC
    // swap moves both terms of both ratios, so the evading size is smaller than
    // the old "netOut under 1 % of depth" yardstick. Scale down until both
    // ratios stay inside the threshold.
    let tokenIn = ethers.parseEther("40000");
    for (;;) {
      const netOut = cpAmountOut(tokenIn, backedToken, backedUsd);
      const longMove  = movedBps(
        backedUsd, tokenSupply, backedUsd - netOut, tokenSupply + tokenIn
      );
      const shortMove = movedBps(
        backedToken, usdSupply, backedToken + tokenIn, usdSupply - netOut
      );
      if (longMove < SETTLE_GUARD_BPS && shortMove < SETTLE_GUARD_BPS) break;
      tokenIn = (tokenIn * 9n) / 10n;
    }

    const armedBefore = await fix.pool.lastLargeSwapBlock();
    const before = await longSurplus(fix, nftId);
    // Margin is a fraction of the MARK, which is what a proportional reserve
    // move actually scales — see SETTLE_GUARD_BPS in EXNIHILOPool.
    const margin = ((pos.airUsdMinted + before) * RENEW_MARGIN_BPS) / BPS_DENOM;

    await fix.baseToken.mint(fix.trader2.address, tokenIn);
    await fix.pool.connect(fix.trader2).swap(tokenIn, 0n, true, fix.trader2.address);
    expect(await fix.pool.lastLargeSwapBlock()).to.equal(armedBefore); // did not arm

    const after = await longSurplus(fix, nftId);
    const swing = before > after ? before - after : after - before;

    // This is the pairing the two constants exist for: anything small enough to
    // evade the guard moves the decision variable by less than the margin, so it
    // cannot flip a verdict that clears the margin.
    expect(swing).to.be.lt(margin);
    expect(await isRenewable(fix, nftId)).to.equal(true);
  });

  it("the renew verdict matches surplus >= fee + margin exactly, at several price levels", async function () {
    for (const pump of ["500", "2000", "5000"]) {
      const fix = await loadFixture(deployPoolFixture);
      const nftId = await openLong(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
      await fix.positionNFT.connect(fix.trader1).setAutoRenew(nftId, true, ethers.MaxUint256);
      await pumpPrice(fix, ethers.parseUnits(pump, 6));
      await time.increase(Number(SEVEN_DAYS) + 1);

      const pos     = await fix.positionNFT.getPosition(nftId);
      const surplus = await longSurplus(fix, nftId);
      const fee     = await fix.pool.quoteRenewFee(nftId);
      const margin  = ((pos.airUsdMinted + surplus) * RENEW_MARGIN_BPS) / BPS_DENOM;

      expect(await isRenewable(fix, nftId), `pump ${pump}`)
        .to.equal(surplus >= fee + margin);
    }
  });

  it("the holder is never blocked by the guard", async function () {
    const { fix, nftId } = await renewableExpiredLong();

    await fix.baseToken.mint(fix.trader2.address, ethers.parseEther("400000"));
    await fix.pool.connect(fix.trader2).swap(
      ethers.parseEther("400000"), 0n, true, fix.trader2.address
    );
    expect(await fix.pool.settlementGuardedUntilBlock()).to.be.gt(0n);

    // A third party is shut out, but the holder can still act on their own
    // position — an armed guard must never trap someone in a position.
    await expect(fix.pool.connect(fix.other).settleExpired(nftId, 0n))
      .to.be.revertedWithCustomError(fix.pool, "SettlementGuardActive");
    await fix.pool.connect(fix.trader1).settleExpired(nftId, 0n);
    await expect(fix.positionNFT.ownerOf(nftId)).to.be.reverted; // closed
  });

  it("the holder can still renew directly while the guard is armed", async function () {
    const { fix, nftId } = await renewableExpiredLong();

    await fix.pool.connect(fix.trader2).swap(
      ethers.parseUnits("3000", 6), 0n, false, fix.trader2.address
    );
    expect(await fix.pool.settlementGuardedUntilBlock()).to.be.gt(0n);

    await expect(fix.pool.connect(fix.trader1).renewPosition(nftId, ethers.MaxUint256))
      .to.emit(fix.pool, "PositionRenewed");
  });

  it("settlement itself does not arm the guard — a keeper can batch expiries", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const idA = await openLong(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    const idB = await openLong(fix.pool, fix.trader3, ethers.parseUnits("100", 6));
    await pumpPrice(fix, ethers.parseUnits("2000", 6));
    await time.increase(Number(SEVEN_DAYS) + 1);

    const armedBefore = await fix.pool.lastLargeSwapBlock();
    await fix.pool.connect(fix.other).settleExpired(idA, 0n);
    expect(await fix.pool.lastLargeSwapBlock()).to.equal(armedBefore);
    await fix.pool.connect(fix.other).settleExpired(idB, 0n);
    await expect(fix.positionNFT.ownerOf(idB)).to.be.reverted;
  });

  // NOTE ON SCOPE. A long settles against backedAirUsd / airTokenSupply and a
  // short against backedAirToken / airUsdSupply (see _priceClose). openLong
  // writes airUsdSupply and backedAirToken; openShort writes airTokenSupply and
  // backedAirUsd. So openLong moves a SHORT's settlement price and openShort
  // moves a LONG's — each is inert against its own side.
  //
  // The guard arms pool-wide rather than per-side: if EITHER ratio moved, no
  // third party settles anything for the window. That deliberately over-blocks
  // — an openLong cannot have moved a long's price, yet still blocks settling
  // one. The precision is not worth a second latch and a side-aware view; a
  // holder is never blocked from their own position, so the cost is bounded to
  // a few seconds of third-party cleanup delay.

  it("a small open moves neither price and does not arm the guard", async function () {
    const { fix, nftId } = await renewableExpiredLong();

    const armedBefore = await fix.pool.lastLargeSwapBlock();
    await openLong(fix.pool, fix.trader3, ethers.parseUnits("20", 6));
    expect(await fix.pool.lastLargeSwapBlock()).to.equal(armedBefore);

    await fix.pool.connect(fix.other).settleExpired(nftId, 0n);
    expect(await fix.positionNFT.ownerOf(nftId)).to.equal(fix.trader1.address);
  });

  it("arming is pool-wide: an open that moves only the short price still blocks a long settle", async function () {
    const { fix, nftId } = await renewableExpiredLong();

    const usd0 = await fix.pool.backedAirUsd();
    const sup0 = await fix.pool.airTokenSupply();

    await openLong(fix.pool, fix.trader3, ethers.parseUnits("500", 6));

    // The long victim's own ratio is untouched by an openLong …
    expect(await fix.pool.backedAirUsd()).to.equal(usd0);
    expect(await fix.pool.airTokenSupply()).to.equal(sup0);

    // … but the short-side ratio moved, and the guard is pool-wide.
    expect(await fix.pool.lastLargeSwapBlock()).to.be.gt(0n);
    await expect(fix.pool.connect(fix.other).settleExpired(nftId, 0n))
      .to.be.revertedWithCustomError(fix.pool, "SettlementGuardActive");
  });

  it("openShort moves an expiring LONG's price and arms the guard", async function () {
    const { fix, nftId } = await expiredLong();

    const usd0 = await fix.pool.backedAirUsd();
    const sup0 = await fix.pool.airTokenSupply();

    await openShort(fix.pool, fix.trader3, ethers.parseUnits("1500", 6));

    const usd1 = await fix.pool.backedAirUsd();
    const sup1 = await fix.pool.airTokenSupply();

    // The open really did move the price this settlement is quoted from.
    expect(movedBps(usd0, sup0, usd1, sup1)).to.be.gt(SETTLE_GUARD_BPS);

    expect(await fix.pool.lastLargeSwapBlock()).to.equal(
      BigInt(await ethers.provider.getBlockNumber())
    );
    await expect(fix.pool.connect(fix.other).settleExpired(nftId, 0n))
      .to.be.revertedWithCustomError(fix.pool, "SettlementGuardActive");
  });

  it("openLong moves an expiring SHORT's price and arms the guard", async function () {
    const { fix, nftId } = await expiredShort();

    const tok0 = await fix.pool.backedAirToken();
    const sup0 = await fix.pool.airUsdSupply();

    await openLong(fix.pool, fix.trader3, ethers.parseUnits("1500", 6));

    const tok1 = await fix.pool.backedAirToken();
    const sup1 = await fix.pool.airUsdSupply();

    expect(movedBps(tok0, sup0, tok1, sup1)).to.be.gt(SETTLE_GUARD_BPS);

    expect(await fix.pool.lastLargeSwapBlock()).to.equal(
      BigInt(await ethers.provider.getBlockNumber())
    );
    await expect(fix.pool.connect(fix.other).settleExpired(nftId, 0n))
      .to.be.revertedWithCustomError(fix.pool, "SettlementGuardActive");
  });

  it("sub-threshold swaps in one block arm the guard cumulatively", async function () {
    const { fix, nftId } = await expiredLong();

    const usd0 = await fix.pool.backedAirUsd();
    const sup0 = await fix.pool.airTokenSupply();

    // Each chunk's USDC leg lands under SETTLE_GUARD_BPS of live depth, so not
    // one of them arms the guard on its own. netOut scales with backedAirUsd,
    // so a fixed token chunk holds a roughly constant ratio as depth falls.
    const chunk = ethers.parseEther("6000");
    const chunks = 25;
    await fix.baseToken.mint(fix.trader2.address, chunk * BigInt(chunks));

    await ethers.provider.send("evm_setAutomine", [false]);
    for (let i = 0; i < chunks; i++) {
      await fix.pool.connect(fix.trader2).swap(chunk, 0n, true, fix.trader2.address);
    }
    await mine(1);
    await ethers.provider.send("evm_setAutomine", [true]);

    const usd1 = await fix.pool.backedAirUsd();
    const sup1 = await fix.pool.airTokenSupply();

    // Every chunk was individually under the threshold …
    const perChunk = ((usd0 - usd1) * BPS_DENOM) / (usd0 * BigInt(chunks));
    expect(perChunk).to.be.lt(SETTLE_GUARD_BPS);
    // … and together they moved the settlement price far past it.
    expect(movedBps(usd0, sup0, usd1, sup1)).to.be.gt(SETTLE_GUARD_BPS * 5n);

    expect(await fix.pool.lastLargeSwapBlock()).to.be.gt(0n);
    await expect(fix.pool.connect(fix.other).settleExpired(nftId, 0n))
      .to.be.revertedWithCustomError(fix.pool, "SettlementGuardActive");
  });

  it("the holder is still exempt after an open arms the guard", async function () {
    const { fix, nftId } = await expiredLong();

    await openShort(fix.pool, fix.trader3, ethers.parseUnits("1500", 6));
    expect(await fix.pool.lastLargeSwapBlock()).to.be.gt(0n);

    // An armed guard must never trap a holder in their own position.
    await fix.pool.connect(fix.trader1).settleExpired(nftId, 0n);
    await expect(fix.positionNFT.ownerOf(nftId)).to.be.reverted;
  });

  it("the window expires after exactly SETTLE_GUARD_BLOCKS", async function () {
    const { fix, nftId } = await renewableExpiredLong();

    const tx = await fix.pool.connect(fix.trader2).swap(
      ethers.parseUnits("3000", 6), 0n, false, fix.trader2.address
    );
    const armedAt = BigInt((await tx.wait())!.blockNumber);
    expect(await fix.pool.lastLargeSwapBlock()).to.equal(armedAt);
    expect(await fix.pool.settlementGuardedUntilBlock())
      .to.equal(armedAt + BigInt(SETTLE_GUARD_BLOCKS));

    await mine(BigInt(SETTLE_GUARD_BLOCKS) - 1n);
    expect(await fix.pool.settlementGuardedUntilBlock()).to.be.gt(0n);

    await mine(1);
    expect(await fix.pool.settlementGuardedUntilBlock()).to.equal(0n);
    await fix.pool.connect(fix.other).settleExpired(nftId, 0n);
  });
});
