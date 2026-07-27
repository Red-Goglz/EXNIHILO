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

const INITIAL_USDC   = ethers.parseUnits("10000", 6);
const INITIAL_TOKEN  = ethers.parseEther("1000000");
const TRADER_USDC    = ethers.parseUnits("1000", 6);
const TRADER_TOKEN   = ethers.parseEther("10000");
const SWAP_FEE_BPS   = 100n;
const BPS_DENOM      = 10_000n;
const LP_FEE_BPS     = 300n;
const PROTO_FEE_BPS  = 200n;
const IMPACT_FEE_BPS = 1500n;
const KEEPER_BOUNTY  = 50_000n; // 0.05 USDC

const MAX_POS_USD = ethers.parseUnits("9000", 6);
const MAX_POS_BPS = 9000n;

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
      SWAP_FEE_BPS,
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
    INITIAL_TOKEN,
    MAX_POS_USD,
    MAX_POS_BPS,
    0n);
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

/** Pump the token price (longs profit): trader swaps USDC → token. */
async function pumpPrice(fix: Awaited<ReturnType<typeof deployPoolFixture>>, usdcIn: bigint) {
  await fix.pool.connect(fix.trader2).swap(usdcIn, 0n, false, fix.trader2.address);
}

/** Dump the token price (shorts profit, longs drown): trader sells tokens. */
async function dumpPrice(fix: Awaited<ReturnType<typeof deployPoolFixture>>, tokenIn: bigint) {
  await fix.baseToken.mint(fix.trader2.address, tokenIn);
  await fix.pool.connect(fix.trader2).swap(tokenIn, 0n, true, fix.trader2.address);
}

/** Replicates _cpAmountOut (constant product with spot-value swap fee). */
function cpAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (reserveIn === 0n || reserveOut === 0n) return 0n;
  const rawOut = (amountIn * reserveOut) / (reserveIn + amountIn);
  const fee    = (amountIn * reserveOut * SWAP_FEE_BPS) / (reserveIn * BPS_DENOM);
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
// 3. settleExpired — keeper close with bounty (no opt-in)
// ─────────────────────────────────────────────────────────────────────────────

describe("AutoRenew: settleExpired close path with bounty", function () {

  it("reverts before the deadline", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openLong(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    await expect(
      fix.pool.connect(fix.other).settleExpired(nftId, 0n)
    ).to.be.revertedWithCustomError(fix.pool, "PositionNotExpired");
  });

  it("profitable close: keeper earns the bounty, holder is credited the rest", async function () {
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

    expect(await fix.usdc.balanceOf(fix.other.address)).to.equal(keeperBefore + KEEPER_BOUNTY);
    expect(await fix.pool.claimable(fix.trader1.address)).to.equal(BigInt(pnl) - KEEPER_BOUNTY);
    await expect(fix.positionNFT.ownerOf(nftId)).to.be.reverted; // burned
  });

  it("underwater close: keeper earns the bounty from the LP side, holder gets nothing", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openLong(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    await dumpPrice(fix, ethers.parseEther("500000"));
    await time.increase(Number(SEVEN_DAYS) + 1);

    const keeperBefore = await fix.usdc.balanceOf(fix.other.address);
    const backedBefore = await fix.pool.backedAirUsd();

    await fix.pool.connect(fix.other).settleExpired(nftId, 0n);

    expect(await fix.usdc.balanceOf(fix.other.address)).to.equal(keeperBefore + KEEPER_BOUNTY);
    expect(await fix.pool.backedAirUsd()).to.equal(backedBefore - KEEPER_BOUNTY);
    expect(await fix.pool.claimable(fix.trader1.address)).to.equal(0n);
    await expect(fix.positionNFT.ownerOf(nftId)).to.be.reverted; // burned
  });

  it("underwater short close: bounty is carved from the returned locked collateral", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openShort(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    await pumpPrice(fix, ethers.parseUnits("3000", 6)); // price up → short underwater
    await time.increase(Number(SEVEN_DAYS) + 1);

    const pos = await fix.positionNFT.getPosition(nftId);
    const keeperBefore = await fix.usdc.balanceOf(fix.other.address);
    const backedBefore = await fix.pool.backedAirUsd();

    await fix.pool.connect(fix.other).settleExpired(nftId, 0n);

    expect(await fix.usdc.balanceOf(fix.other.address)).to.equal(keeperBefore + KEEPER_BOUNTY);
    expect(await fix.pool.backedAirUsd())
      .to.equal(backedBefore + pos.lockedAmount - KEEPER_BOUNTY);
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

  it("long: debt grows by fee + bounty, deadline extends, keeper paid, fees accrue", async function () {
    const { fix, nftId } = await profitableExpiredLong();

    const posBefore = await fix.positionNFT.getPosition(nftId);
    const fee  = await fix.pool.quoteRenewFee(nftId);
    const cost = fee + KEEPER_BOUNTY;

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
    expect(posAfter.deadline).to.be.gte(latest + SEVEN_DAYS - 10n);
    expect(posAfter.deadline).to.be.lte(latest + SEVEN_DAYS + 10n);

    // Pool accounting: reserves fund fee+bounty now, recouped at close via the
    // grown debt; supply counter net unchanged; OI tracks the new debt.
    expect(await fix.pool.backedAirUsd()).to.equal(backedBefore - cost);
    expect(await fix.pool.airUsdSupply()).to.equal(supplyBefore);
    expect(await fix.pool.longOpenInterest()).to.equal(oiBefore + cost);

    // Fee split + bounty.
    expect(await fix.usdc.balanceOf(fix.other.address)).to.equal(keeperBefore + KEEPER_BOUNTY);
    const lpDelta    = (await fix.pool.lpFeesAccumulated()) - lpBefore;
    const protoDelta = (await fix.pool.protocolFeesAccumulated()) - protoBefore;
    expect(lpDelta + protoDelta).to.equal(fee);

    // Position is still open and closable by the holder afterwards.
    expect(await fix.positionNFT.ownerOf(nftId)).to.equal(fix.trader1.address);
    await fix.pool.connect(fix.trader1).closeLong(nftId, 0n);
  });

  it("short: locked collateral shrinks by fee + bounty, deadline extends", async function () {
    const fix = await loadFixture(deployPoolFixture);
    const nftId = await openShort(fix.pool, fix.trader1, ethers.parseUnits("100", 6));
    await fix.positionNFT.connect(fix.trader1).setAutoRenew(nftId, true, ethers.MaxUint256);
    await dumpPrice(fix, ethers.parseEther("300000")); // price down → short profits
    await time.increase(Number(SEVEN_DAYS) + 1);

    const posBefore = await fix.positionNFT.getPosition(nftId);
    const fee  = await fix.pool.quoteRenewFee(nftId);
    const cost = fee + KEEPER_BOUNTY;

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
    expect(await fix.usdc.balanceOf(fix.other.address)).to.equal(keeperBefore + KEEPER_BOUNTY);

    await fix.pool.connect(fix.trader1).closeShort(nftId, 0n);
  });

  it("falls through to close when the position cannot fund fee + bounty (underwater)", async function () {
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
      await time.increase(Number(SEVEN_DAYS) + 1);
    }

    // Still closable with profit at the end.
    const [ready, pnl] = await fix.pool.quoteClose(nftId);
    expect(ready).to.equal(true);
    expect(pnl).to.be.gt(0);
    await fix.pool.connect(fix.trader1).closeLong(nftId, 0n);
  });
});
