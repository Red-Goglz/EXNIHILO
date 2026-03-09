/**
 * Parametric.ts — Parametric test suite for the "LP + openLong + Swap + Close" sequence.
 *
 * One wallet (trader) performs: openLong → USDC→meme pump swap → closeLong (or
 * realizeLong if underwater) → sell meme back.
 *
 * LP is a separate wallet.  Assertions after each run:
 *   - All positions settled (openPositionCount == 0)
 *   - LP earned fees (lpFeesAccumulated > 0)
 *   - LP can claimFees + removeLiquidity without reverting
 *   - Trader P&L is logged (informational; may be negative — fees are real cost)
 *
 * Uses mulberry32 deterministic PRNG so random cases are reproducible.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  EXNIHILOPool,
  EXNIHILOFactory,
  LpNFT,
  PositionNFT,
  MockERC20,
  AirToken,
} from "../typechain-types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants (mirror contract values)
// ─────────────────────────────────────────────────────────────────────────────

const SWAP_FEE_BPS  = 100n;
const LP_FEE_BPS    = 300n;
const PROTO_FEE_BPS = 200n;
const OPEN_FEE_BPS  = LP_FEE_BPS + PROTO_FEE_BPS; // 5 % total
const BPS_DENOM     = 10_000n;
const E6            = 10n ** 6n;   // 1 USDC
const E18           = 10n ** 18n;  // 1 meme token

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
  lpMeme:   bigint; // initial LP meme seed (18 dec)
  lpUsdc:   bigint; // initial LP USDC seed (6 dec)
  longUsdc: bigint; // USDC notional for openLong (6 dec)
  swapUsdc: bigint; // USDC amount for USDC→meme pump swap (6 dec); 0 = no pump
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixed curated test cases
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_CASES: Params[] = [
  {
    label:    "standard pool, small long, moderate pump",
    lpMeme:   1_000_000n * E18,
    lpUsdc:   10_000n * E6,
    longUsdc: 100n * E6,
    swapUsdc: 200n * E6,
  },
  {
    label:    "standard pool, large long, heavy pump",
    lpMeme:   1_000_000n * E18,
    lpUsdc:   10_000n * E6,
    longUsdc: 500n * E6,
    swapUsdc: 1_000n * E6,
  },
  {
    label:    "thin pool, moderate long, moderate pump",
    lpMeme:   10_000n * E18,
    lpUsdc:   100n * E6,
    longUsdc: 10n * E6,
    swapUsdc: 15n * E6,
  },
  {
    label:    "deep pool, micro long, no pump → realizeLong",
    lpMeme:   10_000_000n * E18,
    lpUsdc:   100_000n * E6,
    longUsdc: 1n * E6,
    swapUsdc: 0n,
  },
  {
    label:    "deep pool, large long, heavy pump",
    lpMeme:   5_000_000n * E18,
    lpUsdc:   50_000n * E6,
    longUsdc: 2_000n * E6,
    swapUsdc: 5_000n * E6,
  },
  {
    label:    "equal-value pool (1 meme ≈ 1 USDC), medium long, medium pump",
    lpMeme:   1_000_000n * E18,
    lpUsdc:   1_000_000n * E6,
    longUsdc: 500n * E6,
    swapUsdc: 300n * E6,
  },
  {
    label:    "very thin pool, minimal long, small pump",
    lpMeme:   1_000n * E18,
    lpUsdc:   10n * E6,
    longUsdc: 1n * E6,
    swapUsdc: 2n * E6,
  },
  {
    label:    "large long, tiny pump (borderline: closeLong or realizeLong)",
    lpMeme:   500_000n * E18,
    lpUsdc:   5_000n * E6,
    longUsdc: 1_000n * E6,
    swapUsdc: 5n * E6,
  },

  // ── High-leverage stress cases ──────────────────────────────────────────────
  // longUsdc must stay below 99× lpUsdc (1% fee zero-output boundary).
  // swapUsdc has no hard limit — an enormous pump just gives near-zero meme
  // output but does not revert (minAmountOut = 0).

  {
    label:    "small LP, 30× leverage, massive pump (100× lpUsdc)",
    lpMeme:   100_000n * E18,
    lpUsdc:   1_000n * E6,
    longUsdc: 30_000n * E6,   // 30× — fee eats ~31% of SWAP-2 output at 1%
    swapUsdc: 100_000n * E6,  // 100× — dumps USDC, barely gets meme back
  },
  {
    label:    "small LP, 40× leverage, no pump → realizeLong",
    lpMeme:   50_000n * E18,
    lpUsdc:   500n * E6,
    longUsdc: 20_000n * E6,   // 40×
    swapUsdc: 0n,
  },
  {
    label:    "small LP, 10× leverage, extreme pump (100× lpUsdc)",
    lpMeme:   50_000n * E18,
    lpUsdc:   2_000n * E6,
    longUsdc: 20_000n * E6,   // 10×
    swapUsdc: 200_000n * E6,  // 100×
  },
  {
    label:    "medium LP, 20× leverage, massive pump (50× lpUsdc)",
    lpMeme:   500_000n * E18,
    lpUsdc:   10_000n * E6,
    longUsdc: 200_000n * E6,  // 20×
    swapUsdc: 500_000n * E6,  // 50×
  },
  {
    label:    "medium LP, 40× leverage, large pump (20× lpUsdc)",
    lpMeme:   1_000_000n * E18,
    lpUsdc:   5_000n * E6,
    longUsdc: 200_000n * E6,  // 40× — fee eats ~80% of SWAP-2 output at 1%
    swapUsdc: 100_000n * E6,  // 20×
  },
  {
    label:    "medium LP, 40× leverage, extreme pump (200× lpUsdc)",
    lpMeme:   1_000_000n * E18,
    lpUsdc:   5_000n * E6,
    longUsdc: 200_000n * E6,  // 40× — same
    swapUsdc: 1_000_000n * E6, // 200×
  },
  {
    label:    "tiny LP, 30× leverage, huge pump (500× lpUsdc)",
    lpMeme:   10_000n * E18,
    lpUsdc:   100n * E6,
    longUsdc: 3_000n * E6,    // 30×
    swapUsdc: 50_000n * E6,   // 500×
  },
  {
    label:    "medium LP, 45× leverage (near-max), minimal pump",
    lpMeme:   200_000n * E18,
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
    // LP pool: 1k–2M meme tokens, 10–20k USDC
    const lpMemeUnits = BigInt(Math.floor(rng() * 1_999_000 + 1_000));
    const lpUsdcUnits = BigInt(Math.floor(rng() * 19_990 + 10));

    // Long: 1–8% of lpUsdc (keeps it well within reserves)
    const longUsdcUnits = BigInt(Math.max(1, Math.floor(Number(lpUsdcUnits) * (0.01 + rng() * 0.07))));

    // Pump: 15% chance of no pump (→ realizeLong path); otherwise 1–25% of lpUsdc
    const swapUsdcUnits = rng() < 0.15
      ? 0n
      : BigInt(Math.floor(Number(lpUsdcUnits) * rng() * 0.25));

    cases.push({
      label:    `rng[${i}] lp=${lpMemeUnits}m/${lpUsdcUnits}u long=${longUsdcUnits}u swap=${swapUsdcUnits}u`,
      lpMeme:   lpMemeUnits   * E18,
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
  const memeToken  = (await MockERC20F.connect(deployer).deploy("MEME", "MEME", 18)) as unknown as MockERC20;
  const usdc       = (await MockERC20F.connect(deployer).deploy("USDC", "USDC", 6))  as unknown as MockERC20;

  // ── Deploy PositionNFT ────────────────────────────────────────────────────

  const positionNFT = (await (await ethers.getContractFactory("PositionNFT"))
    .connect(deployer).deploy()) as unknown as PositionNFT;

  // ── Deploy LpNFT + EXNIHILOFactory (with bytecode patch) ────────────────

  const lpNft = (await (await ethers.getContractFactory("LpNFT"))
    .connect(throwaway).deploy(throwaway.address)) as unknown as LpNFT;

  const factory = (await (await ethers.getContractFactory("EXNIHILOFactory"))
    .connect(sysDeployer).deploy(
      await positionNFT.getAddress(),
      await lpNft.getAddress(),
      await usdc.getAddress(),
      treasury.address,
      SWAP_FEE_BPS
    )) as unknown as EXNIHILOFactory;

  const factoryAddr = await factory.getAddress();
  await patchImmutableAddress(await lpNft.getAddress(), throwaway.address, factoryAddr);

  // ── LP seeds the pool ─────────────────────────────────────────────────────

  await memeToken.mint(lp.address, params.lpMeme);
  await usdc.mint(lp.address, params.lpUsdc);
  await memeToken.connect(lp).approve(factoryAddr, ethers.MaxUint256);
  await usdc.connect(lp).approve(factoryAddr, ethers.MaxUint256);

  const txCreate  = await factory.connect(lp).createMarket(
    await memeToken.getAddress(),
    params.lpUsdc,
    params.lpMeme,
    0n, // no position caps
    0n
  );
  const receiptCreate = await txCreate.wait();

  const iface  = factory.interface;
  const mktLog = receiptCreate!.logs
    .map((l) => { try { return iface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "MarketCreated")!;

  const poolAddress: string = mktLog.args.pool;
  const pool = (await ethers.getContractAt("EXNIHILOPool", poolAddress)) as EXNIHILOPool;

  // ── Fund trader ───────────────────────────────────────────────────────────
  // Trader starts with USDC only (zero meme).  Any meme they hold at the end
  // came exclusively from trading operations (pump swap + realizeLong).
  //
  // Budget: 5% open fee + worst-case realizeLong notional + pump swap + buffer.
  const openFee      = (params.longUsdc * OPEN_FEE_BPS) / BPS_DENOM;
  const traderBudget = openFee + params.longUsdc + params.swapUsdc + 10n * E6;

  await usdc.mint(trader.address, traderBudget);
  // intentionally NO meme pre-mint — trader starts with zero meme

  await usdc.connect(trader).approve(poolAddress, ethers.MaxUint256);
  await memeToken.connect(trader).approve(poolAddress, ethers.MaxUint256);

  // Snapshot before any trading
  const traderUsdcBefore = await usdc.balanceOf(trader.address);

  // ── Step 1: Open long ─────────────────────────────────────────────────────

  const txLong     = await pool.connect(trader).openLong(params.longUsdc, 0n);
  const rcptLong   = await txLong.wait();
  const poolIface  = pool.interface;
  const longLog    = rcptLong!.logs
    .map((l) => { try { return poolIface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "LongOpened")!;

  const nftId: bigint = longLog.args.nftId;

  // ── Step 2: USDC → meme pump swap (optional) ─────────────────────────────

  if (params.swapUsdc > 0n) {
    // memeToUsdc = false → USDC in, meme out
    await pool.connect(trader).swap(params.swapUsdc, 0n, false);
  }

  // ── Step 3: Decide close path from live chain state ───────────────────────
  // Read state now (post-pump) to decide whether closeLong or realizeLong
  const airMemeAddr   = await pool.airMemeToken();
  const airMemeToken  = (await ethers.getContractAt("AirToken", airMemeAddr)) as AirToken;
  const airMemeSupply = await airMemeToken.totalSupply();
  const backedAirUsd  = await pool.backedAirUsd();
  const pos           = await positionNFT.getPosition(nftId);
  const lockedAmount  = pos.lockedAmount;
  const airUsdMinted  = pos.airUsdMinted;

  // Mirror closeLong CHECKS: profitable iff SWAP-3 output ≥ synthetic debt
  const profitable =
    airMemeSupply >= lockedAmount &&
    cpOut(lockedAmount, airMemeSupply - lockedAmount, backedAirUsd) >= airUsdMinted;

  if (profitable) {
    // ── Step 3a: Close long (profitable) — receive USDC surplus ─────────────
    await pool.connect(trader).closeLong(nftId, 0n);
  } else {
    // ── Step 3b: Realize long (at par) — pay airUsdMinted USDC, get raw meme ─
    // Budget always covers longUsdc (= airUsdMinted): see traderBudget above.
    await pool.connect(trader).realizeLong(nftId);
  }

  // ── Step 4: Sell ALL meme back to the pool (meme → USDC) ─────────────────
  // Covers: meme received from the pump swap (closeLong path) and/or the
  // meme delivered by realizeLong.  The CPM formula guarantees this never
  // completely drains the pool's USDC reserve.
  const finalMemeBalance = await memeToken.balanceOf(trader.address);
  if (finalMemeBalance > 0n) {
    await pool.connect(trader).swap(finalMemeBalance, 0n, true); // memeToUsdc = true
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
    `mode: ${profitable ? "closeLong" : "realizeLong"}`
  );

  // ── Assertions ────────────────────────────────────────────────────────────

  // Trader must always end up with strictly less USDC than they started with.
  // Protocol fees (5% open fee) plus AMM round-trip losses on the pump and
  // meme sell-back are always a net cost — no configuration can overcome them.
  expect(netUsdc).to.be.lt(
    0n,
    "Trader must end with less USDC than they started (open fee + AMM losses always exceed gains)"
  );

  // All positions must be settled
  expect(await pool.openPositionCount()).to.equal(
    0n,
    "openPositionCount must be 0 after position is closed/realized"
  );

  // LP must have earned fees from the 3% position-open LP fee share
  const lpFees = await pool.lpFeesAccumulated();
  expect(lpFees).to.be.gt(0n, "LP fees must be positive");

  // LP can claim all accumulated fees
  await pool.connect(lp).claimFees();
  expect(await pool.lpFeesAccumulated()).to.equal(0n, "lpFeesAccumulated must be 0 after claim");

  // LP can remove all liquidity (requires openPositionCount == 0)
  await pool.connect(lp).removeLiquidity();
  expect(await pool.backedAirMeme()).to.equal(0n, "backedAirMeme must be 0 after full removal");
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
