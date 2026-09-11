import { expect } from "chai";
import { ethers } from "hardhat";
import { time, mine } from "@nomicfoundation/hardhat-network-helpers";
import {
  EXNIHILOPool,
  EXNIHILOFactory,
  LpNFT,
  PositionNFT,
  MockERC20,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Manipulation-safety sweep.
 *
 * Question: does ANY combination of pool depth, price point, position size, or
 * price-move magnitude let a single actor extract value from the LP?
 *
 * Method: run the full single-actor round trip — open a leveraged position,
 * move the price with the actor's OWN capital, close — on a grid of pool
 * configurations, and measure the actor's portfolio delta marked at the
 * PRE-ATTACK fair price P0. Marking at P0 is the economically correct test: a
 * manipulation is transient, so whatever the attacker walks away with (USDC or
 * leftover tokens) must be valued at the fair rate that held before they
 * touched the pool. Leftover tokens are therefore NOT dumped (dumping just pays
 * slippage back to the pool and masks the extraction) — they are valued at P0.
 *
 * Result: no configuration is profitable. The OI-integral impact fee is
 * quadratic in position size and provably dominates both the manipulation
 * profit and the round-trip slippage, on both sides. This suite locks that
 * property in so a future fee/curve change that breaks it fails loudly.
 *
 * NOTE on scope: this proves single-actor manipulation is unprofitable. It does
 * NOT (and cannot) remove the LP's inherent directional exposure — an actor who
 * profits from a genuine third party's order flow is winning a directional bet,
 * i.e. the LP acting as the house. That is documented, not fixed, below.
 */

const SETTLE_GUARD_BLOCKS = 5;
const SWAP_FEE_BPS = 100n;

async function patchImmutableAddress(addr: string, from: string, to: string) {
  const bytecode = await ethers.provider.getCode(addr);
  const raw = bytecode.slice(2).toLowerCase();
  const fromPadded = "000000000000000000000000" + from.toLowerCase().slice(2);
  const toPadded = "000000000000000000000000" + to.toLowerCase().slice(2);
  const patched = raw.split(fromPadded).join(toPadded);
  await ethers.provider.send("hardhat_setCode", [addr, "0x" + patched]);
}

async function deployPool(initialUsdc: bigint, initialToken: bigint, maxBps: bigint) {
  const signers = await ethers.getSigners();
  const [deployer, treasury, creator, attacker] = signers;
  const throwaway = signers[7];
  const sysDeployer = signers[8];

  const MockF = await ethers.getContractFactory("MockERC20");
  const baseToken = (await MockF.connect(deployer).deploy("TOKEN", "TKN", 18)) as unknown as MockERC20;
  const usdc = (await MockF.connect(deployer).deploy("USD Coin", "USDC", 6)) as unknown as MockERC20;
  const positionNFT = (await (await ethers.getContractFactory("PositionNFT")).connect(deployer).deploy()) as unknown as PositionNFT;

  const lpNft = (await (await ethers.getContractFactory("LpNFT")).connect(throwaway).deploy(throwaway.address)) as unknown as LpNFT;
  const poolDeployer = await (await ethers.getContractFactory("PoolDeployer")).connect(sysDeployer).deploy();
  const factory = (await (await ethers.getContractFactory("EXNIHILOFactory")).connect(sysDeployer).deploy(
    await positionNFT.getAddress(), await lpNft.getAddress(), await usdc.getAddress(),
    treasury.address, await poolDeployer.getAddress(),
  )) as unknown as EXNIHILOFactory;
  const factoryAddr = await factory.getAddress();
  await patchImmutableAddress(await lpNft.getAddress(), throwaway.address, factoryAddr);
  await positionNFT.connect(deployer).initFactory(factoryAddr);

  await baseToken.mint(creator.address, initialToken);
  await usdc.mint(creator.address, initialUsdc);
  await baseToken.connect(creator).approve(factoryAddr, ethers.MaxUint256);
  await usdc.connect(creator).approve(factoryAddr, ethers.MaxUint256);

  const tx = await factory.connect(creator).createMarket(
    await baseToken.getAddress(), initialUsdc, initialToken);
  // Position caps ramp 1 %→20 % over 24 h. These tests are not about
  // caps, so start past the ramp where size is not the constraint.
  await time.increase(24 * 3600);
  const receipt = await tx.wait();
  const log = receipt!.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "MarketCreated")!;
  const pool = (await ethers.getContractAt("EXNIHILOPool", log.args.pool as string)) as EXNIHILOPool;
  const poolAddr = await pool.getAddress();

  // War chest large enough for any move in the grid.
  await usdc.mint(attacker.address, initialUsdc * 10_000n);
  await baseToken.mint(attacker.address, initialToken * 10_000n);
  await usdc.connect(attacker).approve(poolAddr, ethers.MaxUint256);
  await baseToken.connect(attacker).approve(poolAddr, ethers.MaxUint256);

  return { pool, poolAddr, usdc, baseToken, attacker, creator };
}

async function openSide(
  pool: EXNIHILOPool, t: HardhatEthersSigner, isLong: boolean, amt: bigint,
): Promise<bigint | null> {
  try {
    const tx = isLong
      ? await pool.connect(t).openLong(amt, 0n, t.address)
      : await pool.connect(t).openShort(amt, 0n, t.address);
    const r = await tx.wait();
    const log = r!.logs.map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
      .find((l) => l?.name === "PositionOpened")!;
    return log.args.nftId as bigint;
  } catch {
    return null;
  }
}

/** Portfolio value = USDC + tokens marked at the pre-attack fair price P0. */
async function portfolioAtP0(
  usdc: MockERC20, baseToken: MockERC20, who: string, p0Num: bigint, p0Den: bigint,
): Promise<bigint> {
  const u = await usdc.balanceOf(who);
  const t = await baseToken.balanceOf(who);
  return u + (t * p0Num) / p0Den; // p0Num/p0Den = USDC(6dec) per 1e18 token
}

