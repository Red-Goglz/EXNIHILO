import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
  EXNIHILOPool,
  EXNIHILOFactory,
  EXNIHILORouter,
  LpNFT,
  PositionNFT,
  MockERC20,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// ─────────────────────────────────────────────────────────────────────────────
// Constants (mirrors pool + router)
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
const MIN_POS_FEE    = 50_000n; // 0.05 USDC
const MAX_POS_USD    = ethers.parseUnits("9000", 6);
const MAX_POS_BPS    = 9000n;

/** Compute the position fee exactly as the pool + router do (base + OI-integral impact). */
function positionFee(notional: bigint, backedAirUsd: bigint = INITIAL_USDC, oi: bigint = 0n): bigint {
  let fee =
    (notional * PROTO_FEE_BPS) / BPS_DENOM +
    (notional * LP_FEE_BPS) / BPS_DENOM;
  if (fee < MIN_POS_FEE) fee = MIN_POS_FEE;
  const impact = (IMPACT_FEE_BPS * notional * (2n * oi + notional))
               / (2n * backedAirUsd * BPS_DENOM);
  return fee + impact;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deploy helper (same LpNFT bytecode-patch strategy as EXNIHILOPool.ts)
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

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture — full system + router
// ─────────────────────────────────────────────────────────────────────────────

async function deployRouterFixture() {
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

  // Deploy router
  const router = (await (await ethers.getContractFactory("EXNIHILORouter"))
    .connect(deployer)
    .deploy(factoryAddr, await usdc.getAddress())) as unknown as EXNIHILORouter;
  const routerAddr = await router.getAddress();

  // Create a market
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
    0n
  );
  const receipt = await tx.wait();
  const log = receipt!.logs
    .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "MarketCreated")!;

  const poolAddress: string = log.args.pool;
  const lpNftId: bigint     = log.args.lpNftId;
  const pool = (await ethers.getContractAt("EXNIHILOPool", poolAddress)) as EXNIHILOPool;

  // Fund traders — approve ROUTER (not pool) for USDC; approve pool for tokens
  for (const trader of [trader1, trader2, trader3]) {
    await usdc.mint(trader.address, TRADER_USDC * 10n);
    await baseToken.mint(trader.address, TRADER_TOKEN * 10n);
    // Approve router for USDC
    await usdc.connect(trader).approve(routerAddr, ethers.MaxUint256);
    // Approve router for underlying token (needed for token→USDC swaps)
    await baseToken.connect(trader).approve(routerAddr, ethers.MaxUint256);
    // Also approve pool directly (for non-router comparison tests)
    await usdc.connect(trader).approve(poolAddress, ethers.MaxUint256);
    await baseToken.connect(trader).approve(poolAddress, ethers.MaxUint256);
  }

  return {
    pool, factory, positionNFT, lpNft, baseToken, usdc, router,
    deployer, treasury, creator, trader1, trader2, trader3, other,
    poolAddress, routerAddr, lpNftId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("EXNIHILORouter", function () {

  // ── Deployment ───────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("stores the factory address", async function () {
      const { router, factory } = await loadFixture(deployRouterFixture);
      expect(await router.factory()).to.equal(await factory.getAddress());
    });

    it("stores the USDC address", async function () {
      const { router, usdc } = await loadFixture(deployRouterFixture);
      expect(await router.usdc()).to.equal(await usdc.getAddress());
    });
  });

  // ── openLong via router ──────────────────────────────────────────────────

  describe("openLong", function () {
    it("opens a long position and mints NFT to the trader", async function () {
      const { router, pool, positionNFT, trader1, poolAddress } =
        await loadFixture(deployRouterFixture);

      const notional = ethers.parseUnits("100", 6);
      await router.connect(trader1).openLong(poolAddress, notional, 0n);

      // Trader should own position NFT #0
      expect(await positionNFT.ownerOf(0n)).to.equal(trader1.address);
      const pos = await positionNFT.getPosition(0n);
      expect(pos.isLong).to.equal(true);
      expect(pos.pool).to.equal(poolAddress);
    });

    it("only pulls the 5% fee from the trader, not the full notional", async function () {
      const { router, usdc, trader1, poolAddress } =
        await loadFixture(deployRouterFixture);

      const notional = ethers.parseUnits("200", 6);
      const fee = positionFee(notional);
      const balBefore = await usdc.balanceOf(trader1.address);

      await router.connect(trader1).openLong(poolAddress, notional, 0n);

      const balAfter = await usdc.balanceOf(trader1.address);
      expect(balBefore - balAfter).to.equal(fee);
    });

    it("leaves zero USDC dust in the router", async function () {
      const { router, usdc, trader1, poolAddress, routerAddr } =
        await loadFixture(deployRouterFixture);

      const notional = ethers.parseUnits("123", 6);
      await router.connect(trader1).openLong(poolAddress, notional, 0n);

      expect(await usdc.balanceOf(routerAddr)).to.equal(0n);
    });

    it("increments the pool's openPositionCount", async function () {
      const { router, pool, trader1, poolAddress } =
        await loadFixture(deployRouterFixture);

      const before = await pool.openPositionCount();
      await router.connect(trader1).openLong(poolAddress, ethers.parseUnits("50", 6), 0n);
      expect(await pool.openPositionCount()).to.equal(before + 1n);
    });

    it("emits PositionOpened event on the pool", async function () {
      const { router, pool, trader1, poolAddress } =
        await loadFixture(deployRouterFixture);

      const notional = ethers.parseUnits("100", 6);
      await expect(router.connect(trader1).openLong(poolAddress, notional, 0n))
        .to.emit(pool, "PositionOpened");
    });

    it("respects minAirTokenOut slippage guard", async function () {
      const { router, trader1, poolAddress } =
        await loadFixture(deployRouterFixture);

      const notional = ethers.parseUnits("100", 6);
      await expect(
        router.connect(trader1).openLong(poolAddress, notional, ethers.MaxUint256)
      ).to.be.revertedWithCustomError({ interface: (await ethers.getContractAt("EXNIHILOPool", poolAddress)).interface }, "InsufficientOutput");
    });

    it("reverts with PoolNotRegistered for an unregistered address", async function () {
      const { router, trader1 } = await loadFixture(deployRouterFixture);

      await expect(
        router.connect(trader1).openLong(trader1.address, ethers.parseUnits("100", 6), 0n)
      ).to.be.revertedWithCustomError(router, "PoolNotRegistered");
    });
  });

  // ── openShort via router ─────────────────────────────────────────────────

  describe("openShort", function () {
    it("opens a short position and mints NFT to the trader", async function () {
      const { router, positionNFT, trader1, poolAddress } =
        await loadFixture(deployRouterFixture);

      const notional = ethers.parseUnits("100", 6);
      await router.connect(trader1).openShort(poolAddress, notional, 0n);

      expect(await positionNFT.ownerOf(0n)).to.equal(trader1.address);
      const pos = await positionNFT.getPosition(0n);
      expect(pos.isLong).to.equal(false);
      expect(pos.pool).to.equal(poolAddress);
    });

    it("only pulls the 5% fee from the trader, not the full notional", async function () {
      const { router, usdc, trader1, poolAddress } =
        await loadFixture(deployRouterFixture);

      const notional = ethers.parseUnits("200", 6);
      const fee = positionFee(notional);
      const balBefore = await usdc.balanceOf(trader1.address);

      await router.connect(trader1).openShort(poolAddress, notional, 0n);

      const balAfter = await usdc.balanceOf(trader1.address);
      expect(balBefore - balAfter).to.equal(fee);
    });

    it("leaves zero USDC dust in the router", async function () {
      const { router, usdc, trader1, poolAddress, routerAddr } =
        await loadFixture(deployRouterFixture);

      const notional = ethers.parseUnits("77", 6);
      await router.connect(trader1).openShort(poolAddress, notional, 0n);

      expect(await usdc.balanceOf(routerAddr)).to.equal(0n);
    });

    it("emits PositionOpened event on the pool", async function () {
      const { router, pool, trader1, poolAddress } =
        await loadFixture(deployRouterFixture);

      const notional = ethers.parseUnits("100", 6);
      await expect(router.connect(trader1).openShort(poolAddress, notional, 0n))
        .to.emit(pool, "PositionOpened");
    });

    it("respects minAirUsdOut slippage guard", async function () {
      const { router, trader1, poolAddress } =
        await loadFixture(deployRouterFixture);

      const notional = ethers.parseUnits("100", 6);
      await expect(
        router.connect(trader1).openShort(poolAddress, notional, ethers.MaxUint256)
      ).to.be.revertedWithCustomError({ interface: (await ethers.getContractAt("EXNIHILOPool", poolAddress)).interface }, "InsufficientOutput");
    });

    it("reverts with PoolNotRegistered for an unregistered address", async function () {
      const { router, trader1 } = await loadFixture(deployRouterFixture);

      await expect(
        router.connect(trader1).openShort(trader1.address, ethers.parseUnits("100", 6), 0n)
      ).to.be.revertedWithCustomError(router, "PoolNotRegistered");
    });
  });

  // ── swap via router ──────────────────────────────────────────────────────

  describe("swap", function () {
    it("token→USDC: trader receives USDC, token leaves wallet", async function () {
      const { router, usdc, baseToken, trader1, poolAddress } =
        await loadFixture(deployRouterFixture);

      const amountIn = ethers.parseEther("1000");
      const usdcBefore = await usdc.balanceOf(trader1.address);
      const tokenBefore = await baseToken.balanceOf(trader1.address);

      await router.connect(trader1).swap(poolAddress, amountIn, 0n, true);

      const usdcAfter = await usdc.balanceOf(trader1.address);
      const tokenAfter = await baseToken.balanceOf(trader1.address);

      expect(tokenBefore - tokenAfter).to.equal(amountIn);
      expect(usdcAfter).to.be.gt(usdcBefore);
    });

    it("USDC→token: trader receives tokens, USDC leaves wallet", async function () {
      const { router, usdc, baseToken, trader1, poolAddress } =
        await loadFixture(deployRouterFixture);

      const amountIn = ethers.parseUnits("100", 6);
      const usdcBefore = await usdc.balanceOf(trader1.address);
      const tokenBefore = await baseToken.balanceOf(trader1.address);

      await router.connect(trader1).swap(poolAddress, amountIn, 0n, false);

      const usdcAfter = await usdc.balanceOf(trader1.address);
      const tokenAfter = await baseToken.balanceOf(trader1.address);

      expect(usdcBefore - usdcAfter).to.equal(amountIn);
      expect(tokenAfter).to.be.gt(tokenBefore);
    });

    it("swap succeeds on the pool", async function () {
      const { router, pool, trader1, poolAddress } =
        await loadFixture(deployRouterFixture);

      const amountIn = ethers.parseEther("500");
      await expect(router.connect(trader1).swap(poolAddress, amountIn, 0n, true))
        .to.not.be.reverted;
    });

    it("respects minAmountOut slippage guard", async function () {
      const { router, trader1, poolAddress } =
        await loadFixture(deployRouterFixture);

      const amountIn = ethers.parseEther("100");
      await expect(
        router.connect(trader1).swap(poolAddress, amountIn, ethers.MaxUint256, true)
      ).to.be.revertedWithCustomError({ interface: (await ethers.getContractAt("EXNIHILOPool", poolAddress)).interface }, "InsufficientOutput");
    });

    it("leaves zero token dust in the router (token→USDC)", async function () {
      const { router, baseToken, usdc, trader1, poolAddress, routerAddr } =
        await loadFixture(deployRouterFixture);

      await router.connect(trader1).swap(poolAddress, ethers.parseEther("500"), 0n, true);

      expect(await baseToken.balanceOf(routerAddr)).to.equal(0n);
      expect(await usdc.balanceOf(routerAddr)).to.equal(0n);
    });

    it("leaves zero token dust in the router (USDC→token)", async function () {
      const { router, baseToken, usdc, trader1, poolAddress, routerAddr } =
        await loadFixture(deployRouterFixture);

      await router.connect(trader1).swap(poolAddress, ethers.parseUnits("50", 6), 0n, false);

      expect(await baseToken.balanceOf(routerAddr)).to.equal(0n);
      expect(await usdc.balanceOf(routerAddr)).to.equal(0n);
    });

    it("reverts with PoolNotRegistered for an unregistered address", async function () {
      const { router, trader1 } = await loadFixture(deployRouterFixture);

      await expect(
        router.connect(trader1).swap(trader1.address, ethers.parseEther("100"), 0n, true)
      ).to.be.revertedWithCustomError(router, "PoolNotRegistered");
    });
  });

  // ── Fee accuracy ─────────────────────────────────────────────────────────

  describe("Fee accuracy", function () {
    it("fee matches the pool's fee for a range of notional amounts", async function () {
      const { router, usdc, trader1, poolAddress } =
        await loadFixture(deployRouterFixture);

      // Test several notional sizes
      const notionals = [
        ethers.parseUnits("0.01", 6),   // triggers MIN_POSITION_FEE
        ethers.parseUnits("1", 6),      // 1 USDC
        ethers.parseUnits("50", 6),
        ethers.parseUnits("100", 6),
        ethers.parseUnits("999", 6),
      ];

      let longOI = 0n; // track cumulative long OI
      for (const notional of notionals) {
        const backedUsd = await (await ethers.getContractAt("EXNIHILOPool", poolAddress)).backedAirUsd();
        const expectedFee = positionFee(notional, backedUsd, longOI);
        const balBefore = await usdc.balanceOf(trader1.address);
        await router.connect(trader1).openLong(poolAddress, notional, 0n);
        const balAfter = await usdc.balanceOf(trader1.address);
        expect(balBefore - balAfter).to.equal(expectedFee,
          `Fee mismatch for notional=${notional.toString()}`);
        longOI += notional;
      }
    });

    it("MIN_POSITION_FEE kicks in for tiny notionals", async function () {
      const { router, usdc, trader1, poolAddress } =
        await loadFixture(deployRouterFixture);

      // $0.50 notional → 5% = $0.025 → below $0.05 min → fee = $0.05 + tiny impact
      const notional = ethers.parseUnits("0.50", 6);
      const expectedFee = positionFee(notional);
      const balBefore = await usdc.balanceOf(trader1.address);
      await router.connect(trader1).openLong(poolAddress, notional, 0n);
      const balAfter = await usdc.balanceOf(trader1.address);
      expect(balBefore - balAfter).to.equal(expectedFee);
    });
  });

  // ── Approval edge cases ──────────────────────────────────────────────────

  describe("Approval edge cases", function () {
    it("reverts when trader has not approved USDC to the router", async function () {
      const { router, usdc, other, poolAddress } =
        await loadFixture(deployRouterFixture);

      // Fund `other` but do NOT approve router
      await usdc.mint(other.address, ethers.parseUnits("1000", 6));

      await expect(
        router.connect(other).openLong(poolAddress, ethers.parseUnits("100", 6), 0n)
      ).to.be.reverted;
    });

    it("works with exact fee approval (no excess)", async function () {
      const { router, usdc, other, poolAddress } =
        await loadFixture(deployRouterFixture);

      const notional = ethers.parseUnits("100", 6);
      const fee = positionFee(notional);

      await usdc.mint(other.address, fee);
      await usdc.connect(other).approve(await router.getAddress(), fee);

      await expect(
        router.connect(other).openLong(poolAddress, notional, 0n)
      ).to.not.be.reverted;
    });

    it("reverts when approval is 1 wei below the fee", async function () {
      const { router, usdc, other, poolAddress } =
        await loadFixture(deployRouterFixture);

      const notional = ethers.parseUnits("100", 6);
      const fee = positionFee(notional);

      await usdc.mint(other.address, fee);
      await usdc.connect(other).approve(await router.getAddress(), fee - 1n);

      await expect(
        router.connect(other).openLong(poolAddress, notional, 0n)
      ).to.be.reverted;
    });
  });

  // ── Multiple trades consume allowance correctly ──────────────────────────

  describe("Allowance consumption", function () {
    it("multiple trades consume only the fee per trade (not the notional)", async function () {
      const { router, usdc, other, poolAddress } =
        await loadFixture(deployRouterFixture);

      const notional = ethers.parseUnits("100", 6);
      const numTrades = 5;

      // With OI-integral fee, each trade costs more — compute total across all 5
      let totalNeeded = 0n;
      let oi = 0n;
      for (let i = 0; i < numTrades; i++) {
        totalNeeded += positionFee(notional, INITIAL_USDC, oi);
        oi += notional;
      }

      await usdc.mint(other.address, totalNeeded);
      await usdc.connect(other).approve(await router.getAddress(), totalNeeded);

      for (let i = 0; i < numTrades; i++) {
        await router.connect(other).openLong(poolAddress, notional, 0n);
      }

      // Balance should be zero — all 5 fees consumed exactly
      expect(await usdc.balanceOf(other.address)).to.equal(0n);
    });
  });

  // ── Router produces same position as direct pool call ────────────────────

  describe("Equivalence with direct pool call", function () {
    it("router openLong produces the same NFT position as a direct pool call", async function () {
      const { router, pool, positionNFT, trader1, trader2, poolAddress } =
        await loadFixture(deployRouterFixture);

      const notional = ethers.parseUnits("100", 6);

      // trader1: via router
      await router.connect(trader1).openLong(poolAddress, notional, 0n);
      const posRouter = await positionNFT.getPosition(0n);

      // trader2: directly on pool
      await pool.connect(trader2).openLong(notional, 0n, trader2.address);
      const posDirect = await positionNFT.getPosition(1n);

      expect(posRouter.isLong).to.equal(true);
      expect(posDirect.isLong).to.equal(true);
      expect(posRouter.pool).to.equal(posDirect.pool);
      expect(posRouter.usdcIn).to.equal(posDirect.usdcIn);
      // feesPaid differs because the 2nd position has higher OI (integral fee)
      // but both should be > base fee
      const baseFee = (notional * (PROTO_FEE_BPS + LP_FEE_BPS)) / BPS_DENOM;
      expect(posRouter.feesPaid).to.be.gte(baseFee);
      expect(posDirect.feesPaid).to.be.gte(baseFee);
      expect(posDirect.feesPaid).to.be.gt(posRouter.feesPaid); // 2nd position pays more (higher OI)
      // lockedAmount may differ slightly due to reserve changes between trades
      // but both should be non-zero
      expect(posRouter.lockedAmount).to.be.gt(0n);
      expect(posDirect.lockedAmount).to.be.gt(0n);
    });
  });
});
