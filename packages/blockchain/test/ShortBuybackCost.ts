import { expect } from "chai";
import { ethers } from "hardhat";
import { time, mine } from "@nomicfoundation/hardhat-network-helpers";
import { EXNIHILOPool, MockERC20 } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * What a short pays to retire its debt.
 *
 * Settlement does not route the buyback through the curve — it burns the debt
 * and keeps `cost` airUsd for the LP — so `cost` has to BE the curve's price for
 * that debt, or the difference is taken from one side and handed to the other.
 *
 * It used to prorate a full-collateral trade: cost = locked x debt / totalBuyable.
 * Constant-product output is concave, so buying part of the maximum costs less
 * than that share of the maximum input, and the holder was charged the gap. The
 * tests below pin the cost to the actual inverse of _cpAmountOut, computed here
 * independently, and check the two things the change must not break: the
 * underwater boundary, and the reserve accounting.
 */

const DAY = 24 * 3600;
const SWAP_FEE_BPS = 100n;
const BPS = 10_000n;
const CLOSE_FEE_BPS = 100n;

// ── Reference implementation, deliberately not sharing code with the contract ──

/** EXNIHILOPool._cpAmountOut. */
function cpAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (reserveIn === 0n || reserveOut === 0n) return 0n;
  const rawOut = (amountIn * reserveOut) / (reserveIn + amountIn);
  const feeNum = amountIn * reserveOut * SWAP_FEE_BPS;
  const feeDen = reserveIn * BPS;
  const fee = feeNum === 0n ? 0n : (feeNum + feeDen - 1n) / feeDen;
  return rawOut <= fee ? 0n : rawOut - fee;
}

/** Smallest input whose output covers `debt` — what the buyback truly costs. */
function exactCost(debt: bigint, reserveIn: bigint, reserveOut: bigint, hi: bigint): bigint {
  if (debt === 0n) return 0n;
  let lo = reserveOut > debt
    ? (debt * reserveIn + (reserveOut - debt) - 1n) / (reserveOut - debt)
    : 0n;
  if (lo > hi) lo = 0n;
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n;
    if (cpAmountOut(mid, reserveIn, reserveOut) >= debt) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/** The formula the contract used to apply. */
function proRataCost(locked: bigint, debt: bigint, totalBuyable: bigint): bigint {
  return (locked * debt + totalBuyable - 1n) / totalBuyable;
}

function netOf(surplus: bigint): bigint {
  return surplus - (surplus * CLOSE_FEE_BPS) / BPS;
}

// ── Fixture ───────────────────────────────────────────────────────────────────

async function fixture() {
  const signers = await ethers.getSigners();
  const [deployer, treasury, creator, trader1, trader2] = signers;

  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const usdc = (await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6)) as MockERC20;
  const token = (await MockERC20F.connect(deployer).deploy("Base", "BASE", 18)) as MockERC20;
  await usdc.waitForDeployment();
  await token.waitForDeployment();

  const positionNFT = await (await ethers.getContractFactory("PositionNFT"))
    .connect(deployer).deploy();
  const sysDeployer = signers[8];
  const poolDeployer = await (await ethers.getContractFactory("PoolDeployer"))
    .connect(sysDeployer).deploy();
  const predictedFactory = ethers.getCreateAddress({
    from: sysDeployer.address,
    nonce: await sysDeployer.getNonce(),
  });
  const lpNft = await (await ethers.getContractFactory("LpNFT"))
    .connect(deployer).deploy(predictedFactory);
  const factory = await (await ethers.getContractFactory("EXNIHILOFactory"))
    .connect(sysDeployer).deploy(
      await positionNFT.getAddress(),
      await lpNft.getAddress(),
      await usdc.getAddress(),
      treasury.address,
      await poolDeployer.getAddress(),
    );
  await (await positionNFT.connect(deployer).initFactory(await factory.getAddress())).wait();

  const LP_USDC = 100_000n * 10n ** 6n;
  const LP_TOKEN = 100_000n * 10n ** 18n;
  for (const s of [creator, trader1, trader2]) {
    await (await usdc.mint(s.address, 10_000_000n * 10n ** 6n)).wait();
    await (await token.mint(s.address, LP_TOKEN * 10n)).wait();
  }

  const factoryAddr = await factory.getAddress();
  await (await usdc.connect(creator).approve(factoryAddr, LP_USDC)).wait();
  await (await token.connect(creator).approve(factoryAddr, LP_TOKEN)).wait();
  const rc = await (
    await factory.connect(creator).createMarket(await token.getAddress(), LP_USDC, LP_TOKEN)
  ).wait();

  let poolAddress = "";
  for (const log of rc!.logs) {
    try {
      const p = factory.interface.parseLog(log);
      if (p?.name === "MarketCreated") poolAddress = p.args[0];
    } catch { /* skip */ }
  }
  const pool = (await ethers.getContractAt("EXNIHILOPool", poolAddress)) as unknown as EXNIHILOPool;

  await time.increase(DAY); // past the position-cap ramp

  return { pool, poolAddress, usdc, token, creator, trader1, trader2 };
}