/**
 * Single-actor round trip: open → move price in your favour with your own
 * capital → close. Returns the actor's portfolio delta at P0. Positive = drain.
 *   Long:  open long  → pump (USDC→token) → close long
 *   Short: open short → dump (token→USDC) → close short
 */
async function runManipulation(
  initialUsdc: bigint,
  initialToken: bigint,
  isLong: boolean,
  notional: bigint,
  moveSize: bigint,
  maxBps: bigint,
): Promise<{ net: bigint; opened: boolean; note: string }> {
  const { pool, usdc, baseToken, attacker } = await deployPool(initialUsdc, initialToken, maxBps);
  const p0Num = initialUsdc, p0Den = initialToken;

  const before = await portfolioAtP0(usdc, baseToken, attacker.address, p0Num, p0Den);

  const nftId = await openSide(pool, attacker, isLong, notional);
  if (nftId === null) return { net: 0n, opened: false, note: "open reverted (cap/guard)" };

  // The pump/dump leg. A move this large can exceed the point where the swap
  // fee outgrows the raw output, which the pool now rejects outright rather
  // than taking the input for nothing. That is a strictly stronger outcome than
  // "executed but unprofitable" — the manipulation cannot even be performed —
  // so it is not a drain. Mirrors how openSide and the close leg treat reverts.
  try {
    if (isLong) await pool.connect(attacker).swap(moveSize, 0n, false, attacker.address); // price up
    else        await pool.connect(attacker).swap(moveSize, 0n, true, attacker.address);  // price down
  } catch {
    return { net: 0n, opened: true, note: "pump reverted (swap output would be zero)" };
  }

  let note = isLong ? "closeLong" : "closeShort";
  try {
    if (isLong) await pool.connect(attacker).closeLong(nftId, 0n);
    else        await pool.connect(attacker).closeShort(nftId, 0n);
  } catch {
    await time.increase(7 * 24 * 60 * 60 + 1);
    await pool.connect(attacker).closePositionAfterDeadline(nftId, 0n);
    note = "expired-underwater";
  }

  const after = await portfolioAtP0(usdc, baseToken, attacker.address, p0Num, p0Den);
  return { net: after - before, opened: true, note };
}

describe("Manipulation safety — no parameter lets a single actor drain the LP", function () {
  this.timeout(600_000);

  // Vary BOTH USDC depth and token count (price point): SWAP-2/3 price against
  // token COUNT, so few-token/high-price pools behave very differently from
  // many-token/low-price pools of the same USDC depth.
  const POOLS = [
    { label: "Thin $100 P=$0.001", usdc: ethers.parseUnits("100", 6),   token: ethers.parseEther("100000") },
    { label: "Thin $100 P=$1",     usdc: ethers.parseUnits("100", 6),   token: ethers.parseEther("100") },
    { label: "Thin $100 P=$100",   usdc: ethers.parseUnits("100", 6),   token: ethers.parseEther("1") },
    { label: "$1K P=$0.001",       usdc: ethers.parseUnits("1000", 6),  token: ethers.parseEther("1000000") },
    { label: "$1K P=$1",           usdc: ethers.parseUnits("1000", 6),  token: ethers.parseEther("1000") },
    { label: "$1K P=$1000",        usdc: ethers.parseUnits("1000", 6),  token: ethers.parseEther("1") },
    { label: "$10K P=$0.001",      usdc: ethers.parseUnits("10000", 6), token: ethers.parseEther("10000000") },
    { label: "$10K P=$1",          usdc: ethers.parseUnits("10000", 6), token: ethers.parseEther("10000") },
  ];
  const NOTIONAL_FRACS = [50n, 100n, 200n, 400n, 800n, 2000n, 5000n, 9000n]; // 0.5%..90% of pool USDC
  const MOVE_MULTS = [1n, 2n, 5n, 10n, 25n, 50n, 100n];                      // ×pool depth

  async function sweep(isLong: boolean): Promise<{ net: bigint; line: string }[]> {
    const drains: { net: bigint; line: string }[] = [];
    for (const p of POOLS) {
      for (const nf of NOTIONAL_FRACS) {
        const notional = (p.usdc * nf) / 10_000n;
        for (const mm of MOVE_MULTS) {
          const moveSize = isLong ? p.usdc * mm : p.token * mm;
          const { net, opened, note } = await runManipulation(p.usdc, p.token, isLong, notional, moveSize, 0n);
          if (opened && net > 0n) {
            drains.push({
              net,
              line: `${p.label} | ${isLong ? "long" : "short"}=$${ethers.formatUnits(notional, 6)} ` +
                `move=${mm}× → +$${ethers.formatUnits(net, 6)} (${note})`,
            });
          }
        }
      }
    }
    return drains;
  }

  it("long-side pump-and-dump is never profitable across the grid", async function () {
    const drains = await sweep(true);
    if (drains.length > 0) {
      console.log(`\n      ⚠️  ${drains.length} PROFITABLE LONG DRAINS (impact fee failed):`);
      drains.sort((a, b) => (b.net > a.net ? 1 : -1)).forEach((d) => console.log(`        ${d.line}`));
    } else {
      console.log("\n      ✅ long side: no drain across the full grid (impact fee holds)\n");
    }
    expect(drains.length, "long-side drain found").to.equal(0);
  });

  it("short-side dump-and-pump is never profitable across the grid", async function () {
    const drains = await sweep(false);
    if (drains.length > 0) {
      console.log(`\n      ⚠️  ${drains.length} PROFITABLE SHORT DRAINS (impact fee failed):`);
      drains.sort((a, b) => (b.net > a.net ? 1 : -1)).forEach((d) => console.log(`        ${d.line}`));
    } else {
      console.log("\n      ✅ short side: no drain across the full grid (impact fee holds)\n");
    }
    expect(drains.length, "short-side drain found").to.equal(0);
  });

  it("every position size on the worst-case thin pool nets ≤ 0", async function () {
    // Walk the position from tiny to pool-sized on the worst-case thin pool.
    // Every size nets ≤ 0 — the OI-integral impact fee IS the economic cap, so
    // no explicit position cap is needed to prevent a manipulation drain.
    // (P&L is non-monotonic: at tiny positions the pump's own slippage dominates
    // the loss; as the position grows the quadratic impact fee dominates. Both
    // regimes stay negative.)
    const usdc = ethers.parseUnits("1000", 6);
    const token = ethers.parseEther("1000"); // P=$1, worst case
    const move = ethers.parseUnits("5000", 6); // 5× pool pump

    for (const frac of [100n, 500n, 1000n, 3000n, 6000n, 9000n]) {
      const notional = (usdc * frac) / 10_000n;
      const { net, opened } = await runManipulation(usdc, token, true, notional, move, 0n);
      if (!opened) continue;
      console.log(`      long=$${ethers.formatUnits(notional, 6)} → $${ethers.formatUnits(net, 6)}`);
      expect(net).to.be.lte(0n, `position $${ethers.formatUnits(notional, 6)} was profitable`);
    }
  });
});

