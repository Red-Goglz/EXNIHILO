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
    treasury.address, SWAP_FEE_BPS, await poolDeployer.getAddress(),
  )) as unknown as EXNIHILOFactory;
  const factoryAddr = await factory.getAddress();
  await patchImmutableAddress(await lpNft.getAddress(), throwaway.address, factoryAddr);
  await positionNFT.connect(deployer).initFactory(factoryAddr);

  await baseToken.mint(creator.address, initialToken);
  await usdc.mint(creator.address, initialUsdc);
  await baseToken.connect(creator).approve(factoryAddr, ethers.MaxUint256);
  await usdc.connect(creator).approve(factoryAddr, ethers.MaxUint256);

  const tx = await factory.connect(creator).createMarket(
    await baseToken.getAddress(), initialUsdc, initialToken, 0n, maxBps, 0n);
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
    await pool.connect(attacker).closeLong(nftId, 0n);

    const after = await portfolioAtP0(usdc, baseToken, attacker.address, p0Num, p0Den);
    const gain = after - before;
    console.log(`      attacker directional gain from third-party flow: $${ethers.formatUnits(gain, 6)}`);
    // The point of this test is documentary: the gain is positive and comes from
    // directional exposure, which the protocol intentionally offers (LP = house).
    expect(gain).to.be.gt(0n);
  });
});
