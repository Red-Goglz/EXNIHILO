/**
 * Funding examples, measured on the real contracts.
 *
 *   npx hardhat run scripts/fundingExamples.ts
 *   SECTIONS=AD npx hardhat run scripts/fundingExamples.ts   # only some tables
 *
 * Deploys a $100k / 100k-token market (price $1) on the in-process Hardhat
 * network and prints:
 *
 *   A. How fast a position shrinks, by market age and by how crowded its side is
 *   B. What funding does to a winner's, a flat and a loser's payout over time
 *   C. How funding on a crowded side moves the three prices
 *   D. How fast an abandoned position decays once the LP closes the pool
 *   E. What a lone position pays, by the age of the market it opens on
 *
 * Nothing here is modelled: every figure is read back from the pool.
 */
import { ethers } from "hardhat";
import { time, mine, takeSnapshot } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const E6 = 10n ** 6n;
const E18 = 10n ** 18n;
const RAY = 10n ** 27n;

/* eslint-disable @typescript-eslint/no-explicit-any */

async function deploy() {
  const signers = await ethers.getSigners();
  const [, treasury, creator, trader, mover] = signers;
  const sysDeployer = signers[8];

  const MockF = await ethers.getContractFactory("MockERC20");
  const usdc: any = await MockF.deploy("USD Coin", "USDC", 6);
  const token: any = await MockF.deploy("Token", "TKN", 18);
  const positionNFT: any = await (await ethers.getContractFactory("PositionNFT")).deploy();
  const poolDeployer = await (await ethers.getContractFactory("PoolDeployer"))
    .connect(sysDeployer).deploy();
  const predictedFactory = ethers.getCreateAddress({
    from: sysDeployer.address, nonce: await sysDeployer.getNonce(),
  });
  const lpNft = await (await ethers.getContractFactory("LpNFT")).deploy(predictedFactory);
  const factory: any = await (await ethers.getContractFactory("EXNIHILOFactory"))
    .connect(sysDeployer).deploy(
      await positionNFT.getAddress(), await lpNft.getAddress(), await usdc.getAddress(),
      treasury.address, await poolDeployer.getAddress(),
    );
  await (await positionNFT.initFactory(await factory.getAddress())).wait();

  for (const s of [creator, trader, mover]) {
    await (await usdc.mint(s.address, 100_000_000n * E6)).wait();
    await (await token.mint(s.address, 100_000_000n * E18)).wait();
  }
  await (await usdc.connect(creator).approve(await factory.getAddress(), 100_000n * E6)).wait();
  await (await token.connect(creator).approve(await factory.getAddress(), 100_000n * E18)).wait();
  const rc = await (await factory.connect(creator)
    .createMarket(await token.getAddress(), 100_000n * E6, 100_000n * E18)).wait();

  let poolAddress = "";
  for (const log of rc.logs) {
    try {
      const p = factory.interface.parseLog(log);
      if (p?.name === "MarketCreated") poolAddress = p.args[0];
    } catch { /* not a factory log */ }
  }
  const pool: any = await ethers.getContractAt("EXNIHILOPool", poolAddress);
  for (const s of [trader, mover]) {
    await (await usdc.connect(s).approve(poolAddress, ethers.MaxUint256)).wait();
    await (await token.connect(s).approve(poolAddress, ethers.MaxUint256)).wait();
  }
  return { pool, positionNFT, creator, trader, mover };
}

async function open(pool: any, who: any, isLong: boolean, notional: bigint): Promise<bigint> {
  const tx = isLong
    ? await pool.connect(who).openLong(notional, 0n, who.address)
    : await pool.connect(who).openShort(notional, 0n, who.address);
  const rc = await tx.wait();
  for (const log of rc.logs) {
    try {
      const p = pool.interface.parseLog(log);
      if (p?.name === "PositionOpened") return p.args[0] as bigint;
    } catch { /* not a pool log */ }
  }
  throw new Error("PositionOpened not emitted");
}

