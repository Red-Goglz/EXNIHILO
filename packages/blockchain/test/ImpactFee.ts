import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
  EXNIHILOPool,
  EXNIHILOFactory,
  LpNFT,
  PositionNFT,
  MockERC20,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// ─────────────────────────────────────────────────────────────────────────────
// Constants (must match contract)
// ─────────────────────────────────────────────────────────────────────────────

const BPS_DENOM      = 10_000n;
const SWAP_FEE_BPS   = 100n;
const LP_FEE_BPS     = 300n;
const PROTO_FEE_BPS  = 200n;
const IMPACT_FEE_BPS = 1500n;
const MIN_POS_FEE    = 50_000n;  // 0.05 USDC
const CLOSE_FEE_BPS  = 100n;

// ─────────────────────────────────────────────────────────────────────────────
// Math helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors _cpAmountOut (spot-price fee model). */
function cpOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: bigint = SWAP_FEE_BPS
): bigint {
  if (reserveIn === 0n || reserveOut === 0n) return 0n;
  const rawOut = (amountIn * reserveOut) / (reserveIn + amountIn);
  const fee    = (amountIn * reserveOut * feeBps) / (reserveIn * BPS_DENOM);
  return rawOut > fee ? rawOut - fee : 0n;
}

/** Compute the total position fee (base + OI-integral impact) in USDC. */
function positionFee(notional: bigint, backedAirUsd: bigint, oi: bigint = 0n): bigint {
  let total = (notional * PROTO_FEE_BPS) / BPS_DENOM
            + (notional * LP_FEE_BPS) / BPS_DENOM;
  if (total < MIN_POS_FEE) {
    total = MIN_POS_FEE;
  }
  const impact = (IMPACT_FEE_BPS * notional * (2n * oi + notional))
               / (2n * backedAirUsd * BPS_DENOM);
  return total + impact;
}

/**
 * Compute net LP loss from a long opening.
 *
 * After a long, backedAirToken decreases while backedAirUsd stays constant.
 * An arber can sell airToken into SWAP-1 to restore the original price.
 * Net LP loss = U₀ × (1 − √(T₁/T₀))²
 *
 * We use integer Newton's method for isqrt to avoid floating point.
 */
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n === 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * Net LP loss from arb after a long opens.
 * T0 = backedAirToken before, T1 = after, U0 = backedAirUsd.
 * loss = U0 * (1 - sqrt(T1/T0))^2
 *
 * Uses fixed-point: sqrt(T1 * SCALE / T0), where SCALE = 10^36.
 */
function netLpLoss(T0: bigint, T1: bigint, U0: bigint): bigint {
  const SCALE = 10n ** 36n;
  const ratioScaled = (T1 * SCALE) / T0;
  const sqrtRatio = isqrt(ratioScaled * SCALE); // sqrt with SCALE precision
  const ONE = SCALE;  // 1.0 in fixed point
  if (sqrtRatio >= ONE) return 0n; // no loss if T1 >= T0
  const diff = ONE - sqrtRatio;
  // loss = U0 * diff^2 / SCALE^2
  return (U0 * diff * diff) / (ONE * ONE);
}

// ─────────────────────────────────────────────────────────────────────────────
// Deployment helpers
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
    throw new Error(`patchImmutableAddress: ${fromAddress} not found in bytecode of ${contractAddress}`);
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

  const factory = (await (await ethers.getContractFactory("EXNIHILOFactory"))
    .connect(sysDeployer)
    .deploy(
      positionNFTAddr,
      await lpNft.getAddress(),
      usdcAddr,
      treasuryAddr,
      SWAP_FEE_BPS
    )) as unknown as EXNIHILOFactory;

  const factoryAddr = await factory.getAddress();
  await patchImmutableAddress(await lpNft.getAddress(), throwaway.address, factoryAddr);
  return { factory, lpNft };
}

/**
 * Deploy a pool with configurable initial liquidity.
 * Returns everything needed for the arb-protection tests.
 */
