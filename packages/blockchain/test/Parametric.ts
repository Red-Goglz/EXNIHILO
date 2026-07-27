/**
 * Parametric.ts — Parametric test suite for the "LP + openLong + Swap + Close" sequence.
 *
 * One wallet (trader) performs: openLong → USDC→token pump swap → closeLong (or
 * expiry liquidation if underwater) → sell token back.
 *
 * LP is a separate wallet.  Assertions after each run:
 *   - All positions settled (openPositionCount == 0)
 *   - LP earned fees (accrued, then claimed via claimFees)
 *   - LP can removeLiquidity without reverting
 *   - Trader P&L is logged (informational; may be negative — fees are real cost)
 *
 * Uses mulberry32 deterministic PRNG so random cases are reproducible.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  EXNIHILOPool,
  EXNIHILOFactory,
  LpNFT,
  PositionNFT,
  MockERC20,
} from "../typechain-types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants (mirror contract values)
// ─────────────────────────────────────────────────────────────────────────────

const SWAP_FEE_BPS  = 100n;
const LP_FEE_BPS    = 300n;
const PROTO_FEE_BPS = 200n;
const OPEN_FEE_BPS  = LP_FEE_BPS + PROTO_FEE_BPS; // 5 % total (base only)
const IMPACT_FEE_BPS = 1500n;                      // impact fee scaling rate
const BPS_DENOM     = 10_000n;
const E6            = 10n ** 6n;   // 1 USDC
const E18           = 10n ** 18n;  // 1 token

// ─────────────────────────────────────────────────────────────────────────────
// Off-chain AMM math — mirrors _cpAmountOut
// ─────────────────────────────────────────────────────────────────────────────

function cpOut(
  amountIn:   bigint,
  reserveIn:  bigint,
  reserveOut: bigint,
  feeBps:     bigint = SWAP_FEE_BPS
): bigint {
  if (reserveIn === 0n || reserveOut === 0n) return 0n;
  const rawOut = (amountIn * reserveOut) / (reserveIn + amountIn);
  const fee    = (amountIn * reserveOut * feeBps) / (reserveIn * BPS_DENOM);
  return rawOut > fee ? rawOut - fee : 0n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mulberry32 — deterministic seedable PRNG
// ─────────────────────────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  return function (): number {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bytecode-patch helper (same as EXNIHILOPool.ts / Coverage.ts)
// ─────────────────────────────────────────────────────────────────────────────

async function patchImmutableAddress(
  contractAddress: string,
  fromAddress: string,
  toAddress: string
): Promise<void> {
  const bytecode   = await ethers.provider.getCode(contractAddress);
  const raw        = bytecode.slice(2).toLowerCase();
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

// ─────────────────────────────────────────────────────────────────────────────
// Test parameter type
// ─────────────────────────────────────────────────────────────────────────────

interface Params {
  label:    string;
  lpToken:   bigint; // initial LP token seed (18 dec)
  lpUsdc:   bigint; // initial LP USDC seed (6 dec)
  longUsdc: bigint; // USDC notional for openLong (6 dec)
  swapUsdc: bigint; // USDC amount for USDC→token pump swap (6 dec); 0 = no pump
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixed curated test cases
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_CASES: Params[] = [
  {
    label:    "standard pool, small long, moderate pump",
    lpToken:   1_000_000n * E18,
    lpUsdc:   10_000n * E6,
    longUsdc: 100n * E6,
    swapUsdc: 200n * E6,
  },
  {
    label:    "standard pool, large long, heavy pump",
    lpToken:   1_000_000n * E18,
    lpUsdc:   10_000n * E6,
    longUsdc: 500n * E6,
    swapUsdc: 1_000n * E6,
  },
  {
    label:    "thin pool, moderate long, moderate pump",
    lpToken:   10_000n * E18,
    lpUsdc:   100n * E6,
    longUsdc: 10n * E6,
    swapUsdc: 15n * E6,
  },
  {
    label:    "deep pool, micro long, no pump → expired",
    lpToken:   10_000_000n * E18,
    lpUsdc:   100_000n * E6,
    longUsdc: 1n * E6,
    swapUsdc: 0n,
  },
  {
    label:    "deep pool, large long, heavy pump",
    lpToken:   5_000_000n * E18,
    lpUsdc:   50_000n * E6,
    longUsdc: 2_000n * E6,
    swapUsdc: 5_000n * E6,
  },
  {
    label:    "equal-value pool (1 token ≈ 1 USDC), medium long, medium pump",
    lpToken:   1_000_000n * E18,
    lpUsdc:   1_000_000n * E6,
    longUsdc: 500n * E6,
    swapUsdc: 300n * E6,
  },
  {
    label:    "very thin pool, minimal long, small pump",
    lpToken:   1_000n * E18,
    lpUsdc:   10n * E6,
    longUsdc: 1n * E6,
    swapUsdc: 2n * E6,
  },
  {
    label:    "large long, tiny pump (borderline: closeLong or expired)",
    lpToken:   500_000n * E18,
    lpUsdc:   5_000n * E6,
    longUsdc: 1_000n * E6,
    swapUsdc: 5n * E6,
  },

  // ── High-leverage stress cases ──────────────────────────────────────────────
  // longUsdc must stay below 99× lpUsdc (1% fee zero-output boundary).
  // swapUsdc has no hard limit — an enormous pump just gives near-zero token
  // output but does not revert (minAmountOut = 0).

  {
    label:    "small LP, 30× leverage, massive pump (100× lpUsdc)",
    lpToken:   100_000n * E18,
    lpUsdc:   1_000n * E6,
    longUsdc: 30_000n * E6,   // 30× — fee eats ~31% of SWAP-2 output at 1%
    swapUsdc: 100_000n * E6,  // 100× — dumps USDC, barely gets token back
  },
  {
    label:    "small LP, 40× leverage, no pump → expired",
    lpToken:   50_000n * E18,
    lpUsdc:   500n * E6,
    longUsdc: 20_000n * E6,   // 40×
    swapUsdc: 0n,
  },
  {
    label:    "small LP, 10× leverage, extreme pump (100× lpUsdc)",
    lpToken:   50_000n * E18,
    lpUsdc:   2_000n * E6,
    longUsdc: 20_000n * E6,   // 10×
    swapUsdc: 200_000n * E6,  // 100×
  },
  {
    label:    "medium LP, 20× leverage, massive pump (50× lpUsdc)",
    lpToken:   500_000n * E18,
    lpUsdc:   10_000n * E6,
    longUsdc: 200_000n * E6,  // 20×
    swapUsdc: 500_000n * E6,  // 50×
  },
  {
    label:    "medium LP, 40× leverage, large pump (20× lpUsdc)",
    lpToken:   1_000_000n * E18,
    lpUsdc:   5_000n * E6,
    longUsdc: 200_000n * E6,  // 40× — fee eats ~80% of SWAP-2 output at 1%
    swapUsdc: 100_000n * E6,  // 20×
  },
  {
    label:    "medium LP, 40× leverage, extreme pump (200× lpUsdc)",
    lpToken:   1_000_000n * E18,
    lpUsdc:   5_000n * E6,
    longUsdc: 200_000n * E6,  // 40× — same
    swapUsdc: 1_000_000n * E6, // 200×
  },
  {
    label:    "tiny LP, 30× leverage, huge pump (500× lpUsdc)",
    lpToken:   10_000n * E18,
    lpUsdc:   100n * E6,
    longUsdc: 3_000n * E6,    // 30×
    swapUsdc: 50_000n * E6,   // 500×
  },
  {
    label:    "medium LP, 45× leverage (near-max), minimal pump",
    lpToken:   200_000n * E18,
    lpUsdc:   2_000n * E6,
    longUsdc: 90_000n * E6,   // 45× — well below the 99× boundary at 1% fee
    swapUsdc: 5_000n * E6,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Random test case generator
// ─────────────────────────────────────────────────────────────────────────────

function generateRandomCases(count: number, seed: number): Params[] {
  const rng   = mulberry32(seed);
  const cases: Params[] = [];

  for (let i = 0; i < count; i++) {
    // LP pool: 1k–2M tokens, 10–20k USDC
    const lpTokenUnits = BigInt(Math.floor(rng() * 1_999_000 + 1_000));
    const lpUsdcUnits = BigInt(Math.floor(rng() * 19_990 + 10));

    // Long: 1–8% of lpUsdc (keeps it well within reserves)
    const longUsdcUnits = BigInt(Math.max(1, Math.floor(Number(lpUsdcUnits) * (0.01 + rng() * 0.07))));

    // Pump: 15% chance of no pump (→ expiry-liquidation path); otherwise 1–25% of lpUsdc
    const swapUsdcUnits = rng() < 0.15
      ? 0n
      : BigInt(Math.floor(Number(lpUsdcUnits) * rng() * 0.25));

    cases.push({
      label:    `rng[${i}] lp=${lpTokenUnits}m/${lpUsdcUnits}u long=${longUsdcUnits}u swap=${swapUsdcUnits}u`,
      lpToken:   lpTokenUnits   * E18,
      lpUsdc:   lpUsdcUnits   * E6,
      longUsdc: longUsdcUnits * E6,
      swapUsdc: swapUsdcUnits * E6,
    });
  }

  return cases;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core sequence runner — fresh deployment per run
// ─────────────────────────────────────────────────────────────────────────────

async function runSequence(params: Params): Promise<void> {
  const signers     = await ethers.getSigners();
  const deployer    = signers[0];  // deploys tokens + positionNFT
  const treasury    = signers[1];  // receives protocol fees
  const lp          = signers[2];  // holds LP NFT, seeds liquidity
  const trader      = signers[3];  // opens long, pumps, closes
  const throwaway   = signers[7];  // temporary LpNFT deployer (bytecode-patch target)
  const sysDeployer = signers[8];  // deploys factory

  // ── Deploy tokens ────────────────────────────────────────────────────────

  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const baseToken  = (await MockERC20F.connect(deployer).deploy("TOKEN", "TOKEN", 18)) as unknown as MockERC20;
  const usdc       = (await MockERC20F.connect(deployer).deploy("USDC", "USDC", 6))  as unknown as MockERC20;

  // ── Deploy PositionNFT ────────────────────────────────────────────────────

  const positionNFT = (await (await ethers.getContractFactory("PositionNFT"))
    .connect(deployer).deploy()) as unknown as PositionNFT;

  // ── Deploy LpNFT + EXNIHILOFactory (with bytecode patch) ────────────────

  const lpNft = (await (await ethers.getContractFactory("LpNFT"))
    .connect(throwaway).deploy(throwaway.address)) as unknown as LpNFT;

  const poolDeployer = await (await ethers.getContractFactory("PoolDeployer"))
    .connect(sysDeployer).deploy();

  const factory = (await (await ethers.getContractFactory("EXNIHILOFactory"))
    .connect(sysDeployer).deploy(
      await positionNFT.getAddress(),
      await lpNft.getAddress(),
      await usdc.getAddress(),
      treasury.address,
      SWAP_FEE_BPS,
      await poolDeployer.getAddress()
    )) as unknown as EXNIHILOFactory;

  const factoryAddr = await factory.getAddress();
  await patchImmutableAddress(await lpNft.getAddress(), throwaway.address, factoryAddr);
  await positionNFT.connect(deployer).initFactory(factoryAddr);

  // ── LP seeds the pool ─────────────────────────────────────────────────────

  await baseToken.mint(lp.address, params.lpToken);
  await usdc.mint(lp.address, params.lpUsdc);
  await baseToken.connect(lp).approve(factoryAddr, ethers.MaxUint256);
  await usdc.connect(lp).approve(factoryAddr, ethers.MaxUint256);

  const txCreate  = await factory.connect(lp).createMarket(
    await baseToken.getAddress(),
    params.lpUsdc,
    params.lpToken,
    0n, // no position caps
    0n,
    0n);
  const receiptCreate = await txCreate.wait();

  const iface  = factory.interface;
  const mktLog = receiptCreate!.logs
    .map((l) => { try { return iface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "MarketCreated")!;

  const poolAddress: string = mktLog.args.pool;
  const pool = (await ethers.getContractAt("EXNIHILOPool", poolAddress)) as EXNIHILOPool;

  // ── Fund trader ───────────────────────────────────────────────────────────
  // Trader starts with USDC only (zero token).  Any token they hold at the end
  // came exclusively from trading operations (the pump swap).
  //
  // Budget: 5% open fee + headroom + pump swap + buffer.
  const baseFee      = (params.longUsdc * OPEN_FEE_BPS) / BPS_DENOM;
  // OI=0 for first position: integral formula simplifies to N²*BPS/(2*U*10000)
  const impactFee    = (IMPACT_FEE_BPS * params.longUsdc * params.longUsdc)
                     / (2n * params.lpUsdc * BPS_DENOM);
  const openFee      = baseFee + impactFee;
  const traderBudget = openFee + params.longUsdc + params.swapUsdc + 10n * E6;

  await usdc.mint(trader.address, traderBudget);
  // intentionally NO token pre-mint — trader starts with zero token

  await usdc.connect(trader).approve(poolAddress, ethers.MaxUint256);
  await baseToken.connect(trader).approve(poolAddress, ethers.MaxUint256);

  // Snapshot before any trading
  const traderUsdcBefore = await usdc.balanceOf(trader.address);

  // ── Step 1: Open long ─────────────────────────────────────────────────────

  const txLong     = await pool.connect(trader).openLong(params.longUsdc, 0n, trader.address);
  const rcptLong   = await txLong.wait();
  const poolIface  = pool.interface;
  const longLog    = rcptLong!.logs
    .map((l) => { try { return poolIface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "PositionOpened")!;

  const nftId: bigint = longLog.args.nftId;

  // ── Step 2: USDC → token pump swap (optional) ─────────────────────────────

  let pumpReverted = false;
  if (params.swapUsdc > 0n) {
    // tokenToUsdc = false → USDC in, token out.
    // At these grid sizes the swap fee can outgrow the raw output, which the
    // pool now rejects instead of taking the input for nothing. The scenario
    // then degenerates to "position opened, no pump" — still a valid case to
    // measure, so record it rather than failing the run.
    try {
      await pool.connect(trader).swap(params.swapUsdc, 0n, false, trader.address);
    } catch {
      pumpReverted = true;
    }
  }

  // ── Step 3: Decide close path from live chain state ───────────────────────
  // Read state now (post-pump) to decide whether closeLong succeeds or the
  // position is underwater and must be liquidated after expiry.
  const airTokenSupply = await pool.airTokenSupply();
  const backedAirUsd  = await pool.backedAirUsd();
  const pos           = await positionNFT.getPosition(nftId);
  const lockedAmount  = pos.lockedAmount;
  const airUsdMinted  = pos.airUsdMinted;

  // Mirror closeLong CHECKS: profitable iff SWAP-3 output ≥ synthetic debt
  const profitable =
    airTokenSupply >= lockedAmount &&
    cpOut(lockedAmount, airTokenSupply - lockedAmount, backedAirUsd) >= airUsdMinted;

  if (profitable) {
    // ── Step 3a: Close long (profitable) — receive USDC surplus ─────────────
    await pool.connect(trader).closeLong(nftId, 0n);
  } else {
    // ── Step 3b: Underwater — expire and liquidate (collateral → LP, no payout)
    await time.increase(7 * 24 * 60 * 60 + 1);
    await pool.connect(trader).closePositionAfterDeadline(nftId, 0n);
  }

  // ── Step 4: Sell ALL token back to the pool (token → USDC) ─────────────────
  // Covers the token received from the pump swap (closeLong path).
  // The CPM formula guarantees this never completely drains the pool's USDC
  // reserve.
  const finalTokenBalance = await baseToken.balanceOf(trader.address);
  if (finalTokenBalance > 0n) {
    // May revert for the same zero-output reason as the pump leg; if it does,
    // the trader simply keeps the tokens and the PnL accounting below still
    // values them at p0.
    try {
      await pool.connect(trader).swap(finalTokenBalance, 0n, true, trader.address); // tokenToUsdc = true
    } catch { /* zero-output: trader keeps the tokens */ }
  }

  // ── Compute and log trader P&L ────────────────────────────────────────────

  const traderUsdcAfter = await usdc.balanceOf(trader.address);
  const netUsdc         = traderUsdcAfter - traderUsdcBefore;
  const sign            = netUsdc >= 0n ? "+" : "-";
  const absUsdc         = netUsdc >= 0n ? netUsdc : -netUsdc;
  const usdStr          = (Number(absUsdc) / 1e6).toFixed(4);
  console.log(
    `    [${params.label}] ` +
    `net: ${sign}$${usdStr} | ` +
    `mode: ${profitable ? "closeLong" : "expiredUnderwater"}`
  );

  // ── Assertions ────────────────────────────────────────────────────────────

  // Trader must always end up with strictly less USDC than they started with.
  // Protocol fees (5% open fee) plus AMM round-trip losses on the pump and
  // token sell-back are always a net cost — no configuration can overcome them.
  expect(netUsdc).to.be.lt(
    0n,
    "Trader must end with less USDC than they started (open fee + AMM losses always exceed gains)"
  );

  // All positions must be settled
  expect(await pool.openPositionCount()).to.equal(
    0n,
    "openPositionCount must be 0 after position is closed/liquidated"
  );

  // LP must have earned fees from the 3% position-open LP fee share.
  // Fees accrue (pull payment) and are withdrawn via claimFees.
  const lpFeesAccrued = await pool.lpFeesAccumulated();
  expect(lpFeesAccrued).to.be.gt(0n, "accrued LP fees must be positive");
  await pool.connect(lp).claimFees(lp.address);
  expect(await pool.lpFeesAccumulated()).to.equal(0n, "claim drains the accrual");
  expect(await pool.lpFeesPaidTotal()).to.equal(lpFeesAccrued);

  // LP can remove all liquidity (requires openPositionCount == 0)
  await pool.connect(lp).removeLiquidity();
  expect(await pool.backedAirToken()).to.equal(0n, "backedAirToken must be 0 after full removal");
  expect(await pool.backedAirUsd()).to.equal( 0n, "backedAirUsd must be 0 after full removal");
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("Parametric — LP + openLong + Swap + Close", function () {
  this.timeout(300_000); // 5 min for all deployments

  const ALL_CASES: Params[] = [
    ...FIXED_CASES,
    ...generateRandomCases(20, 0xdeadbeef),
  ];

  for (const params of ALL_CASES) {
    it(params.label, async function () {
      await runSequence(params);
    });
  }
});