describe("Inherent LP exposure — documented, not a manipulation", function () {
  this.timeout(120_000);

  it("an actor profits from a THIRD PARTY's order flow (the LP is the house)", async function () {
    // A separate buyer pushes the price up with their OWN $500 and KEEPS the
    // tokens (genuine demand). The attacker holds a small long and closes into
    // the move. The attacker profits — but this is directional risk, not
    // manipulation: the attacker paid nothing to move the price; the buyer did,
    // and the buyer now holds tokens they bid up. A single actor playing BOTH
    // roles nets ≤ 0 (proven in the sweep above). Caps do NOT prevent this — the
    // profitable position here is small (the impact fee already bars large ones)
    // — so this residual is inherent to any AMM-priced leverage product and must
    // be surfaced to LPs, not "fixed".
    const initialUsdc = ethers.parseUnits("1000", 6);
    const initialToken = ethers.parseEther("1000"); // P0 = $1
    const { pool, usdc, baseToken, attacker } = await deployPool(initialUsdc, initialToken, 0n);
    const [, , , , buyer] = await ethers.getSigners();
    await usdc.mint(buyer.address, ethers.parseUnits("100000", 6));
    await usdc.connect(buyer).approve(await pool.getAddress(), ethers.MaxUint256);

    const p0Num = initialUsdc, p0Den = initialToken;
    const before = await portfolioAtP0(usdc, baseToken, attacker.address, p0Num, p0Den);

    const nftId = await openSide(pool, attacker, true, ethers.parseUnits("100", 6)); // 10% of pool
    if (nftId === null) throw new Error("open unexpectedly reverted");

    await pool.connect(buyer).swap(ethers.parseUnits("500", 6), 0n, false, buyer.address); // third party
    // Let the third party's move age out of the settlement clamp window, so
    // what is measured is the inherent exposure to their order flow rather
    // than the clamp refusing to price a move made one block ago (H-2).
    await mine(SETTLE_GUARD_BLOCKS);
    await pool.connect(attacker).closeLong(nftId, 0n);

    const after = await portfolioAtP0(usdc, baseToken, attacker.address, p0Num, p0Den);
    const gain = after - before;
    console.log(`      attacker directional gain from third-party flow: $${ethers.formatUnits(gain, 6)}`);
    // The point of this test is documentary: the gain is positive and comes from
    // directional exposure, which the protocol intentionally offers (LP = house).
    expect(gain).to.be.gt(0n);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// H-2 — sandwiching your OWN close
//
// Every sweep above measures open -> manipulate -> close from a baseline taken
// BEFORE the position is opened (`before` at the top of runManipulation, ahead
// of openSide). So the 5 % base fee and the quadratic OI-integral impact fee are
// both counted as costs of the attack — and they are what makes it lose. The
// grid's own conclusion says so: "the OI-integral impact fee IS the economic
// cap".
//
// But those are ENTRY costs. They deter opening a position in order to
// manipulate. They say nothing about a holder who already has one, opened for
// ordinary reasons, and who is now choosing how to exit. For them the impact fee
// is sunk, and the only marginal cost is the swap round trip.
//
// This measures exactly that: identical pool, identical position, plain exit vs
// sandwiched exit. Nothing here is an "attack setup" — it is the question every
// position holder faces on the way out.
// ═════════════════════════════════════════════════════════════════════════════

describe("Manipulation: sandwiching your own close (H-2)", function () {
  this.timeout(120_000);

  /** Open a long, then exit. `pump` = 0 exits plainly; otherwise sandwich it. */
  async function exitWithPump(
    poolUsdc: bigint, poolToken: bigint, notional: bigint, pump: bigint, drift: bigint,
    holdBlocks = 0,
  ): Promise<bigint> {
    const { pool, poolAddr, usdc, baseToken, attacker } = await deployPool(poolUsdc, poolToken, 0n);

    // Measure the WHOLE lifecycle, from before the position exists. A long's
    // notional is not returned at close — only the surplus is — so the entry
    // premium and its 5 % + impact fees are real costs of holding, and they
    // belong in the total.
    const usdcStart  = await usdc.balanceOf(attacker.address);
    const tokenStart = await baseToken.balanceOf(attacker.address);

    const nftId = await openSide(pool, attacker, true, notional);
    if (nftId === null) throw new Error("open reverted");
    const openCost = usdcStart - (await usdc.balanceOf(attacker.address));

    // Ordinary market movement in the holder's favour, by an unrelated party.
    // Without it the position is underwater on its own entry fees and cannot be
    // closed at all — so the plain-exit baseline would not exist. This is the
    // realistic setting for H-2: a holder sitting on a profit, choosing an exit.
    const mover = (await ethers.getSigners())[5];
    await usdc.mint(mover.address, drift);
    await usdc.connect(mover).approve(poolAddr, ethers.MaxUint256);
    await pool.connect(mover).swap(drift, 0n, false, mover.address);

    // The drift is the position's legitimate profit, so it has to sit OUTSIDE
    // the settlement clamp window or no plain exit exists to compare against.
    // The attacker's pump below stays INSIDE it — one block before the close,
    // which is precisely the cross-block variant this test exists for.
    await mine(SETTLE_GUARD_BLOCKS);

    // Also keep the holder's decision point, for the marginal comparison.
    const usdc0  = await usdc.balanceOf(attacker.address);
    const token0 = await baseToken.balanceOf(attacker.address);

    if (pump > 0n) {
      await pool.connect(attacker).swap(pump, 0n, false, attacker.address); // USDC -> token
      // holdBlocks > 0 walks the pump out of the clamp window instead of
      // closing straight after it — the only shape in which the displaced mark
      // is reachable at all, bought with that many blocks of arbitrage exposure.
      if (holdBlocks > 0) await mine(holdBlocks);
    }

    const beforeClose = await usdc.balanceOf(attacker.address);
    const protoBefore = await pool.protocolFeesAccumulated();
    await pool.connect(attacker).closeLong(nftId, 0n);
    const payout   = (await usdc.balanceOf(attacker.address)) - beforeClose;
    // Exact close fee, read off the protocol accumulator rather than derived.
    const closeFee = (await pool.protocolFeesAccumulated()) - protoBefore;

    // Unwind fully. This is the leg that has to be paid for: closing the long
    // returned its token collateral to backedAirToken and took `payout` out of
    // backedAirUsd, so the back-swap sells into a reserve that is deeper in
    // token and thinner in USDC than the one the pump bought from. It is a real
    // loss, and it is measured here rather than assumed away.
    let unwind = 0n;
    if (pump > 0n) {
      const gained = (await baseToken.balanceOf(attacker.address)) - token0;
      if (gained > 0n) {
        const beforeUnwind = await usdc.balanceOf(attacker.address);
        await pool.connect(attacker).swap(gained, 0n, true, attacker.address); // token -> USDC
        unwind = (await usdc.balanceOf(attacker.address)) - beforeUnwind;
      }
    }

    // No token left over, so the net below is pure USDC in / USDC out.
    expect(await baseToken.balanceOf(attacker.address)).to.equal(tokenStart);
    const net   = (await usdc.balanceOf(attacker.address)) - usdc0;
    const total = (await usdc.balanceOf(attacker.address)) - usdcStart;

    if (process.env.H2_DIAG) {
      console.log(
        `        [h2] drift=$${ethers.formatUnits(drift, 6)}` +
        ` pump=$${ethers.formatUnits(pump, 6)}` +
        ` | openCost=-$${ethers.formatUnits(openCost, 6)}` +
        ` gross=+$${ethers.formatUnits(payout + closeFee, 6)}` +
        ` closeFee=-$${ethers.formatUnits(closeFee, 6)}` +
        ` payout=+$${ethers.formatUnits(payout, 6)}` +
        ` pumpOut=-$${ethers.formatUnits(pump, 6)}` +
        ` unwindIn=+$${ethers.formatUnits(unwind, 6)}` +
        ` | exitOnly=$${ethers.formatUnits(net, 6)}` +
        ` TOTAL=$${ethers.formatUnits(total, 6)}`
      );
    }
    return net;
  }

  // The CROSS-BLOCK sandwich: pump in block N, close in N+1, unwind in N+2,
  // Hardhat automining one block per transaction.
  //
  // This was skipped for one round. The first H-2 fix clamped a payout to the
  // reserves the CURRENT block opened with, and by N+1 those already include
  // the pump — so the clamp was a no-op here and this failed by $265 to $2,034
  // across the grid, while the same-block variant below passed. The clamp now
  // reaches over every open inside SETTLE_GUARD_BLOCKS, so the pre-pump open is
  // still on record when the close lands and the manufactured mark is not
  // reachable from either side of the block boundary.
  //
  // What the grid asserts is the marginal question, not the absolute one:
  // whether adding a pump to an exit the holder was going to make anyway pays
  // for itself. Both lifecycles have to be profitable for a win to count —
  // an attacker does not care about beating a loss with a smaller loss.
  it("a sandwiched exit never beats a plain exit", async function () {
    const poolUsdc  = ethers.parseUnits("100000", 6);
    const poolToken = ethers.parseEther("100000");
    const notional  = ethers.parseUnits("15000", 6); // 15 % of depth, inside the 20 % cap

    const wins: string[] = [];
    // Sweep the favourable move as well as the pump. The question is not only
    // whether sandwiching beats a plain exit, but whether a holder would ever
    // be sitting on this position at all — i.e. whether the plain lifecycle is
    // itself profitable. Both have to be true for the finding to bite.
    for (const dm of [40_000n, 120_000n, 300_000n]) {
      const drift = ethers.parseUnits(dm.toString(), 6);
      const plain = await exitWithPump(poolUsdc, poolToken, notional, 0n, drift);

      for (const mult of [1n, 2n, 5n, 10n, 25n]) {
        const pump = (poolUsdc * mult) / 10n;
        const sandwiched = await exitWithPump(poolUsdc, poolToken, notional, pump, drift);
        const edge = sandwiched - plain;
        if (edge > 0n && sandwiched > 0n && plain > 0n) {
          wins.push(
            `drift=$${ethers.formatUnits(drift, 6)} pump=$${ethers.formatUnits(pump, 6)} ` +
            `-> +$${ethers.formatUnits(edge, 6)} edge, both lifecycles positive ` +
            `(plain $${ethers.formatUnits(plain, 6)}, sandwiched $${ethers.formatUnits(sandwiched, 6)})`
          );
        }
      }
    }

    if (wins.length > 0) {
      console.log(`\n      H-2: ${wins.length} profitable sandwich(es):`);
      wins.forEach((w) => console.log(`        ${w}`));
    } else {
      console.log("\n      H-2: no sandwich beat a plain exit\n");
    }
    expect(wins.length, "sandwiching your own close pays").to.equal(0);
  });

  // What the window does and does not buy, measured rather than assumed.
  //
  // The clamp makes the displaced mark unreachable for SETTLE_GUARD_BLOCKS. It
  // does not make it unreachable: an attacker who makes the move and then WAITS
  // the window out closes at the mark like anyone else. That is the assumption
  // SETTLE_GUARD_BLOCKS has always rested on for third-party settlement, now
  // carrying the holder too — a price that has to survive open arbitrage for
  // the whole window is not a manufactured one any more.
  //
  // So the guarantee under test is exactly this: the edge is ZERO for every
  // hold strictly inside the window, and only the full window reaches it. The
  // residual beyond it is printed, not asserted to zero, because it is real.
  //
  // Read the printed figure as an UPPER BOUND. Nothing in this harness arbitrages
  // the displaced price during the hold, so it measures the case where the
  // attacker keeps the whole move for free across every block of the window.
  it("gives no edge anywhere inside the window, and needs the whole window to get any", async function () {
    const poolUsdc  = ethers.parseUnits("100000", 6);
    const poolToken = ethers.parseEther("100000");
    const notional  = ethers.parseUnits("15000", 6);
    const drift     = ethers.parseUnits("120000", 6);

    const plain = await exitWithPump(poolUsdc, poolToken, notional, 0n, drift);

    for (const mult of [2n, 5n, 10n]) {
      const pump = (poolUsdc * mult) / 10n;

      // Strictly inside: the payout is clamped to the pre-pump mark, so the
      // pump buys nothing and its own swap fee plus the unwind slippage are
      // pure loss. Net must come out BELOW a plain exit, every time.
      for (let hold = 0; hold < SETTLE_GUARD_BLOCKS - 1; hold++) {
        const inside = await exitWithPump(poolUsdc, poolToken, notional, pump, drift, hold);
        expect(inside, `pump $${ethers.formatUnits(pump, 6)} held ${hold} block(s)`)
          .to.be.lt(plain);
      }

      // The full window. Reported, deliberately not asserted to zero.
      const held = await exitWithPump(
        poolUsdc, poolToken, notional, pump, drift, SETTLE_GUARD_BLOCKS,
      );
      const edge = held - plain;
      console.log(
        `        [window] pump=$${ethers.formatUnits(pump, 6)} ` +
        `held ${SETTLE_GUARD_BLOCKS} blocks -> ` +
        `${edge > 0n ? "+" : ""}$${ethers.formatUnits(edge, 6)} vs plain ` +
        `(needs the price to survive ${SETTLE_GUARD_BLOCKS} blocks of arbitrage)`
      );
    }
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// The dimension the grid above does not have
//
// runManipulation is open -> pump -> close. The position's ONLY source of profit
// is the attacker's own pump, and the open fee is charged against it. The
// OI-integral impact fee is quadratic in position size, so it dominates, and all
// 896 cells come back clean. That result is correct.
//
// But the sweep has three axes — pool, notional, move — and no fourth for a
// price move the attacker did not cause. A holder whose position is already in
// profit from a third party's order flow paid the entry fee for EXPOSURE, not
// for a manipulation, and at exit that fee is sunk. Their marginal choice is
// plain close vs sandwiched close, which no cell above evaluates.
//
// This sweep adds the drift axis and isolates the manipulation increment by
// differencing against the same cell with no pump — so a directional gain from
// the drift, which the header above rightly calls the LP acting as the house,
// cancels out and only the pump's contribution is measured.
//
// Valuation is portfolioAtP0, exactly as above: leftover tokens marked at the
// pre-attack price rather than dumped.
// ═════════════════════════════════════════════════════════════════════════════

describe("Manipulation: incremental pump on an already-profitable position", function () {
  this.timeout(900_000);

  async function cycle(
    poolUsdc: bigint, poolToken: bigint, notional: bigint, drift: bigint, pump: bigint
  ): Promise<bigint | null> {
    const { pool, poolAddr, usdc, baseToken, attacker } = await deployPool(poolUsdc, poolToken, 0n);

    // Realised USDC, not a mark. portfolioAtP0 references the price at pool
    // CREATION, which is correct for the sweep above — there the only price
    // move is the attacker's own, so reverting to it is the point. Here a third
    // party moves the price first, so that reference is stale and would charge
    // the attacker for the drift's honest appreciation. Fully unwinding instead
    // leaves nothing to mark, and is conservative: the unwind's slippage is paid
    // back to the pool.
    const before     = await usdc.balanceOf(attacker.address);
    const tokenStart = await baseToken.balanceOf(attacker.address);

    const nftId = await openSide(pool, attacker, true, notional);
    if (nftId === null) return null;

    // Third-party order flow. Not the attacker's capital, not their trade.
    const mover = (await ethers.getSigners())[5];
    await usdc.mint(mover.address, drift);
    await usdc.connect(mover).approve(poolAddr, ethers.MaxUint256);
    try {
      await pool.connect(mover).swap(drift, 0n, false, mover.address);
    } catch { return null; }
    // The drift is the position's honest appreciation and belongs OUTSIDE the
    // settlement clamp window, or there is no profitable plain exit to take the
    // increment against. The pump below stays inside it — that is the increment
    // being measured.
    await mine(SETTLE_GUARD_BLOCKS);

    if (pump > 0n) {
      try {
        await pool.connect(attacker).swap(pump, 0n, false, attacker.address);
      } catch { return null; }
    }

    try {
      await pool.connect(attacker).closeLong(nftId, 0n);
    } catch { return null; } // underwater: no voluntary close, not a drain

    const held = (await baseToken.balanceOf(attacker.address)) - tokenStart;
    if (held > 0n) {
      try {
        await pool.connect(attacker).swap(held, 0n, true, attacker.address);
      } catch { return null; } // cannot realise the token leg at all
    }
    return (await usdc.balanceOf(attacker.address)) - before;
  }

  it("sweeps drift x notional x pump and reports where the pump adds value", async function () {
    const POOLS = [
      { label: "$1K P=$1",   usdc: ethers.parseUnits("1000", 6),   token: ethers.parseEther("1000") },
      { label: "$10K P=$1",  usdc: ethers.parseUnits("10000", 6),  token: ethers.parseEther("10000") },
      { label: "$100K P=$1", usdc: ethers.parseUnits("100000", 6), token: ethers.parseEther("100000") },
      { label: "$10K P=$0.001", usdc: ethers.parseUnits("10000", 6), token: ethers.parseEther("10000000") },
    ];
    const NOTIONAL_FRACS = [200n, 800n, 1500n];   // 2 %, 8 %, 15 % of pool USDC
    // Tenths of pool USDC depth. The edge shrinks as the position moves deeper
    // into the money, so the interesting regime is a MODEST favourable move and
    // a pump of the same order as depth — not the multiples the sweep above
    // uses. Ranges chosen to bracket the hand-measured case (drift 0.4x, pump
    // 1x) on both sides.
    const DRIFT_TENTHS   = [2n, 4n, 10n, 20n, 40n];
    const PUMP_TENTHS    = [5n, 10n, 20n, 50n];

    let cells = 0, skipped = 0;
    const drains: { edge: bigint; line: string }[] = [];

    for (const p of POOLS) {
      for (const nf of NOTIONAL_FRACS) {
        const notional = (p.usdc * nf) / 10_000n;
        for (const dm of DRIFT_TENTHS) {
          const drift = (p.usdc * dm) / 10n;
          const plain = await cycle(p.usdc, p.token, notional, drift, 0n);
          if (plain === null) { skipped++; continue; }

          for (const pm of PUMP_TENTHS) {
            const pump = (p.usdc * pm) / 10n;
            const pumped = await cycle(p.usdc, p.token, notional, drift, pump);
            if (pumped === null) { skipped++; continue; }
            cells++;

            const edge = pumped - plain;
            // Only a finding when the holder would actually be in this position:
            // the plain lifecycle must itself be profitable after all fees.
            if (edge > 0n && plain > 0n) {
              drains.push({
                edge,
                line: `${p.label} | notional=$${ethers.formatUnits(notional, 6)} ` +
                      `drift=${dm}/10x pump=${pm}/10x -> +$${ethers.formatUnits(edge, 6)} ` +
                      `(plain $${ethers.formatUnits(plain, 6)} -> $${ethers.formatUnits(pumped, 6)})`,
              });
            }
          }
        }
      }
    }

    drains.sort((a, b) => (b.edge > a.edge ? 1 : -1));
    console.log(`\n      cells evaluated: ${cells}, skipped (revert): ${skipped}`);
    if (drains.length === 0) {
      console.log("      no cell where the pump adds value\n");
    } else {
      console.log(`      ${drains.length}/${cells} cells where the pump ADDS value:`);
      drains.slice(0, 12).forEach((d) => console.log(`        ${d.line}`));
      if (drains.length > 12) console.log(`        ... and ${drains.length - 12} more`);
      console.log("");
    }
    expect(drains.length, "incremental pump adds value").to.equal(0);
  });
});

describe("Manipulation: reconciling the two valuation conventions", function () {
  this.timeout(300_000);

  it("prices the same cell both ways: mark-at-P0 vs dump-back", async function () {
    const poolUsdc  = ethers.parseUnits("100000", 6);
    const poolToken = ethers.parseEther("100000");
    const notional  = ethers.parseUnits("15000", 6);
    const drift     = ethers.parseUnits("40000", 6);

    async function run(pump: bigint) {
      const { pool, poolAddr, usdc, baseToken, attacker } = await deployPool(poolUsdc, poolToken, 0n);
      const usdc0  = await usdc.balanceOf(attacker.address);
      const token0 = await baseToken.balanceOf(attacker.address);

      const nftId = await openSide(pool, attacker, true, notional);
      const mover = (await ethers.getSigners())[5];
      await usdc.mint(mover.address, drift);
      await usdc.connect(mover).approve(poolAddr, ethers.MaxUint256);
      await pool.connect(mover).swap(drift, 0n, false, mover.address);
      // The drift is the position's legitimate profit and must be outside the
      // clamp window; the pump below is the manipulation and must be inside it.
      await mine(SETTLE_GUARD_BLOCKS);

      if (pump > 0n) await pool.connect(attacker).swap(pump, 0n, false, attacker.address);
      await pool.connect(attacker).closeLong(nftId!, 0n);

      const usdcMid  = await usdc.balanceOf(attacker.address);
      const tokensHeld = (await baseToken.balanceOf(attacker.address)) - token0;
      // Convention A - the grid's: mark leftover tokens at the pre-attack price.
      const atP0 = (usdcMid - usdc0) + (tokensHeld * poolUsdc) / poolToken;

      // Convention B - mine: sell them back into the pool.
      let dumped = usdcMid - usdc0;
      if (tokensHeld > 0n) {
        await pool.connect(attacker).swap(tokensHeld, 0n, true, attacker.address);
        dumped = (await usdc.balanceOf(attacker.address)) - usdc0;
      }
      return { atP0, dumped, tokensHeld };
    }

    const base = await run(0n);
    console.log(`\n      plain close: atP0=$${ethers.formatUnits(base.atP0, 6)} dumped=$${ethers.formatUnits(base.dumped, 6)}`);
    for (const pm of [1n, 2n, 10n]) {
      const pump = (poolUsdc * pm) / 10n;
      const r = await run(pump);
      console.log(
        `      pump=$${ethers.formatUnits(pump, 6)}` +
        ` tokensHeld=${ethers.formatEther(r.tokensHeld)}` +
        ` | atP0=$${ethers.formatUnits(r.atP0, 6)} (edge ${ethers.formatUnits(r.atP0 - base.atP0, 6)})` +
        ` | dumped=$${ethers.formatUnits(r.dumped, 6)} (edge ${ethers.formatUnits(r.dumped - base.dumped, 6)})`
      );
    }
    console.log("");
  });
});


// ═════════════════════════════════════════════════════════════════════════════
// H-2, the same-block variant — the one the audit measured
//
// "swap → settleExpired → swap, one transaction." A test script cannot express
// that: Hardhat mines a block per transaction, so the sweep above is always
// cross-block. SandwichAttacker sequences all three legs in a single call, with
// the pool's nonReentrant guard releasing between them exactly as it does on
// chain.
//
// _priceCloseSettlement prices the close against the reserves the block opened
// with. The attacker's pump is the first mutation OF that block, so the snapshot
// predates it and the manufactured mark is unreachable — the payout is
// identical to an honest close, and the round trip is a dead loss.
// ═════════════════════════════════════════════════════════════════════════════

describe("Manipulation: atomic sandwich of your own close (H-2, same block)", function () {
  this.timeout(120_000);

  const POOL_USDC  = ethers.parseUnits("100000", 6);
  const POOL_TOKEN = ethers.parseEther("100000");
  const NOTIONAL   = ethers.parseUnits("15000", 6); // 15 % of depth, inside the cap
  const DRIFT      = ethers.parseUnits("120000", 6);

  /**
   * Open a long through the attacker contract, let an unrelated party move the
   * price in its favour, then exit. `pump = 0` exits plainly.
   *
   * Returns the settlement payout itself, read off PositionClosed rather than
   * derived. Measuring the backed reserve across the whole call would conflate
   * the pump and the unwind with the settlement; the payout is the thing the
   * manipulation is trying to move, so it is the thing to assert on.
   */
  async function atomicExit(pump: bigint) {
    const { pool, poolAddr, usdc, baseToken, attacker } =
      await deployPool(POOL_USDC, POOL_TOKEN, 0n);

    const Att = await ethers.getContractFactory("SandwichAttacker");
    const att = await Att.connect(attacker).deploy(
      poolAddr, await usdc.getAddress(), await baseToken.getAddress(),
    );
    const attAddr = await att.getAddress();

    await usdc.mint(attAddr, POOL_USDC * 100n);
    const openTx = await att.openLong(NOTIONAL);
    const openRc = await openTx.wait();
    const nftId = (openRc!.logs
      .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
      .find((l) => l?.name === "PositionOpened")!.args.nftId) as bigint;

    // Ordinary favourable movement by a third party, so the position is
    // genuinely in profit and a plain exit is available at all.
    const mover = (await ethers.getSigners())[5];
    await usdc.mint(mover.address, DRIFT);
    await usdc.connect(mover).approve(poolAddr, ethers.MaxUint256);
    await pool.connect(mover).swap(DRIFT, 0n, false, mover.address);
    // The honest gain has to be outside the clamp window for a plain exit to be
    // available at all; the attacker's own pump stays inside it, in the very
    // transaction that closes.
    await mine(SETTLE_GUARD_BLOCKS);

    const attBefore = await usdc.balanceOf(attAddr);

    const tx = pump > 0n
      ? await att.sandwichClose(nftId, pump)
      : await att.plainClose(nftId);
    const rc = await tx.wait();

    const payout = (rc!.logs
      .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
      .find((l) => l?.name === "PositionClosed")!.args.payout) as bigint;

    return {
      payout,
      attackerGain: (await usdc.balanceOf(attAddr)) - attBefore,
    };
  }

  it("pays the same as an honest close, whatever the pump", async function () {
    const plain = await atomicExit(0n);

    for (const mult of [1n, 2n, 5n, 10n, 25n]) {
      const pump = (POOL_USDC * mult) / 10n;
      const sandwiched = await atomicExit(pump);

      // Exactly equal, not merely bounded. The clamp prices the close at the
      // block open, which precedes the attacker's own pump, so the manufactured
      // mark is not reachable at any size — a $250,000 pump into a $100,000
      // pool moves the payout by zero.
      expect(sandwiched.payout, `pump $${ethers.formatUnits(pump, 6)}`)
        .to.equal(plain.payout);
    }
  });

  it("leaves the attacker worse off than closing honestly", async function () {
    const plain = await atomicExit(0n);

    for (const mult of [1n, 2n, 5n, 10n, 25n]) {
      const pump = (POOL_USDC * mult) / 10n;
      const sandwiched = await atomicExit(pump);

      // The round trip is now pure cost: two swap fees plus the slippage of
      // unwinding into a pool the close itself reshaped.
      expect(sandwiched.attackerGain, `pump $${ethers.formatUnits(pump, 6)}`)
        .to.be.lt(plain.attackerGain);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The settlement clamp window itself (H-2 cross-block)
//
// The grid above answers "does sandwiching pay". These answer the narrower
// mechanical questions the grid cannot isolate: how far back the clamp reaches,
// that it reaches exactly that far and no further, that it only ever moves the
// outcome against the holder, and that a quiet pool is not frozen against a
// stale reference. Each is a property a comment in EXNIHILOPool asserts, so
// each owes a test that fails when the property is removed.
// ═════════════════════════════════════════════════════════════════════════════

describe("Settlement clamp window", function () {
  this.timeout(120_000);

  const POOL_USDC  = ethers.parseUnits("100000", 6);
  const POOL_TOKEN = ethers.parseEther("100000");
  const NOTIONAL   = ethers.parseUnits("15000", 6);  // 15 % of depth, inside the cap
  const DRIFT      = ethers.parseUnits("120000", 6); // third party, genuine profit
  const PUMP       = ethers.parseUnits("30000", 6);  // the manipulation

  /**
   * A long sitting on a real profit from someone else's order flow, with that
   * move already aged out of the window — the state a holder actually chooses
   * an exit from.
   */
  async function profitableLong() {
    const fix = await deployPool(POOL_USDC, POOL_TOKEN, 0n);
    const nftId = await openSide(fix.pool, fix.attacker, true, NOTIONAL);
    if (nftId === null) throw new Error("open reverted");

    const mover = (await ethers.getSigners())[5];
    await fix.usdc.mint(mover.address, DRIFT);
    await fix.usdc.connect(mover).approve(fix.poolAddr, ethers.MaxUint256);
    await fix.pool.connect(mover).swap(DRIFT, 0n, false, mover.address);
    await mine(SETTLE_GUARD_BLOCKS);

    return { ...fix, nftId };
  }

  /** Payout of a close, read off the balance delta. */
  async function closeFor(fix: any, nftId: bigint): Promise<bigint> {
    const before = await fix.usdc.balanceOf(fix.attacker.address);
    await fix.pool.connect(fix.attacker).closeLong(nftId, 0n);
    return (await fix.usdc.balanceOf(fix.attacker.address)) - before;
  }

  it("pays the un-pumped mark anywhere inside the window", async function () {
    const base = await profitableLong();
    const plain = await closeFor(base, base.nftId);

    // delay = blocks mined between the pump and the close. The pre-pump open is
    // recorded at the pump's own block, so it stays in range while
    // close - pump < SETTLE_GUARD_BLOCKS.
    for (let delay = 0; delay < SETTLE_GUARD_BLOCKS - 1; delay++) {
      const fix = await profitableLong();
      await fix.pool.connect(fix.attacker).swap(PUMP, 0n, false, fix.attacker.address);
      if (delay > 0) await mine(delay);

      expect(await closeFor(fix, fix.nftId), `pump then ${delay} block(s)`)
        .to.equal(plain);
    }
  });

  it("stops clamping once the window has passed — the holder is never trapped", async function () {
    const base = await profitableLong();
    const plain = await closeFor(base, base.nftId);

    const fix = await profitableLong();
    await fix.pool.connect(fix.attacker).swap(PUMP, 0n, false, fix.attacker.address);
    await mine(SETTLE_GUARD_BLOCKS);

    // Deliberately asserted, not hedged. Holding a displaced price for the whole
    // window IS how you reach it — that is the security assumption, not a hole:
    // the price has to survive SETTLE_GUARD_BLOCKS of open arbitrage first. What
    // matters here is that the clamp expires at all, so no holder can be held
    // away from their own position indefinitely.
    expect(await closeFor(fix, fix.nftId)).to.be.gt(plain);
  });

  it("never moves the payout in the holder's favour", async function () {
    const base = await profitableLong();
    const plain = await closeFor(base, base.nftId);

    // Same position, but the price moves AGAINST the long right before the
    // close. A symmetric reference (an average, or the old state used outright)
    // would hand the holder the better historical mark and pay out more than
    // the curve supports. The clamp is one-way, so this must settle at the
    // worse live price.
    const fix = await profitableLong();
    const dump = ethers.parseEther("20000");
    await fix.baseToken.mint(fix.attacker.address, dump);
    await fix.pool.connect(fix.attacker).swap(dump, 0n, true, fix.attacker.address);

    expect(await closeFor(fix, fix.nftId)).to.be.lt(plain);
  });

  it("prices live in a pool that has stopped trading", async function () {
    const fix = await profitableLong();

    // No mutation for a full window: every recorded open ages out by block
    // number, so nothing is left to clamp against and the quote is live. Ring
    // entries are only written on mutation, so without the age test a quiet
    // pool would stay pinned to whatever its last active block happened to be.
    await mine(SETTLE_GUARD_BLOCKS * 4);

    const [ready, quoted] = await fix.pool.quoteClose(fix.nftId);
    expect(ready).to.equal(true);
    expect(await closeFor(fix, fix.nftId)).to.equal(quoted);
  });

  it("cannot be flushed out of the ring early by extra mutations", async function () {
    const base = await profitableLong();
    const plain = await closeFor(base, base.nftId);

    // The attacker pumps, then tries to evict the pre-pump open with their own
    // dust swaps before closing. Every mutation writes at most one entry and
    // only for the block it is in, and the ring is exactly as deep as the
    // window — so filling it completely still cannot displace an entry the
    // window still admits. This is the test that fails if GuardSnapshot[] is
    // ever sized below SETTLE_GUARD_BLOCKS.
    const fix = await profitableLong();
    await fix.pool.connect(fix.attacker).swap(PUMP, 0n, false, fix.attacker.address);

    // Fill every remaining slot: pump at P, dust at P+1..P+3, close at P+4 —
    // five entries, the oldest of which is still the pre-pump one.
    for (let i = 0; i < SETTLE_GUARD_BLOCKS - 2; i++) {
      await fix.pool.connect(fix.attacker).swap(
        ethers.parseUnits("1", 6), 0n, false, fix.attacker.address,
      );
    }

    // Still fully clamped: the pump bought nothing and the dust was pure cost.
    expect(await closeFor(fix, fix.nftId)).to.equal(plain);
  });
});