const usd = (v: bigint) =>
  "$" + (Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const size = (bps: bigint) => `${(Number(bps) / 100).toFixed(1)}%`;
const perDay = (rateRay: bigint) =>
  `${(Number((rateRay * 86_400n * 1_000_000n) / RAY) / 10_000).toFixed(3)}%`;
const price = (p: bigint) => `$${(Number(p) / 1e6).toFixed(4)}`;
const delta = (now: bigint, then: bigint) => {
  const d = (Number(now) / Number(then) - 1) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(2)}%`;
};

async function at(t0: number, days: number) {
  await time.increaseTo(t0 + days * DAY);
  await mine();
}

async function main() {
  const { pool, positionNFT, creator, trader, mover } = await deploy();
  const base = await takeSnapshot();
  const sections = (process.env.SECTIONS ?? "ABCDE").toUpperCase();

  // ── A. How fast a position shrinks ─────────────────────────────────────────
  if (sections.includes("A")) {
    const checkpoints = [1, 7, 30, 90];
    const crowds = [
      { label: "1 position, $1,000", count: 1, notional: 1_000n },
      { label: "100 positions, $100 each", count: 100, notional: 100n },
      { label: "100 positions, $1,000 each", count: 100, notional: 1_000n },
      { label: "20 positions, $20,000 each", count: 20, notional: 20_000n },
    ];

    console.log("\n### A. Size left, by market age and crowding (long side, $100k pool)\n");
    for (const age of [1, 30]) {
      console.log(`Market ${age === 1 ? "1 day" : "30+ days"} old when the positions open:\n`);
      console.log(`| Long side | Open interest | Rate at open | ${checkpoints.map((d) => `After ${d}d`).join(" | ")} |`);
      console.log(`|---|---|---|${checkpoints.map(() => "---").join("|")}|`);
      for (const c of crowds) {
        await base.restore();
        await time.increase(age * DAY);
        const tracked = await open(pool, trader, true, c.notional * E6);
        for (let i = 1; i < c.count; i++) await open(pool, mover, true, c.notional * E6);
        const t0 = await time.latest();
        const oi = await pool.longOpenInterest();
        const rate = await pool.fundingRatePerSecond(true);
        const cells: string[] = [];
        for (const d of checkpoints) {
          await at(t0, d);
          cells.push(size(await pool.remainingSizeBps(tracked)));
        }
        console.log(`| ${c.label} | ${usd(oi).replace(/\.\d\d$/, "")} | ${perDay(rate)}/day | ${cells.join(" | ")} |`);
      }
      console.log("");
    }
  }

  // ── B. What funding does to a payout ──────────────────────────────────────
  if (sections.includes("B")) {
    const bDays = [0, 30, 90, 180];
    const moves = [
      { label: "Winner — price +50%", usdcIn: 22_474n * E6, tokenIn: 0n },
      { label: "Flat — price unchanged", usdcIn: 0n, tokenIn: 0n },
      { label: "Loser — price −30%", usdcIn: 0n, tokenIn: 19_523n * E18 },
    ];

    console.log("### B. A $1,000 long on a 30-day-old market, price held after the move\n");
    for (const m of moves) {
      await base.restore();
      await time.increase(30 * DAY);
      const id = await open(pool, trader, true, 1_000n * E6);
      const p0 = await pool.spotPrice();
      if (m.usdcIn > 0n) await (await pool.connect(mover).swap(m.usdcIn, 0n, false, mover.address)).wait();
      if (m.tokenIn > 0n) await (await pool.connect(mover).swap(m.tokenIn, 0n, true, mover.address)).wait();
      await mine(6);
      const t0 = await time.latest();
      const debtAtOpen = (await positionNFT.getPosition(id)).airUsdMinted as bigint;

      console.log(`**${m.label}** (spot ${price(p0)} → ${price(await pool.spotPrice())})\n`);
      const oldCol = m.usdcIn > 0n;
      console.log(`| Day | Size left | Debt | Payout if closed now |${oldCol ? " Old model (collateral only) |" : ""}`);
      console.log(`|---|---|---|---|${oldCol ? "---|" : ""}`);

      let collateralValueAtOpen = 0n;
      for (const d of bDays) {
        if (d > 0) await at(t0, d);
        const [ready, pnl] = await pool.quoteClose(id);
        const rem = await pool.remainingSizeBps(id);
        const [, debt] = await pool.liveAmountsOf(id);
        const payout = ready && pnl > 0n ? usd(pnl) : `can't close (short ${usd(pnl < 0n ? -pnl : 0n)})`;

        let oldCell = "";
        if (oldCol) {
          // The collateral-only model shrank the collateral by the same fraction
          // but left the debt at its opening size. Close value is linear in the
          // collateral, so its payout is reconstructed from today's quote.
          if (d === 0) collateralValueAtOpen = (pnl * 100n) / 99n + debt;
          const gross = (collateralValueAtOpen * rem) / 10_000n - debtAtOpen;
          oldCell = gross > 0n ? ` ${usd((gross * 99n) / 100n)} |` : ` can't close |`;
        }
        console.log(`| ${d} | ${size(rem)} | ${usd(debt)} | ${payout} |${oldCell}`);
      }
      console.log("");
    }
  }

  // ── C. How funding moves the curves ───────────────────────────────────────
  if (sections.includes("C")) {
    const cDays = [7, 30, 90];
    console.log("### C. Prices on a 30-day-old market with $50k open interest on one side\n");
    for (const isLong of [true, false]) {
      await base.restore();
      await time.increase(30 * DAY);
      // Five $10k positions rather than two at the cap: a short locks USDC out of
      // backedAirUsd, which the 20 % position cap is a share of, so the cap shrinks
      // with every short that opens.
      for (let i = 0; i < 5; i++) await open(pool, mover, isLong, 10_000n * E6);
      const t0 = await time.latest();
      const s0 = await pool.spotPrice();
      const l0 = await pool.longPrice();
      const sh0 = await pool.shortPrice();
      const oi0 = isLong ? await pool.longOpenInterest() : await pool.shortOpenInterest();

      console.log(`**Crowded ${isLong ? "longs" : "shorts"}** — at open: spot ${price(s0)}, long entry ${price(l0)}, short entry ${price(sh0)}\n`);
      console.log(`| Day | Open interest | spotPrice | longPrice | shortPrice |`);
      console.log(`|---|---|---|---|---|`);
      for (const d of cDays) {
        await time.increaseTo(t0 + d * DAY);
        await (await pool.pokeFunding()).wait();
        const oi = isLong ? await pool.longOpenInterest() : await pool.shortOpenInterest();
        console.log(`| ${d} | ${usd(oi).replace(/\.\d\d$/, "")} (${delta(oi, oi0)}) | ${delta(await pool.spotPrice(), s0)} | ${delta(await pool.longPrice(), l0)} | ${delta(await pool.shortPrice(), sh0)} |`);
      }
      console.log("");
    }
  }

  // ── D. Wind-down ──────────────────────────────────────────────────────────
  if (sections.includes("D")) {
    const dDays = [0, 5, 8, 10, 11, 12];
    console.log("### D. A lone $1,000 long after the LP closes the pool\n");
    console.log(`| Market age at close | ${dDays.map((d) => `closeDate + ${d}d`).join(" | ")} | Sweepable at |`);
    console.log(`|---|${dDays.map(() => "---").join("|")}|---|`);
    for (const age of [1, 30]) {
      await base.restore();
      await time.increase(age * DAY);
      const id = await open(pool, trader, true, 1_000n * E6);
      await (await pool.connect(creator).closePool()).wait();
      const closeDate = Number(await pool.closeDate());

      // Walk forward in three-hour steps, recording the checkpoints as they pass
      // and the first moment the position is strictly below the sweep threshold.
      const cells = new Map<number, string>();
      let sweepAt = "";
      for (let h = 0; h <= 30 * 24; h += 3) {
        await time.increaseTo(closeDate + h * 3600);
        await mine();
        const bps = await pool.remainingSizeBps(id);
        if (h % 24 === 0 && dDays.includes(h / 24)) cells.set(h / 24, size(bps));
        if (!sweepAt && bps < 10n) sweepAt = `closeDate + ${(h / 24).toFixed(1)}d`;
        if (sweepAt && cells.size === dDays.length) break;
      }
      console.log(`| ${age === 1 ? "1 day" : "30+ days"} | ${dDays.map((d) => cells.get(d) ?? "0.0%").join(" | ")} | ${sweepAt} |`);
    }
    console.log("");
  }

  // ── E. By market age ──────────────────────────────────────────────────────
  if (sections.includes("E")) {
    const ages = [
      { label: "1 hour", seconds: 3600 },
      { label: "8 hours", seconds: 8 * 3600 },
      { label: "1 day", seconds: DAY },
      { label: "1 week", seconds: 7 * DAY },
      { label: "30 days+", seconds: 30 * DAY },
    ];
    const eDays = [1, 7, 30];
    console.log("### E. A lone $500 long (utilization ~0), by market age at open\n");
    console.log(`| Market age | Rate at open | ${eDays.map((d) => `After ${d}d`).join(" | ")} |`);
    console.log(`|---|---|${eDays.map(() => "---").join("|")}|`);
    for (const a of ages) {
      await base.restore();
      await time.increase(a.seconds);
      const id = await open(pool, trader, true, 500n * E6);
      const t0 = await time.latest();
      const rate = await pool.fundingRatePerSecond(true);
      const cells: string[] = [];
      for (const d of eDays) {
        await at(t0, d);
        cells.push(size(await pool.remainingSizeBps(id)));
      }
      console.log(`| ${a.label} | ${perDay(rate)}/day | ${cells.join(" | ")} |`);
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