async function openShort(
  pool: EXNIHILOPool, usdc: MockERC20, poolAddress: string,
  trader: HardhatEthersSigner, notional: bigint,
): Promise<bigint> {
  const fee = await pool.quoteOpenFee(notional, false);
  await (await usdc.connect(trader).approve(poolAddress, fee * 2n)).wait();
  const rc = await (await pool.connect(trader).openShort(notional, 0n, trader.address)).wait();
  for (const log of rc!.logs) {
    try {
      const p = pool.interface.parseLog(log);
      if (p?.name === "PositionOpened") return p.args[0] as bigint;
    } catch { /* skip */ }
  }
  throw new Error("no PositionOpened");
}

/** Sell token into the pool, which drops its price — a short moves into profit. */
async function sellToken(
  pool: EXNIHILOPool, token: MockERC20, poolAddress: string,
  trader: HardhatEthersSigner, amountIn: bigint,
) {
  await (await token.connect(trader).approve(poolAddress, amountIn)).wait();
  await (await pool.connect(trader).swap(amountIn, 0n, true, trader.address)).wait();
}

/** Everything _priceCloseAt reads for a short, as of the latest block. */
async function shortInputs(pool: EXNIHILOPool, nftId: bigint) {
  const [locked, debt] = await pool.liveAmountsOf(nftId);
  const reserveIn = (await pool.airUsdSupply()) - locked;
  const reserveOut = await pool.backedAirToken();
  const totalBuyable = cpAmountOut(locked, reserveIn, reserveOut);
  return { locked, debt, reserveIn, reserveOut, totalBuyable };
}

describe("Short debt buyback cost", function () {
  const NOTIONAL = 5_000n * 10n ** 6n;

  // ───────────────────────────────────────────────────────────────────────────
  describe("matches the inverse of the curve", function () {
    // Each sale drops the token price further, walking the position from barely
    // profitable to deep in the money — the whole range where the pro-rata
    // estimate and the true cost diverge.
    for (const sold of [6_000n, 12_000n, 30_000n]) {
      it(`after ${sold} tokens are sold into the pool`, async function () {
        const f = await fixture();
        const id = await openShort(f.pool, f.usdc, f.poolAddress, f.trader1, NOTIONAL);
        await sellToken(f.pool, f.token, f.poolAddress, f.trader2, sold * 10n ** 18n);
        await mine(6); // clear the clamp ring so live pricing is what is quoted

        const { locked, debt, reserveIn, reserveOut, totalBuyable } =
          await shortInputs(f.pool, id);
        expect(totalBuyable).to.be.greaterThanOrEqual(debt);

        const cost = exactCost(debt, reserveIn, reserveOut, locked);
        const [ready, pnl] = await f.pool.quoteCloseUnclamped(id);

        expect(ready).to.equal(true);
        expect(pnl).to.equal(netOf(locked - cost));

        // And it is strictly better than the formula it replaced.
        const old = proRataCost(locked, debt, totalBuyable);
        expect(cost).to.be.lessThan(old);
      });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("the boundary it must not move", function () {
    it("never prices the buyback above the collateral that backs it", async function () {
      const f = await fixture();
      const id = await openShort(f.pool, f.usdc, f.poolAddress, f.trader1, NOTIONAL);

      // Walk the price the wrong way for the short, up to the point the pool
      // refuses to price the close at all.
      for (let i = 0; i < 6; i++) {
        const { locked, debt, reserveIn, reserveOut, totalBuyable } =
          await shortInputs(f.pool, id);
        if (totalBuyable < debt) break; // not priceable; nothing to compare

        const cost = exactCost(debt, reserveIn, reserveOut, locked);
        expect(cost).to.be.lessThanOrEqual(locked);

        const [, pnl] = await f.pool.quoteCloseUnclamped(id);
        // Solvent here, so the quote is a payout and never a shortfall.
        expect(pnl).to.be.greaterThanOrEqual(0n);

        await (await f.usdc.connect(f.trader2).approve(f.poolAddress, 4_000n * 10n ** 6n)).wait();
        await (await f.pool.connect(f.trader2)
          .swap(4_000n * 10n ** 6n, 0n, false, f.trader2.address)).wait();
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("settlement", function () {
    it("pays the holder the exact-cost surplus and leaves the reserves consistent", async function () {
      const f = await fixture();
      const id = await openShort(f.pool, f.usdc, f.poolAddress, f.trader1, NOTIONAL);
      await sellToken(f.pool, f.token, f.poolAddress, f.trader2, 10_000n * 10n ** 18n);
      await mine(6);

      const { locked, debt, reserveIn, reserveOut, totalBuyable } =
        await shortInputs(f.pool, id);
      const expectedNet = netOf(locked - exactCost(debt, reserveIn, reserveOut, locked));
      const proRataNet = netOf(locked - proRataCost(locked, debt, totalBuyable));

      const before = await f.usdc.balanceOf(f.trader1.address);
      await (await f.pool.connect(f.trader1).closeShort(id, 0n, f.trader1.address)).wait();
      const paid = (await f.usdc.balanceOf(f.trader1.address)) - before;

      expect(paid).to.equal(expectedNet);
      expect(paid).to.be.greaterThan(proRataNet);
      expect(await f.pool.openPositionCount()).to.equal(0n);

      // The pool still covers everything it owes.
      expect(await f.usdc.balanceOf(f.poolAddress)).to.be.greaterThanOrEqual(
        (await f.pool.backedAirUsd())
          + (await f.pool.totalShortCollateral())
          + (await f.pool.lpFeesAccumulated())
          + (await f.pool.protocolFeesAccumulated())
          + (await f.pool.totalClaimable()),
      );
    });
  });
});