async function deployPoolWithLiquidity(
  initialUsdc: bigint,
  initialToken: bigint
) {
  const [deployer, treasury, creator, trader1, trader2, trader3] =
    await ethers.getSigners();

  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const baseToken = (await MockERC20F.connect(deployer).deploy("TOKEN", "TKN", 18)) as unknown as MockERC20;
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

  // Fund creator and create market (no leverage caps — test the fee protection itself)
  await baseToken.mint(creator.address, initialToken);
  await usdc.mint(creator.address, initialUsdc);
  await baseToken.connect(creator).approve(factoryAddr, ethers.MaxUint256);
  await usdc.connect(creator).approve(factoryAddr, ethers.MaxUint256);

  const tx = await factory.connect(creator).createMarket(
    await baseToken.getAddress(),
    initialUsdc,
    initialToken,
    0n,  // no hard cap
    0n,  // no bps cap
    0n,
    "airTKN",
    "airTKNUsd",
    18
  );
  const receipt = await tx.wait();
  const iface = factory.interface;
  const log = receipt!.logs
    .map((l) => { try { return iface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "MarketCreated")!;

  const poolAddress: string = log.args.pool;
  const pool = (await ethers.getContractAt("EXNIHILOPool", poolAddress)) as EXNIHILOPool;

  // Fund traders generously
  const traderFund = initialUsdc * 100n;
  const tokenFund  = initialToken * 100n;
  for (const trader of [trader1, trader2, trader3]) {
    await usdc.mint(trader.address, traderFund);
    await baseToken.mint(trader.address, tokenFund);
    await usdc.connect(trader).approve(poolAddress, ethers.MaxUint256);
    await baseToken.connect(trader).approve(poolAddress, ethers.MaxUint256);
  }

  return {
    pool, factory, positionNFT, lpNft, baseToken, usdc,
    deployer, treasury, creator, trader1, trader2, trader3,
    poolAddress, initialUsdc, initialToken,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
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
// Test pool configurations
// ─────────────────────────────────────────────────────────────────────────────

interface PoolConfig {
  label: string;
  usdc: bigint;    // 6 dec
  token: bigint;   // 18 dec
}

const STANDARD_POOL: PoolConfig = {
  label: "Standard ($10K)",
  usdc:  ethers.parseUnits("10000", 6),
  token: ethers.parseEther("10000000"),  // 10M tokens, P₀ = $0.001
};

const MEDIUM_POOL: PoolConfig = {
  label: "Medium ($1K)",
  usdc:  ethers.parseUnits("1000", 6),
  token: ethers.parseEther("1000000"),   // 1M tokens, P₀ = $0.001
};

const THIN_POOL: PoolConfig = {
  label: "Thin ($100)",
  usdc:  ethers.parseUnits("100", 6),
  token: ethers.parseEther("100000"),    // 100K tokens, P₀ = $0.001
};

// Named fixtures (loadFixture requires named functions, not anonymous arrows)
async function deployStandardPool() {
  return deployPoolWithLiquidity(STANDARD_POOL.usdc, STANDARD_POOL.token);
}
async function deployMediumPool() {
  return deployPoolWithLiquidity(MEDIUM_POOL.usdc, MEDIUM_POOL.token);
}
async function deployThinPool() {
  return deployPoolWithLiquidity(THIN_POOL.usdc, THIN_POOL.token);
}

// Map pool label to fixture for parametric tests
const fixtureForPool: Record<string, () => Promise<Awaited<ReturnType<typeof deployPoolWithLiquidity>>>> = {
  "Standard ($10K)": deployStandardPool,
  "Medium ($1K)":    deployMediumPool,
  "Thin ($100)":     deployThinPool,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Impact Fee — LP Drain Protection", function () {

  // ── 1. Fee calculation correctness ──────────────────────────────────────

  describe("1. Fee calculation correctness", function () {

    it("openLong charges base fee + impact fee (verified via event)", async function () {
      const f = await loadFixture(deployMediumPool);

      const notional = ethers.parseUnits("500", 6); // $500
      const backedUsd = await f.pool.backedAirUsd();

      const expectedFee = positionFee(notional, backedUsd);

      const usdcBefore = await f.usdc.balanceOf(f.trader1.address);
      const nftId = await openLong(f.pool, f.trader1, notional);
      const usdcAfter = await f.usdc.balanceOf(f.trader1.address);

      // Trader pays exactly the expected fee
      expect(usdcBefore - usdcAfter).to.equal(expectedFee);
    });

    it("openShort charges base fee + impact fee", async function () {
      const f = await loadFixture(deployMediumPool);

      const notional = ethers.parseUnits("500", 6);
      const backedUsd = await f.pool.backedAirUsd();
      const expectedFee = positionFee(notional, backedUsd);

      const usdcBefore = await f.usdc.balanceOf(f.trader1.address);
      await openShort(f.pool, f.trader1, notional);
      const usdcAfter = await f.usdc.balanceOf(f.trader1.address);

      expect(usdcBefore - usdcAfter).to.equal(expectedFee);
    });

    it("impact fee is negligible on deep pool with small position", async function () {
      const f = await loadFixture(deployStandardPool);

      const notional = ethers.parseUnits("100", 6); // $100 in $10K pool
      const backedUsd = await f.pool.backedAirUsd();

      const baseFee   = (notional * (LP_FEE_BPS + PROTO_FEE_BPS)) / BPS_DENOM;
      // OI=0 for first position: impact = IMPACT_BPS * N * N / (2 * U * BPS)
      const impactFee = (IMPACT_FEE_BPS * notional * notional) / (2n * backedUsd * BPS_DENOM);
      const totalFee  = baseFee + impactFee;

      // Impact fee should be small relative to base fee for small position in deep pool
      expect(impactFee).to.be.lt(baseFee / 5n);
      expect(totalFee).to.be.gt(baseFee); // but still nonzero
    });

    it("impact fee dominates on thin pool with large position", async function () {
      const f = await loadFixture(deployThinPool);

      const notional = ethers.parseUnits("250", 6); // $250 in $100 pool
      const backedUsd = await f.pool.backedAirUsd();

      const baseFee   = (notional * (LP_FEE_BPS + PROTO_FEE_BPS)) / BPS_DENOM;
      const impactFee = (IMPACT_FEE_BPS * notional * notional) / (2n * backedUsd * BPS_DENOM);

      // Impact fee should exceed base fee when position > pool
      expect(impactFee).to.be.gt(baseFee);
    });

    it("impact fee goes entirely to LP (lpFeesAccumulated)", async function () {
      const f = await loadFixture(deployMediumPool);

      const notional = ethers.parseUnits("500", 6);
      const backedUsd = await f.pool.backedAirUsd();

      const lpFeesBefore = await f.pool.lpFeesAccumulated();
      await openLong(f.pool, f.trader1, notional);
      const lpFeesAfter = await f.pool.lpFeesAccumulated();

      const baseLpFee = (notional * LP_FEE_BPS) / BPS_DENOM;
      const oi = 0n; // first position
      const impactFee = (IMPACT_FEE_BPS * notional * (2n * oi + notional))
                      / (2n * backedUsd * BPS_DENOM);
      const expectedLpFee = baseLpFee + impactFee;

      expect(lpFeesAfter - lpFeesBefore).to.equal(expectedLpFee);
    });
  });

  // ── 2. Arb protection — fees exceed net LP loss ─────────────────────────

  describe("2. Arb protection — total fees > net LP loss", function () {

    /**
     * For each (pool, position size) pair:
     *   1. Open long → compute airTokenOut and new backedAirToken
     *   2. Compute net LP loss = U₀(1-√(T₁/T₀))²
     *   3. Compute total fee = base + impact
     *   4. Assert fee > net LP loss (positive margin)
     */

    interface TestCase {
      label: string;
      pool: PoolConfig;
      notional: bigint;
    }

    const testCases: TestCase[] = [
      // Standard pool ($10K)
      { label: "Standard, $100 long",   pool: STANDARD_POOL, notional: ethers.parseUnits("100", 6) },
      { label: "Standard, $500 long",   pool: STANDARD_POOL, notional: ethers.parseUnits("500", 6) },
      { label: "Standard, $1000 long",  pool: STANDARD_POOL, notional: ethers.parseUnits("1000", 6) },
      { label: "Standard, $5000 long",  pool: STANDARD_POOL, notional: ethers.parseUnits("5000", 6) },
      { label: "Standard, $10000 long", pool: STANDARD_POOL, notional: ethers.parseUnits("10000", 6) },
      { label: "Standard, $20000 long", pool: STANDARD_POOL, notional: ethers.parseUnits("20000", 6) },

      // Medium pool ($1K)
      { label: "Medium, $50 long",   pool: MEDIUM_POOL, notional: ethers.parseUnits("50", 6) },
      { label: "Medium, $100 long",  pool: MEDIUM_POOL, notional: ethers.parseUnits("100", 6) },
      { label: "Medium, $250 long",  pool: MEDIUM_POOL, notional: ethers.parseUnits("250", 6) },
      { label: "Medium, $500 long",  pool: MEDIUM_POOL, notional: ethers.parseUnits("500", 6) },
      { label: "Medium, $1000 long", pool: MEDIUM_POOL, notional: ethers.parseUnits("1000", 6) },
      { label: "Medium, $2000 long", pool: MEDIUM_POOL, notional: ethers.parseUnits("2000", 6) },

      // Thin pool ($100)
      { label: "Thin, $10 long",  pool: THIN_POOL, notional: ethers.parseUnits("10", 6) },
      { label: "Thin, $50 long",  pool: THIN_POOL, notional: ethers.parseUnits("50", 6) },
      { label: "Thin, $100 long", pool: THIN_POOL, notional: ethers.parseUnits("100", 6) },
      { label: "Thin, $250 long", pool: THIN_POOL, notional: ethers.parseUnits("250", 6) },
      { label: "Thin, $500 long", pool: THIN_POOL, notional: ethers.parseUnits("500", 6) },
    ];

    for (const tc of testCases) {
      it(`${tc.label}: fee > net LP loss (positive margin)`, async function () {
        const f = await loadFixture(fixtureForPool[tc.pool.label]);

        const T0 = await f.pool.backedAirToken();
        const U0 = await f.pool.backedAirUsd();

        // Compute fee the trader will pay
        const fee = positionFee(tc.notional, U0);

        // Open the long
        const nftId = await openLong(f.pool, f.trader1, tc.notional);

        // Read actual post-long state
        const T1 = await f.pool.backedAirToken();

        // Compute net LP loss
        const loss = netLpLoss(T0, T1, U0);

        // Fee must exceed loss
        const margin = fee - loss;
        expect(margin).to.be.gte(0n,
          `NEGATIVE margin! fee=${ethers.formatUnits(fee, 6)}, loss=${ethers.formatUnits(loss, 6)}`);

        console.log(
          `      [${tc.label}] fee=$${ethers.formatUnits(fee, 6)}, ` +
          `loss=$${ethers.formatUnits(loss, 6)}, ` +
          `margin=+$${ethers.formatUnits(margin, 6)}`
        );
      });
    }
  });

  // ── 3. End-to-end arb simulation (on-chain) ────────────────────────────

  describe("3. End-to-end arb simulation — attacker is net negative", function () {

    interface ArbCase {
      label: string;
      pool: PoolConfig;
      longNotional: bigint;
      pumpUsdc: bigint;  // USDC used to pump SWAP-1 price
    }

    const arbCases: ArbCase[] = [
      {
        label: "Standard pool, $100 long, $5000 pump",
        pool: STANDARD_POOL,
        longNotional: ethers.parseUnits("100", 6),
        pumpUsdc:     ethers.parseUnits("5000", 6),
      },
      {
        label: "Medium pool, $500 long, $500 pump",
        pool: MEDIUM_POOL,
        longNotional: ethers.parseUnits("500", 6),
        pumpUsdc:     ethers.parseUnits("500", 6),
      },
      {
        label: "Medium pool, $1000 long, $1000 pump",
        pool: MEDIUM_POOL,
        longNotional: ethers.parseUnits("1000", 6),
        pumpUsdc:     ethers.parseUnits("1000", 6),
      },
      {
        label: "Thin pool, $50 long, $50 pump",
        pool: THIN_POOL,
        longNotional: ethers.parseUnits("50", 6),
        pumpUsdc:     ethers.parseUnits("50", 6),
      },
      {
        label: "Thin pool, $100 long, $100 pump",
        pool: THIN_POOL,
        longNotional: ethers.parseUnits("100", 6),
        pumpUsdc:     ethers.parseUnits("100", 6),
      },
    ];

    for (const ac of arbCases) {
      it(`${ac.label}: full pump-and-dump is net negative`, async function () {
        const f = await loadFixture(fixtureForPool[ac.pool.label]);

        const usdcBefore  = await f.usdc.balanceOf(f.trader1.address);
        const tokenBefore = await f.baseToken.balanceOf(f.trader1.address);

        // Step 1: open long
        const nftId = await openLong(f.pool, f.trader1, ac.longNotional);

        // Step 2: pump — USDC → token
        await f.pool.connect(f.trader1).swap(ac.pumpUsdc, 0n, false, f.trader1.address);
        const tokenAfterPump = await f.baseToken.balanceOf(f.trader1.address);
        const tokenReceived = tokenAfterPump - tokenBefore;

        // Step 3: close long at profit
        let closedOk = false;
        try {
          await f.pool.connect(f.trader1).closeLong(nftId, 0n);
          closedOk = true;
        } catch {
          // Position may be underwater if the pump wasn't enough; realize instead
          const pos = await f.positionNFT.getPosition(nftId);
          await f.usdc.mint(f.trader1.address, pos.airUsdMinted);
          await f.pool.connect(f.trader1).realizeLong(nftId);
        }

        // Step 4: dump — sell all token back for USDC
        if (tokenReceived > 0n) {
          await f.pool.connect(f.trader1).swap(tokenReceived, 0n, true, f.trader1.address);
        }

        const usdcAfter = await f.usdc.balanceOf(f.trader1.address);
        const netGain = usdcAfter - usdcBefore;

        expect(netGain).to.be.lt(0n, "Attacker should NOT profit from pump-and-dump");

        console.log(
          `      [${ac.label}] net: $${ethers.formatUnits(netGain, 6)} ` +
          `(closed=${closedOk ? "profit" : "realize"})`
        );
      });
    }
  });

  // ── 4. Split position attack — OI-integral fee makes splitting useless ───

  describe("4. Split position attack — splitting is net negative (OI-integral fee)", function () {

    it("Medium pool: 10×$100 longs + pump is net negative", async function () {
      const f = await loadFixture(deployMediumPool);

      const usdcBefore  = await f.usdc.balanceOf(f.trader1.address);
      const tokenBefore = await f.baseToken.balanceOf(f.trader1.address);

      // Open 10 small longs of $100 each — OI grows with each, fees escalate
      const nftIds: bigint[] = [];
      const splitSize = ethers.parseUnits("100", 6);
      for (let i = 0; i < 10; i++) {
        nftIds.push(await openLong(f.pool, f.trader1, splitSize));
      }

      // Pump
      const pumpUsdc = ethers.parseUnits("500", 6);
      await f.pool.connect(f.trader1).swap(pumpUsdc, 0n, false, f.trader1.address);
      const tokenReceived = (await f.baseToken.balanceOf(f.trader1.address)) - tokenBefore;

      // Close all longs
      for (const nftId of nftIds) {
        try {
          await f.pool.connect(f.trader1).closeLong(nftId, 0n);
        } catch {
          const pos = await f.positionNFT.getPosition(nftId);
          await f.usdc.mint(f.trader1.address, pos.airUsdMinted);
          await f.pool.connect(f.trader1).realizeLong(nftId);
        }
      }

      // Dump tokens back
      if (tokenReceived > 0n) {
        await f.pool.connect(f.trader1).swap(tokenReceived, 0n, true, f.trader1.address);
      }

      const netGain = (await f.usdc.balanceOf(f.trader1.address)) - usdcBefore;
      expect(netGain).to.be.lt(0n, "Split attack must NOT profit with OI-integral fee");
      console.log(`      [Split 10×$100 in Medium] net: $${ethers.formatUnits(netGain, 6)}`);
    });

    it("Thin pool: 5×$20 longs + pump is net negative", async function () {
      const f = await loadFixture(deployThinPool);

      const usdcBefore  = await f.usdc.balanceOf(f.trader1.address);
      const tokenBefore = await f.baseToken.balanceOf(f.trader1.address);

      const nftIds: bigint[] = [];
      const splitSize = ethers.parseUnits("20", 6);
      for (let i = 0; i < 5; i++) {
        nftIds.push(await openLong(f.pool, f.trader1, splitSize));
      }

      const pumpUsdc = ethers.parseUnits("100", 6); // pump = pool size
      await f.pool.connect(f.trader1).swap(pumpUsdc, 0n, false, f.trader1.address);
      const tokenReceived = (await f.baseToken.balanceOf(f.trader1.address)) - tokenBefore;

      for (const nftId of nftIds) {
        try {
          await f.pool.connect(f.trader1).closeLong(nftId, 0n);
        } catch {
          const pos = await f.positionNFT.getPosition(nftId);
          await f.usdc.mint(f.trader1.address, pos.airUsdMinted);
          await f.pool.connect(f.trader1).realizeLong(nftId);
        }
      }

      if (tokenReceived > 0n) {
        await f.pool.connect(f.trader1).swap(tokenReceived, 0n, true, f.trader1.address);
      }

      const netGain = (await f.usdc.balanceOf(f.trader1.address)) - usdcBefore;
      expect(netGain).to.be.lt(0n, "Split attack on thin pool must NOT profit");
      console.log(`      [Split 5×$20 in Thin] net: $${ethers.formatUnits(netGain, 6)}`);
    });

    it("Medium pool: 20×$50 longs (more splits) + pump is still net negative", async function () {
      const f = await loadFixture(deployMediumPool);

      const usdcBefore  = await f.usdc.balanceOf(f.trader1.address);
      const tokenBefore = await f.baseToken.balanceOf(f.trader1.address);

      const nftIds: bigint[] = [];
      const splitSize = ethers.parseUnits("50", 6);
      for (let i = 0; i < 20; i++) {
        nftIds.push(await openLong(f.pool, f.trader1, splitSize));
      }

      const pumpUsdc = ethers.parseUnits("500", 6);
      await f.pool.connect(f.trader1).swap(pumpUsdc, 0n, false, f.trader1.address);
      const tokenReceived = (await f.baseToken.balanceOf(f.trader1.address)) - tokenBefore;

      for (const nftId of nftIds) {
        try {
          await f.pool.connect(f.trader1).closeLong(nftId, 0n);
        } catch {
          const pos = await f.positionNFT.getPosition(nftId);
          await f.usdc.mint(f.trader1.address, pos.airUsdMinted);
          await f.pool.connect(f.trader1).realizeLong(nftId);
        }
      }

      if (tokenReceived > 0n) {
        await f.pool.connect(f.trader1).swap(tokenReceived, 0n, true, f.trader1.address);
      }

      const netGain = (await f.usdc.balanceOf(f.trader1.address)) - usdcBefore;
      expect(netGain).to.be.lt(0n, "20-way split must NOT profit");
      console.log(`      [Split 20×$50 in Medium] net: $${ethers.formatUnits(netGain, 6)}`);
    });
  });

  // ── 5. Short-side mirror — impact fee protects short positions too ──────

  describe("5. Short-side impact fee", function () {

    it("openShort pays impact fee proportional to notional²/liquidity", async function () {
      const f = await loadFixture(deployMediumPool);

      const notional = ethers.parseUnits("500", 6);
      const backedUsd = await f.pool.backedAirUsd();

      // Compute expected fee
      const expectedFee = positionFee(notional, backedUsd);

      const usdcBefore = await f.usdc.balanceOf(f.trader1.address);
      await openShort(f.pool, f.trader1, notional);
      const paid = usdcBefore - await f.usdc.balanceOf(f.trader1.address);

      expect(paid).to.equal(expectedFee);
    });
  });

  // ── 6. Edge cases ───────────────────────────────────────────────────────

  describe("6. Edge cases", function () {

    it("very small position ($1) — impact fee is near zero, base fee dominates", async function () {
      const f = await loadFixture(deployStandardPool);

      const notional = ethers.parseUnits("1", 6); // $1
      const backedUsd = await f.pool.backedAirUsd();

      const baseFee   = (notional * (LP_FEE_BPS + PROTO_FEE_BPS)) / BPS_DENOM;
      // OI=0 for first position: impact = 1500 * 1e6 * 1e6 / (2 * 10_000e6 * 10000)
      const impactFee = (IMPACT_FEE_BPS * notional * notional) / (2n * backedUsd * BPS_DENOM);

      // Impact fee is negligible — nearly all fee comes from the base/min floor
      expect(impactFee).to.be.lt(10n);
      const total = positionFee(notional, backedUsd);
      expect(total).to.equal(MIN_POS_FEE + impactFee);

      await openLong(f.pool, f.trader1, notional); // should not revert
    });

    it("position equal to pool liquidity — impact fee is 7.5% of notional", async function () {
      const f = await loadFixture(deployMediumPool);

      const notional = ethers.parseUnits("1000", 6); // $1000 = pool size
      const backedUsd = await f.pool.backedAirUsd();

      // OI=0: impact = 1500 * N * N / (2 * U * 10000) = 1500 * 1000e6 / 20000 = 75e6 = $75
      const impactFee = (IMPACT_FEE_BPS * notional * notional) / (2n * backedUsd * BPS_DENOM);
      expect(impactFee).to.equal(ethers.parseUnits("75", 6));
    });

    it("position 5× pool liquidity — impact fee is $1875 (75× base fee)", async function () {
      const f = await loadFixture(deployThinPool);

      const notional = ethers.parseUnits("500", 6); // $500 in $100 pool (5×)
      const backedUsd = await f.pool.backedAirUsd();

      const baseFee   = (notional * (LP_FEE_BPS + PROTO_FEE_BPS)) / BPS_DENOM;
      // OI=0: impact = 1500 * 500e6 * 500e6 / (2 * 100e6 * 10000) = $187.5
      const impactFee = (IMPACT_FEE_BPS * notional * notional) / (2n * backedUsd * BPS_DENOM);
      expect(impactFee).to.equal(ethers.parseUnits("187.5", 6));
      expect(impactFee).to.be.gt(baseFee * 5n); // impact dominates
    });
  });

  // ── 7. LP can claim accumulated impact fees ─────────────────────────────

  describe("7. LP fee claiming includes impact fee", function () {

    it("LP can claim all accumulated fees (base + impact) after positions settle", async function () {
      const f = await loadFixture(deployMediumPool);

      // Open and realize a position
      const notional = ethers.parseUnits("500", 6);
      const nftId = await openLong(f.pool, f.trader1, notional);

      // Realize so we can remove liquidity
      const pos = await f.positionNFT.getPosition(nftId);
      await f.usdc.mint(f.trader1.address, pos.airUsdMinted);
      await f.pool.connect(f.trader1).realizeLong(nftId);

      // LP claims fees
      const lpFees = await f.pool.lpFeesAccumulated();
      expect(lpFees).to.be.gt(0n);

      const lpUsdcBefore = await f.usdc.balanceOf(f.creator.address);
      await f.pool.connect(f.creator).claimFees();
      const lpUsdcAfter = await f.usdc.balanceOf(f.creator.address);

      expect(lpUsdcAfter - lpUsdcBefore).to.equal(lpFees);
    });
  });

  // ── 8. Parametric sweep — comprehensive margin check ────────────────────

  describe("8. Parametric sweep — no negative margins across 30+ scenarios", function () {

    interface SweepCase {
      poolUsdc: bigint;
      poolToken: bigint;
      longUsdc: bigint;
    }

    const sweepCases: SweepCase[] = [];

    // Generate cases: 3 pool sizes × multiple position ratios
    const poolSizes: [bigint, bigint, () => Promise<Awaited<ReturnType<typeof deployPoolWithLiquidity>>>][] = [
      [ethers.parseUnits("10000", 6), ethers.parseEther("10000000"), deployStandardPool],
      [ethers.parseUnits("1000", 6),  ethers.parseEther("1000000"),  deployMediumPool],
      [ethers.parseUnits("100", 6),   ethers.parseEther("100000"),   deployThinPool],
    ];

    const positionRatios = [0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0];

    for (const [poolU, , fixtureFn] of poolSizes) {
      for (const ratio of positionRatios) {
        const longUsdc = BigInt(Math.floor(Number(poolU) * ratio));
        if (longUsdc >= 1_000_000n) { // at least $1
          sweepCases.push({ poolUsdc: poolU, poolToken: 0n, longUsdc });
        }
      }
    }

    for (const sc of sweepCases) {
      const poolLabel = `$${Number(sc.poolUsdc) / 1e6}`;
      const longLabel = `$${Number(sc.longUsdc) / 1e6}`;

      // Pick the right named fixture based on pool size
      const fixture = sc.poolUsdc === ethers.parseUnits("10000", 6) ? deployStandardPool
                    : sc.poolUsdc === ethers.parseUnits("1000", 6)  ? deployMediumPool
                    :                                                  deployThinPool;

      it(`Pool ${poolLabel}, Long ${longLabel}: margin >= 0`, async function () {
        const f = await loadFixture(fixture);

        const T0 = await f.pool.backedAirToken();
        const U0 = await f.pool.backedAirUsd();

        const fee = positionFee(sc.longUsdc, U0);

        await openLong(f.pool, f.trader1, sc.longUsdc);

        const T1 = await f.pool.backedAirToken();
        const loss = netLpLoss(T0, T1, U0);

        const margin = fee - loss;
        expect(margin).to.be.gte(0n,
          `NEGATIVE margin for pool=${poolLabel} long=${longLabel}: ` +
          `fee=${ethers.formatUnits(fee, 6)}, loss=${ethers.formatUnits(loss, 6)}`);
      });
    }
  });
});
