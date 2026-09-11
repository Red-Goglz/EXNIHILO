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
// Constants (must match contract)
// ─────────────────────────────────────────────────────────────────────────────

const BPS_DENOM      = 10_000n;
const SWAP_FEE_BPS   = 100n;
const LP_FEE_BPS     = 400n;
const PROTO_FEE_BPS  = 100n;
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
    initialToken);
  // Position caps ramp 1 %→20 % over 24 h. These tests are not about
  // caps, so start past the ramp where size is not the constraint.
  await time.increase(24 * 3600);
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

      const notional = ethers.parseUnits("200", 6); // 20 % of the $1K pool — the cap
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

      const notional = ethers.parseUnits("200", 6); // 20 % of the $1K pool — the cap
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

    it("the position cap keeps the impact fee below the base fee", async function () {
      // impact > base needs N > 2U/3 (~67 % of depth): 1500·N²/(2·U·1e4) vs
      // N·500/1e4. The cap tops out at 20 %, so impact can never dominate —
      // a direct consequence of the automatic cap, worth pinning.
      const f = await loadFixture(deployThinPool);

      const atCap = ((await f.pool.backedAirUsd()) * 2000n) / BPS_DENOM;
      expect(await f.pool.effectiveLeverageCap()).to.equal(atCap);

      const backedUsd = await f.pool.backedAirUsd();
      const baseFee   = (atCap * (LP_FEE_BPS + PROTO_FEE_BPS)) / BPS_DENOM;
      const impactFee = (IMPACT_FEE_BPS * atCap * atCap) / (2n * backedUsd * BPS_DENOM);

      expect(impactFee).to.be.lt(baseFee);
      expect(impactFee).to.be.gt(0n);
    });

    it("impact fee goes entirely to LP (accrued for claim)", async function () {
      const f = await loadFixture(deployMediumPool);

      const notional = ethers.parseUnits("200", 6); // 20 % of the $1K pool — the cap
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

    // Sizes are expressed as a fraction of pool depth rather than in dollars:
    // the per-position cap ramps to 20 % of backedAirUsd, so anything above that
    // is unreachable by construction and the property is only meaningful across
    // the band that can actually be opened.
    const SIZE_FRACTIONS_BPS = [100n, 500n, 1000n, 1500n, 2000n]; // 1 % … 20 %

    const testCases: TestCase[] = [];
    for (const pool of [STANDARD_POOL, MEDIUM_POOL, THIN_POOL]) {
      for (const bps of SIZE_FRACTIONS_BPS) {
        testCases.push({
          label: `${pool.label}, ${Number(bps) / 100}% of depth`,
          pool,
          notional: (pool.usdc * bps) / 10_000n,
        });
      }
    }

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
        // Longs are capped at 20 % of depth; the pump leg is a swap and is not.
        label: "Medium pool, $200 long (cap), $500 pump",
        pool: MEDIUM_POOL,
        longNotional: ethers.parseUnits("200", 6),
        pumpUsdc:     ethers.parseUnits("500", 6),
      },
      {
        label: "Medium pool, $150 long, $1000 pump",
        pool: MEDIUM_POOL,
        longNotional: ethers.parseUnits("150", 6),
        pumpUsdc:     ethers.parseUnits("1000", 6),
      },
      {
        label: "Thin pool, $20 long (cap), $50 pump",
        pool: THIN_POOL,
        longNotional: ethers.parseUnits("20", 6),
        pumpUsdc:     ethers.parseUnits("50", 6),
      },
      {
        label: "Thin pool, $15 long, $100 pump",
        pool: THIN_POOL,
        longNotional: ethers.parseUnits("15", 6),
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
          // Position underwater — liquidate after expiry (attacker gets nothing).
          await time.increase(7 * 24 * 60 * 60 + 1);
          await f.pool.connect(f.trader1).closePositionAfterDeadline(nftId, 0n);
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
          `(closed=${closedOk ? "profit" : "expired"})`
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
          // Underwater — liquidate after expiry (attacker gets nothing).
          await time.increase(7 * 24 * 60 * 60 + 1);
          await f.pool.connect(f.trader1).closePositionAfterDeadline(nftId, 0n);
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
          // Underwater — liquidate after expiry (attacker gets nothing).
          await time.increase(7 * 24 * 60 * 60 + 1);
          await f.pool.connect(f.trader1).closePositionAfterDeadline(nftId, 0n);
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
          // Underwater — liquidate after expiry (attacker gets nothing).
          await time.increase(7 * 24 * 60 * 60 + 1);
          await f.pool.connect(f.trader1).closePositionAfterDeadline(nftId, 0n);
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

      const notional = ethers.parseUnits("200", 6); // 20 % of the $1K pool — the cap
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

    it("formula: position equal to pool liquidity would owe 7.5 % of notional", async function () {
      // Pure formula check — see above; not an openable size.
      const f = await loadFixture(deployMediumPool);

      const notional = ethers.parseUnits("1000", 6); // $1000 = pool size
      const backedUsd = await f.pool.backedAirUsd();

      // OI=0: impact = 1500 * N * N / (2 * U * 10000) = 1500 * 1000e6 / 20000 = 75e6 = $75
      const impactFee = (IMPACT_FEE_BPS * notional * notional) / (2n * backedUsd * BPS_DENOM);
      expect(impactFee).to.equal(ethers.parseUnits("75", 6));
    });

    it("formula: position 5× pool liquidity would owe $187.5 impact", async function () {
      // Pure formula check — no position is opened. A 5×-depth position is not
      // openable any more (the cap tops out at 20 %), but the curve's shape
      // above that range is still worth pinning.
      const f = await loadFixture(deployThinPool);

      const notional = ethers.parseUnits("500", 6); // 5× the $100 pool
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

    it("LP can claim all accumulated fees (base + impact)", async function () {
      const f = await loadFixture(deployMediumPool);

      // Open a position — fees accrue at open time.
      const notional = ethers.parseUnits("200", 6); // 20 % of the $1K pool — the cap
      await openLong(f.pool, f.trader1, notional);

      const accrued = await f.pool.lpFeesAccumulated();
      expect(accrued).to.be.gt(0n);

      const lpBefore = await f.usdc.balanceOf(f.creator.address);
      await f.pool.connect(f.creator).claimFees(f.creator.address);
      expect(await f.usdc.balanceOf(f.creator.address)).to.equal(lpBefore + accrued);
      expect(await f.pool.lpFeesAccumulated()).to.equal(0n);
      expect(await f.pool.lpFeesPaidTotal()).to.equal(accrued);
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

    // The per-position cap ramps to 20 % of backedAirUsd, so the sweep covers
    // the openable band rather than ratios the pool now rejects outright.
    const positionRatios = [0.01, 0.025, 0.05, 0.10, 0.15, 0.20];

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
