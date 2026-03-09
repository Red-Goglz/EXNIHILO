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
// Helper: constant-product AMM output (mirrors contract math)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors _cpAmountOut in EXNIHILOPool:
 *   amountOut = amountIn*(BPS_DENOM-feeBps)*reserveOut
 *             / (reserveIn*BPS_DENOM + amountIn*(BPS_DENOM-feeBps))
 *
 * feeBps defaults to SWAP_FEE_BPS (100) — pass 0n for fee-free SWAP-2/3 calcs.
 */
/**
 * Mirrors _cpAmountOut in EXNIHILOPool (spot-price fee model):
 *   rawOut = amountIn * reserveOut / (reserveIn + amountIn)
 *   fee    = amountIn * reserveOut * feeBps / (reserveIn * BPS_DENOM)
 *   netOut = rawOut - fee  (0 if rawOut <= fee)
 */
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



// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const INITIAL_USDC  = ethers.parseUnits("10000", 6); // 10,000 USDC (6 dec)
const INITIAL_MEME  = ethers.parseEther("1000000");  // 1,000,000 meme (18 dec)
const TRADER_USDC   = ethers.parseUnits("1000", 6);  // 1,000 USDC per trader
const TRADER_MEME   = ethers.parseEther("10000");    // 10,000 meme per trader
const SWAP_FEE_BPS  = 100n;                          // 1 %
const BPS_DENOM     = 10_000n;
const LP_FEE_BPS    = 300n;                          // 3 %
const PROTO_FEE_BPS = 200n;                          // 2 %

// Hard caps large enough not to interfere with most tests
const MAX_POS_USD = ethers.parseUnits("9000", 6); // 9,000 USDC hard cap
const MAX_POS_BPS = 9000n;                        // 90 % of backedAirUsd

// ─────────────────────────────────────────────────────────────────────────────
// Core deployment helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Patch an address immutable baked into deployed EVM bytecode.
 *
 * Solidity immutables are stored as 32-byte (64 hex char) zero-left-padded
 * values directly in the deployed bytecode.  We replace every occurrence of
 * fromAddress with toAddress, then write the result back with hardhat_setCode.
 */
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
    throw new Error(
      `patchImmutableAddress: ${fromAddress} not found in bytecode of ${contractAddress}`
    );
  }

  const patched = raw.split(fromPadded).join(toPadded);
  await ethers.provider.send("hardhat_setCode", [contractAddress, "0x" + patched]);
}

/**
 * LpNFT.factory is an immutable set to msg.sender at construction.
 * EXNIHILOFactory.createMarket() calls lpNftContract.mint(), which requires
 * msg.sender == lpNft.factory. Therefore LpNFT.factory must equal the factory.
 *
 * Bytecode-patch strategy (avoids EIP-161 nonce conflict from impersonation):
 *   signers[7] = throwaway — deploys LpNFT  (LpNFT.factory = throwaway temporarily)
 *   signers[8] = sysDeployer — deploys EXNIHILOFactory
 *   Patch LpNFT bytecode to replace throwaway addr with real factory addr.
 */
async function deploySystem(
  treasuryAddr: string,
  positionNFTAddr: string,
  usdcAddr: string
): Promise<{ factory: EXNIHILOFactory; lpNft: LpNFT }> {
  const signers = await ethers.getSigners();
  const throwaway   = signers[7]; // temporary LpNFT deployer (never used in test roles)
  const sysDeployer = signers[8]; // factory deployer

  // Deploy LpNFT with throwaway.address as factory (will be patched to real factory below)
  const lpNft = (await (await ethers.getContractFactory("LpNFT"))
    .connect(throwaway)
    .deploy(throwaway.address)) as unknown as LpNFT;

  // Deploy EXNIHILOFactory from sysDeployer
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

  // Patch LpNFT bytecode: replace throwaway.address with the real factory address
  await patchImmutableAddress(await lpNft.getAddress(), throwaway.address, factoryAddr);

  const patchedFactory = await lpNft.factory();
  if (patchedFactory.toLowerCase() !== factoryAddr.toLowerCase()) {
    throw new Error(
      `LpNFT.factory mismatch after patch: expected=${factoryAddr} got=${patchedFactory}`
    );
  }

  return { factory, lpNft };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deploys the full system via the factory and returns typed handles.
 * Signers: [0]=deployer [1]=treasury [2]=creator [3]=trader1 [4]=trader2
 *          [5]=trader3 [6]=other [7]=throwaway (LpNFT deployer) [8]=sysDeployer
 */
async function deployPoolFixture() {
  const [deployer, treasury, creator, trader1, trader2, trader3, other] =
    await ethers.getSigners();

  // Deploy tokens and PositionNFT from deployer (signers[0])
  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const memeToken = (await MockERC20F.connect(deployer).deploy("PEPE", "PEPE", 18)) as unknown as MockERC20;
  const usdc      = (await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6)) as unknown as MockERC20;
  const positionNFT = (await (await ethers.getContractFactory("PositionNFT"))
    .connect(deployer).deploy()) as unknown as PositionNFT;

  // Deploy Factory + LpNFT (sysDeployer = signers[9])
  const { factory, lpNft } = await deploySystem(
    treasury.address,
    await positionNFT.getAddress(),
    await usdc.getAddress()
  );

  const factoryAddr = await factory.getAddress();

  // Fund creator, approve factory, create market
  await memeToken.mint(creator.address, INITIAL_MEME);
  await usdc.mint(creator.address, INITIAL_USDC);
  await memeToken.connect(creator).approve(factoryAddr, ethers.MaxUint256);
  await usdc.connect(creator).approve(factoryAddr, ethers.MaxUint256);

  const tx = await factory.connect(creator).createMarket(
    await memeToken.getAddress(),
    INITIAL_USDC,
    INITIAL_MEME,
    MAX_POS_USD,
    MAX_POS_BPS
  );
  const receipt = await tx.wait();

  const iface = factory.interface;
  const log = receipt!.logs
    .map((l) => { try { return iface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "MarketCreated")!;

  const poolAddress: string = log.args.pool;
  const lpNftId: bigint     = log.args.lpNftId;

  const pool = (await ethers.getContractAt("EXNIHILOPool", poolAddress)) as EXNIHILOPool;

  // Fund traders with USDC + meme; approve pool
  for (const trader of [trader1, trader2, trader3]) {
    await usdc.mint(trader.address, TRADER_USDC * 10n);   // ample balance
    await memeToken.mint(trader.address, TRADER_MEME * 10n);
    await usdc.connect(trader).approve(poolAddress, ethers.MaxUint256);
    await memeToken.connect(trader).approve(poolAddress, ethers.MaxUint256);
  }

  return {
    pool,
    factory,
    positionNFT,
    lpNft,
    memeToken,
    usdc,
    deployer,
    treasury,
    creator,
    trader1,
    trader2,
    trader3,
    other,
    poolAddress,
    lpNftId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction helpers
// ─────────────────────────────────────────────────────────────────────────────

async function openLong(
  pool: EXNIHILOPool,
  trader: HardhatEthersSigner,
  usdcAmount: bigint
): Promise<bigint> {
  const tx = await pool.connect(trader).openLong(usdcAmount, 0n);
  const receipt = await tx.wait();
  const log = receipt!.logs
    .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "LongOpened")!;
  return log.args.nftId as bigint;
}

async function openShort(
  pool: EXNIHILOPool,
  trader: HardhatEthersSigner,
  usdcAmount: bigint
): Promise<bigint> {
  const tx = await pool.connect(trader).openShort(usdcAmount, 0n);
  const receipt = await tx.wait();
  const log = receipt!.logs
    .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "ShortOpened")!;
  return log.args.nftId as bigint;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("EXNIHILOPool", function () {

  // ── 1. Normal Swap (SWAP-1) ────────────────────────────────────────────────

  describe("1. Normal Swap (SWAP-1)", function () {

    it("meme→USDC: caller receives USDC, backed reserves update correctly", async function () {
      const { pool, memeToken, usdc, trader1 } = await loadFixture(deployPoolFixture);

      const swapIn     = ethers.parseEther("10000"); // 10,000 meme
      const backedMeme = await pool.backedAirMeme();
      const backedUsd  = await pool.backedAirUsd();

      // Use the Uniswap V2 fee-on-input formula that the contract uses.
      const netOut = cpOut(swapIn, backedMeme, backedUsd);

      const usdcBefore = await usdc.balanceOf(trader1.address);
      await pool.connect(trader1).swap(swapIn, netOut, true);

      expect(await usdc.balanceOf(trader1.address)).to.equal(usdcBefore + netOut);
      expect(await pool.backedAirUsd()).to.equal(backedUsd - netOut);
      expect(await pool.backedAirMeme()).to.equal(backedMeme + swapIn);
    });

    it("USDC→meme: caller receives meme tokens", async function () {
      const { pool, memeToken, usdc, trader1 } = await loadFixture(deployPoolFixture);

      const swapIn     = ethers.parseUnits("100", 6);
      const backedMeme = await pool.backedAirMeme();
      const backedUsd  = await pool.backedAirUsd();

      // Use the Uniswap V2 fee-on-input formula that the contract uses.
      const netOut = cpOut(swapIn, backedUsd, backedMeme);

      const memeBefore = await memeToken.balanceOf(trader1.address);
      await pool.connect(trader1).swap(swapIn, netOut, false);

      expect(await memeToken.balanceOf(trader1.address)).to.equal(memeBefore + netOut);
    });

    it("reverts when netOut < minAmountOut (slippage guard)", async function () {
      const { pool, trader1 } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(trader1).swap(ethers.parseEther("1000"), ethers.MaxUint256, true)
      ).to.be.revertedWithCustomError(pool, "InsufficientOutput");
    });

    it("reverts when amountIn is zero", async function () {
      const { pool, trader1 } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(trader1).swap(0n, 0n, true)
      ).to.be.revertedWithCustomError(pool, "ZeroAmount");
    });

    it("emits Swap event for meme→USDC", async function () {
      const { pool, memeToken, usdc, trader1 } = await loadFixture(deployPoolFixture);
      const swapIn = ethers.parseEther("1000");
      await expect(pool.connect(trader1).swap(swapIn, 0n, true))
        .to.emit(pool, "Swap")
        .withArgs(
          trader1.address,
          await memeToken.getAddress(),
          swapIn,
          await usdc.getAddress(),
          (v: bigint) => v > 0n
        );
    });
  });

  // ── 2. Open Long ──────────────────────────────────────────────────────────

  describe("2. Open Long", function () {

    it("deducts 3% LP fee and 2% protocol fee from notional", async function () {
      const { pool, usdc, treasury, trader1 } = await loadFixture(deployPoolFixture);

      const usdcIn      = ethers.parseUnits("100", 6);
      const protocolFee = (usdcIn * PROTO_FEE_BPS) / BPS_DENOM;
      const lpFee       = (usdcIn * LP_FEE_BPS)    / BPS_DENOM;

      const treasuryBefore = await usdc.balanceOf(treasury.address);
      await openLong(pool, trader1, usdcIn);

      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore + protocolFee);
      expect(await pool.lpFeesAccumulated()).to.equal(lpFee);
    });

    it("mints the long NFT to the trader", async function () {
      const { pool, positionNFT, trader1 } = await loadFixture(deployPoolFixture);
      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      expect(await positionNFT.ownerOf(nftId)).to.equal(trader1.address);
    });

    it("inflates airUsd totalSupply (synthetic debt)", async function () {
      const { pool, trader1 } = await loadFixture(deployPoolFixture);
      const airUsd = await ethers.getContractAt("AirToken", await pool.airUsdToken());
      const supplyBefore = await airUsd.totalSupply();
      await openLong(pool, trader1, ethers.parseUnits("100", 6));
      expect(await airUsd.totalSupply()).to.be.gt(supplyBefore);
    });

    it("backedAirUsd does NOT increase on openLong", async function () {
      const { pool, trader1 } = await loadFixture(deployPoolFixture);
      const backedBefore = await pool.backedAirUsd();
      await openLong(pool, trader1, ethers.parseUnits("100", 6));
      expect(await pool.backedAirUsd()).to.equal(backedBefore);
    });

    it("backedAirMeme decreases by airMemeOut (collateral locked)", async function () {
      const { pool, positionNFT, trader1 } = await loadFixture(deployPoolFixture);
      const backedBefore = await pool.backedAirMeme();
      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      const pos = await positionNFT.getPosition(nftId);
      expect(await pool.backedAirMeme()).to.equal(backedBefore - pos.lockedAmount);
    });

    it("increments openPositionCount", async function () {
      const { pool, trader1 } = await loadFixture(deployPoolFixture);
      expect(await pool.openPositionCount()).to.equal(0n);
      await openLong(pool, trader1, ethers.parseUnits("100", 6));
      expect(await pool.openPositionCount()).to.equal(1n);
    });

    it("reverts when usdcAmount exceeds maxPositionUsd", async function () {
      const { pool, usdc, trader1 } = await loadFixture(deployPoolFixture);
      const overCap = MAX_POS_USD + 1n;
      await usdc.mint(trader1.address, overCap);
      await expect(pool.connect(trader1).openLong(overCap, 0n)).to.be.revertedWithCustomError(
        pool, "LeverageCapExceeded"
      );
    });

    it("reverts when slippage guard triggers (minAirMemeOut too high)", async function () {
      const { pool, trader1 } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(trader1).openLong(ethers.parseUnits("100", 6), ethers.MaxUint256)
      ).to.be.revertedWithCustomError(pool, "InsufficientOutput");
    });

    it("emits LongOpened event", async function () {
      const { pool, trader1 } = await loadFixture(deployPoolFixture);
      const usdcIn = ethers.parseUnits("100", 6);
      await expect(pool.connect(trader1).openLong(usdcIn, 0n))
        .to.emit(pool, "LongOpened")
        .withArgs(
          0n, trader1.address, usdcIn, usdcIn,
          (v: bigint) => v > 0n,
          (v: bigint) => v > 0n
        );
    });
  });

  // ── 3. Close Long ──────────────────────────────────────────────────────────

  describe("3. Close Long", function () {

    /**
     * Opens a long position then pumps the meme price so the position is
     * in profit when closed.  Pumping is done by having trader2 swap USDC→meme,
     * which reduces meme supply relative to USDC backing.
     */
    async function withProfitableLongFixture() {
      const base = await deployPoolFixture();
      const nftId = await openLong(base.pool, base.trader1, ethers.parseUnits("100", 6));

      // Pump meme price: trader2 buys meme with 500 USDC (USDC→meme swap).
      const pumpUsdc = ethers.parseUnits("500", 6);
      await base.usdc.mint(base.trader2.address, pumpUsdc);
      await base.usdc.connect(base.trader2).approve(await base.pool.getAddress(), ethers.MaxUint256);
      await base.pool.connect(base.trader2).swap(pumpUsdc, 0n, false);

      return { ...base, nftId };
    }

    it("profitable close: NFT is burned", async function () {
      const { pool, positionNFT, trader1, nftId } = await loadFixture(withProfitableLongFixture);
      await pool.connect(trader1).closeLong(nftId, 0n);
      await expect(positionNFT.ownerOf(nftId)).to.be.reverted;
    });

    it("profitable close: openPositionCount decrements", async function () {
      const { pool, trader1, nftId } = await loadFixture(withProfitableLongFixture);
      await pool.connect(trader1).closeLong(nftId, 0n);
      expect(await pool.openPositionCount()).to.equal(0n);
    });

    it("profitable close: trader receives USDC surplus", async function () {
      const { pool, usdc, trader1, nftId } = await loadFixture(withProfitableLongFixture);
      const usdcBefore = await usdc.balanceOf(trader1.address);
      await pool.connect(trader1).closeLong(nftId, 0n);
      expect(await usdc.balanceOf(trader1.address)).to.be.gt(usdcBefore);
    });

    it("reverts when position is underwater", async function () {
      const { pool, memeToken, usdc, trader1, trader2 } = await loadFixture(deployPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("500", 6));

      // Crash price by dumping meme
      const dump = ethers.parseEther("5000000");
      await memeToken.mint(trader2.address, dump);
      await memeToken.connect(trader2).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(trader2).swap(dump, 0n, true);

      await expect(
        pool.connect(trader1).closeLong(nftId, 0n)
      ).to.be.revertedWithCustomError(pool, "PositionUnderwater");
    });

    it("reverts when non-holder tries to close", async function () {
      const { pool, trader2, nftId } = await loadFixture(withProfitableLongFixture);
      await expect(
        pool.connect(trader2).closeLong(nftId, 0n)
      ).to.be.revertedWithCustomError(pool, "OnlyPositionHolder");
    });

    it("emits LongClosed event", async function () {
      const { pool, trader1, nftId } = await loadFixture(withProfitableLongFixture);
      await expect(pool.connect(trader1).closeLong(nftId, 0n))
        .to.emit(pool, "LongClosed")
        .withArgs(nftId, trader1.address, (v: bigint) => v >= 0n, (v: bigint) => v > 0n);
    });
  });

  // ── 4. Realize Long ────────────────────────────────────────────────────────

  describe("4. Realize Long", function () {

    async function withLongFixture() {
      const base = await deployPoolFixture();
      const nftId = await openLong(base.pool, base.trader1, ethers.parseUnits("100", 6));
      return { ...base, nftId };
    }

    it("trader pays airUsdMinted USDC and receives locked meme", async function () {
      const { pool, usdc, memeToken, positionNFT, trader1, nftId } =
        await loadFixture(withLongFixture);

      const pos = await positionNFT.getPosition(nftId);
      await usdc.mint(trader1.address, pos.airUsdMinted);
      const memeBefore = await memeToken.balanceOf(trader1.address);

      await pool.connect(trader1).realizeLong(nftId);

      expect(await memeToken.balanceOf(trader1.address)).to.equal(
        memeBefore + pos.lockedAmount
      );
    });

    it("NFT is burned after realizeLong", async function () {
      const { pool, usdc, positionNFT, trader1, nftId } =
        await loadFixture(withLongFixture);

      const pos = await positionNFT.getPosition(nftId);
      await usdc.mint(trader1.address, pos.airUsdMinted);
      await pool.connect(trader1).realizeLong(nftId);
      await expect(positionNFT.ownerOf(nftId)).to.be.reverted;
    });

    it("openPositionCount decrements after realizeLong", async function () {
      const { pool, usdc, positionNFT, trader1, nftId } =
        await loadFixture(withLongFixture);

      const pos = await positionNFT.getPosition(nftId);
      await usdc.mint(trader1.address, pos.airUsdMinted);
      await pool.connect(trader1).realizeLong(nftId);
      expect(await pool.openPositionCount()).to.equal(0n);
    });

    it("backedAirUsd increases by airUsdMinted after realizeLong", async function () {
      const { pool, usdc, positionNFT, trader1, nftId } =
        await loadFixture(withLongFixture);

      const pos = await positionNFT.getPosition(nftId);
      const backedBefore = await pool.backedAirUsd();
      await usdc.mint(trader1.address, pos.airUsdMinted);
      await pool.connect(trader1).realizeLong(nftId);
      expect(await pool.backedAirUsd()).to.equal(backedBefore + pos.airUsdMinted);
    });

    it("reverts when non-holder tries to realize", async function () {
      const { pool, trader2, nftId } = await loadFixture(withLongFixture);
      await expect(
        pool.connect(trader2).realizeLong(nftId)
      ).to.be.revertedWithCustomError(pool, "OnlyPositionHolder");
    });

    it("emits LongRealized event", async function () {
      const { pool, usdc, positionNFT, trader1, nftId } =
        await loadFixture(withLongFixture);

      const pos = await positionNFT.getPosition(nftId);
      await usdc.mint(trader1.address, pos.airUsdMinted);
      await expect(pool.connect(trader1).realizeLong(nftId))
        .to.emit(pool, "LongRealized")
        .withArgs(nftId, trader1.address, pos.airUsdMinted, pos.lockedAmount);
    });
  });

  // ── 5. Open Short ──────────────────────────────────────────────────────────

  describe("5. Open Short", function () {

    it("deducts 3% LP fee and 2% protocol fee from notional", async function () {
      const { pool, usdc, treasury, trader1 } = await loadFixture(deployPoolFixture);

      const usdcIn      = ethers.parseUnits("100", 6);
      const protocolFee = (usdcIn * PROTO_FEE_BPS) / BPS_DENOM;
      const lpFee       = (usdcIn * LP_FEE_BPS)    / BPS_DENOM;

      const treasuryBefore = await usdc.balanceOf(treasury.address);
      await openShort(pool, trader1, usdcIn);

      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore + protocolFee);
      expect(await pool.lpFeesAccumulated()).to.equal(lpFee);
    });

    it("mints the short NFT to the trader", async function () {
      const { pool, positionNFT, trader1 } = await loadFixture(deployPoolFixture);
      const nftId = await openShort(pool, trader1, ethers.parseUnits("100", 6));
      expect(await positionNFT.ownerOf(nftId)).to.equal(trader1.address);
    });

    it("inflates airMeme totalSupply (synthetic debt)", async function () {
      const { pool, trader1 } = await loadFixture(deployPoolFixture);
      const airMeme = await ethers.getContractAt("AirToken", await pool.airMemeToken());
      const supplyBefore = await airMeme.totalSupply();
      await openShort(pool, trader1, ethers.parseUnits("100", 6));
      expect(await airMeme.totalSupply()).to.be.gt(supplyBefore);
    });

    it("backedAirUsd decreases by airUsdOut (collateral locked)", async function () {
      const { pool, positionNFT, trader1 } = await loadFixture(deployPoolFixture);
      const backedBefore = await pool.backedAirUsd();
      const nftId = await openShort(pool, trader1, ethers.parseUnits("100", 6));
      const pos = await positionNFT.getPosition(nftId);
      expect(await pool.backedAirUsd()).to.equal(backedBefore - pos.lockedAmount);
    });

    it("backedAirMeme does NOT change on openShort", async function () {
      const { pool, trader1 } = await loadFixture(deployPoolFixture);
      const backedBefore = await pool.backedAirMeme();
      await openShort(pool, trader1, ethers.parseUnits("100", 6));
      expect(await pool.backedAirMeme()).to.equal(backedBefore);
    });

    it("increments openPositionCount", async function () {
      const { pool, trader1 } = await loadFixture(deployPoolFixture);
      expect(await pool.openPositionCount()).to.equal(0n);
      await openShort(pool, trader1, ethers.parseUnits("100", 6));
      expect(await pool.openPositionCount()).to.equal(1n);
    });

    it("reverts when usdcNotional exceeds maxPositionUsd", async function () {
      const { pool, usdc, trader1 } = await loadFixture(deployPoolFixture);
      const overCap = MAX_POS_USD + 1n;
      await usdc.mint(trader1.address, overCap);
      await expect(
        pool.connect(trader1).openShort(overCap, 0n)
      ).to.be.revertedWithCustomError(pool, "LeverageCapExceeded");
    });

    it("reverts when slippage guard triggers (minAirUsdOut too high)", async function () {
      const { pool, trader1 } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(trader1).openShort(ethers.parseUnits("100", 6), ethers.MaxUint256)
      ).to.be.revertedWithCustomError(pool, "InsufficientOutput");
    });

    it("emits ShortOpened event", async function () {
      const { pool, trader1 } = await loadFixture(deployPoolFixture);
      const usdcIn = ethers.parseUnits("100", 6);
      await expect(pool.connect(trader1).openShort(usdcIn, 0n))
        .to.emit(pool, "ShortOpened")
        .withArgs(0n, trader1.address, (v: bigint) => v > 0n, (v: bigint) => v > 0n, (v: bigint) => v > 0n);
    });
  });

  // ── 6. Close Short ────────────────────────────────────────────────────────
  //
  // Note: closeShort checks whether cpAmountOut(lockedAmount, airUsdSupply, backedAirMeme)
  // covers the airMemeMinted debt.  For standard 18-decimal meme / 6-decimal USDC
  // pools the lockedAmount (6 dec, small) buys back far fewer airMeme (18 dec) than
  // the debt, so positions are permanently underwater.  All tests below reflect the
  // actual contract behaviour.

  describe("6. Close Short", function () {

    async function withShortFixture() {
      const base = await deployPoolFixture();
      const nftId = await openShort(base.pool, base.trader1, ethers.parseUnits("100", 6));
      return { ...base, nftId };
    }

    it("always reverts with PositionUnderwater for 18-dec meme / 6-dec USDC", async function () {
      // lockedAmount (6-dec units) buys back far fewer airMeme (18-dec) than the debt → underwater.
      const { pool, trader1, nftId } = await loadFixture(withShortFixture);
      await expect(
        pool.connect(trader1).closeShort(nftId, 0n)
      ).to.be.revertedWithCustomError(pool, "PositionUnderwater");
    });

    it("short remains underwater after a price pump (meme more expensive to buy back)", async function () {
      // A price pump increases the cost to buy back the airMeme debt,
      // which pushes a short further underwater.
      const { pool, usdc, trader1, trader2, nftId } = await loadFixture(withShortFixture);

      // Pump price by buying meme with large USDC
      const pumpUsdc = ethers.parseUnits("8000", 6);
      await usdc.mint(trader2.address, pumpUsdc);
      await usdc.connect(trader2).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(trader2).swap(pumpUsdc, 0n, false);

      await expect(
        pool.connect(trader1).closeShort(nftId, 0n)
      ).to.be.revertedWithCustomError(pool, "PositionUnderwater");
    });

    it("reverts when position is underwater due to price pump", async function () {
      const { pool, usdc, memeToken, trader1, trader2 } = await loadFixture(deployPoolFixture);

      const nftId = await openShort(pool, trader1, ethers.parseUnits("500", 6));

      // Pump price by buying meme with large USDC
      const pumpUsdc = ethers.parseUnits("5000", 6);
      await usdc.mint(trader2.address, pumpUsdc);
      await usdc.connect(trader2).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(trader2).swap(pumpUsdc, 0n, false);

      await expect(
        pool.connect(trader1).closeShort(nftId, 0n)
      ).to.be.revertedWithCustomError(pool, "PositionUnderwater");
    });

    it("reverts when non-holder tries to close (OnlyPositionHolder check fires first)", async function () {
      // The OnlyPositionHolder check precedes the underwater check.
      const { pool, trader2, nftId } = await loadFixture(withShortFixture);
      await expect(
        pool.connect(trader2).closeShort(nftId, 0n)
      ).to.be.revertedWithCustomError(pool, "OnlyPositionHolder");
    });

  });

  // ── 7. Realize Short ──────────────────────────────────────────────────────

  describe("7. Realize Short", function () {

    async function withShortFixture() {
      const base = await deployPoolFixture();
      const nftId = await openShort(base.pool, base.trader1, ethers.parseUnits("100", 6));
      return { ...base, nftId };
    }

    it("trader pays airMemeMinted meme and receives locked USDC", async function () {
      const { pool, usdc, memeToken, positionNFT, trader1, nftId } =
        await loadFixture(withShortFixture);

      const pos = await positionNFT.getPosition(nftId);
      await memeToken.mint(trader1.address, pos.airMemeMinted);
      const usdcBefore = await usdc.balanceOf(trader1.address);

      await pool.connect(trader1).realizeShort(nftId);

      expect(await usdc.balanceOf(trader1.address)).to.equal(
        usdcBefore + pos.lockedAmount
      );
    });

    it("NFT is burned after realizeShort", async function () {
      const { pool, memeToken, positionNFT, trader1, nftId } =
        await loadFixture(withShortFixture);

      const pos = await positionNFT.getPosition(nftId);
      await memeToken.mint(trader1.address, pos.airMemeMinted);
      await pool.connect(trader1).realizeShort(nftId);
      await expect(positionNFT.ownerOf(nftId)).to.be.reverted;
    });

    it("openPositionCount decrements after realizeShort", async function () {
      const { pool, memeToken, positionNFT, trader1, nftId } =
        await loadFixture(withShortFixture);

      const pos = await positionNFT.getPosition(nftId);
      await memeToken.mint(trader1.address, pos.airMemeMinted);
      await pool.connect(trader1).realizeShort(nftId);
      expect(await pool.openPositionCount()).to.equal(0n);
    });

    it("reverts when non-holder tries to realize", async function () {
      const { pool, trader2, nftId } = await loadFixture(withShortFixture);
      await expect(
        pool.connect(trader2).realizeShort(nftId)
      ).to.be.revertedWithCustomError(pool, "OnlyPositionHolder");
    });

    it("emits ShortRealized event", async function () {
      const { pool, memeToken, positionNFT, trader1, nftId } =
        await loadFixture(withShortFixture);

      const pos = await positionNFT.getPosition(nftId);
      await memeToken.mint(trader1.address, pos.airMemeMinted);
      await expect(pool.connect(trader1).realizeShort(nftId))
        .to.emit(pool, "ShortRealized")
        .withArgs(nftId, trader1.address, pos.airMemeMinted, pos.lockedAmount);
    });
  });

  // ── 8. LP: addLiquidity ────────────────────────────────────────────────────

  describe("8. LP: addLiquidity", function () {

    it("LP holder can add liquidity in the correct ratio", async function () {
      const { pool, memeToken, usdc, creator } = await loadFixture(deployPoolFixture);

      const backedMeme = await pool.backedAirMeme();
      const backedUsd  = await pool.backedAirUsd();
      const addMeme    = ethers.parseEther("100000");
      const addUsd     = (addMeme * backedUsd) / backedMeme;

      await memeToken.mint(creator.address, addMeme);
      await usdc.mint(creator.address, addUsd);
      await memeToken.connect(creator).approve(await pool.getAddress(), addMeme);
      await usdc.connect(creator).approve(await pool.getAddress(), addUsd);

      await pool.connect(creator).addLiquidity(addMeme, addUsd);

      expect(await pool.backedAirMeme()).to.equal(backedMeme + addMeme);
      // Allow ±2 wei rounding in USDC side
      const newBacked = await pool.backedAirUsd();
      expect(newBacked).to.be.gte(backedUsd + addUsd - 2n);
      expect(newBacked).to.be.lte(backedUsd + addUsd + 2n);
    });

    it("reverts when called by non-LP-holder", async function () {
      const { pool, memeToken, usdc, other } = await loadFixture(deployPoolFixture);
      await memeToken.mint(other.address, INITIAL_MEME);
      await usdc.mint(other.address, INITIAL_USDC);
      await memeToken.connect(other).approve(await pool.getAddress(), ethers.MaxUint256);
      await usdc.connect(other).approve(await pool.getAddress(), ethers.MaxUint256);
      await expect(
        pool.connect(other).addLiquidity(INITIAL_MEME, INITIAL_USDC)
      ).to.be.revertedWithCustomError(pool, "OnlyLpHolder");
    });

    it("reverts when ratio is wrong", async function () {
      const { pool, memeToken, usdc, creator } = await loadFixture(deployPoolFixture);
      const addMeme = ethers.parseEther("100000");
      const badUsd  = ethers.parseUnits("1", 6);
      await memeToken.mint(creator.address, addMeme);
      await usdc.mint(creator.address, badUsd);
      await memeToken.connect(creator).approve(await pool.getAddress(), addMeme);
      await usdc.connect(creator).approve(await pool.getAddress(), badUsd);
      await expect(
        pool.connect(creator).addLiquidity(addMeme, badUsd)
      ).to.be.revertedWithCustomError(pool, "RatioMismatch");
    });

    it("reverts when memeAmount is zero", async function () {
      const { pool, creator } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(creator).addLiquidity(0n, INITIAL_USDC)
      ).to.be.revertedWithCustomError(pool, "ZeroAmount");
    });

    it("emits LiquidityAdded event", async function () {
      const { pool, memeToken, usdc, creator } = await loadFixture(deployPoolFixture);

      const backedMeme = await pool.backedAirMeme();
      const backedUsd  = await pool.backedAirUsd();
      const addMeme    = ethers.parseEther("100000");
      const addUsd     = (addMeme * backedUsd) / backedMeme;

      await memeToken.mint(creator.address, addMeme);
      await usdc.mint(creator.address, addUsd);
      await memeToken.connect(creator).approve(await pool.getAddress(), addMeme);
      await usdc.connect(creator).approve(await pool.getAddress(), addUsd);

      await expect(pool.connect(creator).addLiquidity(addMeme, addUsd))
        .to.emit(pool, "LiquidityAdded")
        .withArgs(
          creator.address, addMeme, addUsd,
          backedMeme + addMeme,
          (v: bigint) => v > 0n
        );
    });
  });

  // ── 9. LP: removeLiquidity ─────────────────────────────────────────────────

  describe("9. LP: removeLiquidity", function () {

    it("returns both assets to the LP holder when no positions are open", async function () {
      const { pool, memeToken, usdc, creator } = await loadFixture(deployPoolFixture);

      const backedMeme = await pool.backedAirMeme();
      const backedUsd  = await pool.backedAirUsd();
      const memeBefore = await memeToken.balanceOf(creator.address);
      const usdcBefore = await usdc.balanceOf(creator.address);

      await pool.connect(creator).removeLiquidity();

      expect(await memeToken.balanceOf(creator.address)).to.equal(memeBefore + backedMeme);
      expect(await usdc.balanceOf(creator.address)).to.equal(usdcBefore + backedUsd);
    });

    it("sets backed reserves to zero after remove", async function () {
      const { pool, creator } = await loadFixture(deployPoolFixture);
      await pool.connect(creator).removeLiquidity();
      expect(await pool.backedAirMeme()).to.equal(0n);
      expect(await pool.backedAirUsd()).to.equal(0n);
    });

    it("reverts when open positions exist", async function () {
      const { pool, creator, trader1 } = await loadFixture(deployPoolFixture);
      await openLong(pool, trader1, ethers.parseUnits("100", 6));
      await expect(
        pool.connect(creator).removeLiquidity()
      ).to.be.revertedWithCustomError(pool, "OpenPositionsExist");
    });

    it("reverts when called by non-LP-holder", async function () {
      const { pool, other } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(other).removeLiquidity()
      ).to.be.revertedWithCustomError(pool, "OnlyLpHolder");
    });

    it("emits LiquidityRemoved event", async function () {
      const { pool, creator } = await loadFixture(deployPoolFixture);
      const backedMeme = await pool.backedAirMeme();
      const backedUsd  = await pool.backedAirUsd();
      await expect(pool.connect(creator).removeLiquidity())
        .to.emit(pool, "LiquidityRemoved")
        .withArgs(creator.address, backedMeme, backedUsd);
    });
  });

  // ── 10. LP: claimFees ──────────────────────────────────────────────────────

  describe("10. LP: claimFees", function () {

    async function withFeesFixture() {
      const base = await deployPoolFixture();
      // Open two positions to accumulate LP fees
      await openLong(base.pool, base.trader1, ethers.parseUnits("200", 6));
      await openShort(base.pool, base.trader2, ethers.parseUnits("200", 6));
      return base;
    }

    it("LP holder receives accumulated LP fees", async function () {
      const { pool, usdc, creator } = await loadFixture(withFeesFixture);
      const accumulated = await pool.lpFeesAccumulated();
      expect(accumulated).to.be.gt(0n);
      const usdcBefore = await usdc.balanceOf(creator.address);
      await pool.connect(creator).claimFees();
      expect(await usdc.balanceOf(creator.address)).to.equal(usdcBefore + accumulated);
    });

    it("lpFeesAccumulated resets to zero after claim", async function () {
      const { pool, creator } = await loadFixture(withFeesFixture);
      await pool.connect(creator).claimFees();
      expect(await pool.lpFeesAccumulated()).to.equal(0n);
    });

    it("reverts when lpFeesAccumulated is zero", async function () {
      const { pool, creator } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(creator).claimFees()
      ).to.be.revertedWithCustomError(pool, "ZeroAmount");
    });

    it("reverts when called by non-LP-holder", async function () {
      const { pool, other } = await loadFixture(withFeesFixture);
      await expect(
        pool.connect(other).claimFees()
      ).to.be.revertedWithCustomError(pool, "OnlyLpHolder");
    });

    it("emits FeesClaimed event", async function () {
      const { pool, creator } = await loadFixture(withFeesFixture);
      const accumulated = await pool.lpFeesAccumulated();
      await expect(pool.connect(creator).claimFees())
        .to.emit(pool, "FeesClaimed")
        .withArgs(creator.address, accumulated);
    });
  });

  // ── 11. LP: forceRealize ─────────────────────────────────────────────

  describe("11. LP: forceRealize", function () {

    it("force-realize underwater long: LP pays USDC, holder receives meme", async function () {
      const { pool, usdc, memeToken, positionNFT, creator, trader1, trader2 } =
        await loadFixture(deployPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("500", 6));
      const pos   = await positionNFT.getPosition(nftId);

      // Crash price
      const dump = ethers.parseEther("5000000");
      await memeToken.mint(trader2.address, dump);
      await memeToken.connect(trader2).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(trader2).swap(dump, 0n, true);

      // LP pays USDC debt
      await usdc.mint(creator.address, pos.airUsdMinted);
      await usdc.connect(creator).approve(await pool.getAddress(), pos.airUsdMinted);

      const memeBefore = await memeToken.balanceOf(trader1.address);
      await pool.connect(creator).forceRealize(nftId);

      expect(await memeToken.balanceOf(trader1.address)).to.equal(
        memeBefore + pos.lockedAmount
      );
      await expect(positionNFT.ownerOf(nftId)).to.be.reverted;
      expect(await pool.openPositionCount()).to.equal(0n);
    });

    it("force-realize underwater short: LP pays meme, holder receives USDC", async function () {
      const { pool, usdc, memeToken, positionNFT, creator, trader1, trader2 } =
        await loadFixture(deployPoolFixture);

      const nftId = await openShort(pool, trader1, ethers.parseUnits("500", 6));
      const pos   = await positionNFT.getPosition(nftId);

      // Pump price
      const pumpUsdc = ethers.parseUnits("5000", 6);
      await usdc.mint(trader2.address, pumpUsdc);
      await usdc.connect(trader2).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(trader2).swap(pumpUsdc, 0n, false);

      // LP pays meme debt
      await memeToken.mint(creator.address, pos.airMemeMinted);
      await memeToken.connect(creator).approve(await pool.getAddress(), pos.airMemeMinted);

      const usdcBefore = await usdc.balanceOf(trader1.address);
      await pool.connect(creator).forceRealize(nftId);

      expect(await usdc.balanceOf(trader1.address)).to.equal(
        usdcBefore + pos.lockedAmount
      );
    });

    it("reverts when long position is NOT underwater (still profitable)", async function () {
      const { pool, usdc, creator, trader1, trader2 } = await loadFixture(deployPoolFixture);
      const nftId = await openLong(pool, trader1, ethers.parseUnits("50", 6));

      // Pump the meme price so the long position is in profit.
      const pumpUsdc = ethers.parseUnits("500", 6);
      await usdc.mint(trader2.address, pumpUsdc);
      await usdc.connect(trader2).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(trader2).swap(pumpUsdc, 0n, false);

      await expect(
        pool.connect(creator).forceRealize(nftId)
      ).to.be.revertedWithCustomError(pool, "PositionAlreadyProfitable");
    });

    it("reverts when called by non-LP-holder", async function () {
      const { pool, memeToken, usdc, positionNFT, trader1, trader2, other } =
        await loadFixture(deployPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("500", 6));

      const dump = ethers.parseEther("5000000");
      await memeToken.mint(trader2.address, dump);
      await memeToken.connect(trader2).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(trader2).swap(dump, 0n, true);

      await expect(
        pool.connect(other).forceRealize(nftId)
      ).to.be.revertedWithCustomError(pool, "OnlyLpHolder");
    });

    it("emits PositionForceRealized for an underwater long", async function () {
      const { pool, usdc, memeToken, positionNFT, creator, trader1, trader2 } =
        await loadFixture(deployPoolFixture);

      const nftId = await openLong(pool, trader1, ethers.parseUnits("500", 6));
      const pos   = await positionNFT.getPosition(nftId);

      const dump = ethers.parseEther("5000000");
      await memeToken.mint(trader2.address, dump);
      await memeToken.connect(trader2).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(trader2).swap(dump, 0n, true);

      await usdc.mint(creator.address, pos.airUsdMinted);
      await usdc.connect(creator).approve(await pool.getAddress(), pos.airUsdMinted);

      await expect(pool.connect(creator).forceRealize(nftId))
        .to.emit(pool, "PositionForceRealized")
        .withArgs(nftId, creator.address, pos.airUsdMinted);
    });
  });

  // ── 12. View helpers ──────────────────────────────────────────────────────

  describe("13. View helpers", function () {

    it("spotPrice returns non-zero after deployment", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.spotPrice()).to.be.gt(0n);
    });

    it("quoteSwap netOut matches the actual USDC received in a swap", async function () {
      const { pool, usdc, trader1 } = await loadFixture(deployPoolFixture);
      const swapIn = ethers.parseEther("10000");
      const [, , netOut] = await pool.quoteSwap(swapIn, true);
      const usdcBefore = await usdc.balanceOf(trader1.address);
      await pool.connect(trader1).swap(swapIn, 0n, true);
      expect(await usdc.balanceOf(trader1.address) - usdcBefore).to.equal(netOut);
    });

    it("effectiveLeverageCap returns a value <= maxPositionUsd", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const cap = await pool.effectiveLeverageCap();
      expect(cap).to.be.lte(MAX_POS_USD);
    });

    it("quoteSwap USDC→meme direction returns nonzero netOut", async function () {
      const { pool, memeToken, trader1 } = await loadFixture(deployPoolFixture);
      const swapIn = ethers.parseUnits("100", 6);
      const [, , netOut] = await pool.quoteSwap(swapIn, false);
      expect(netOut).to.be.gt(0n);
      // Verify quote matches actual swap output.
      const memeBefore = await memeToken.balanceOf(trader1.address);
      await pool.connect(trader1).swap(swapIn, 0n, false);
      expect(await memeToken.balanceOf(trader1.address) - memeBefore).to.equal(netOut);
    });

    it("quoteSwap returns (0,0,0) when amountIn is zero", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const [grossOut, fee, netOut] = await pool.quoteSwap(0n, true);
      expect(grossOut).to.equal(0n);
      expect(fee).to.equal(0n);
      expect(netOut).to.equal(0n);
    });

    it("spotPrice returns 0 when backed reserves are empty", async function () {
      const { pool, creator } = await loadFixture(deployPoolFixture);
      await pool.connect(creator).removeLiquidity();
      expect(await pool.spotPrice()).to.equal(0n);
    });

    it("effectiveLeverageCap returns max when both caps disabled", async function () {
      // Deploy a pool with both maxPositionUsd=0 and maxPositionBps=0.
      const { factory, usdc, memeToken, creator } = await loadFixture(deployFactoryFixtureForPool);
      const tx = await factory.connect(creator).createMarket(
        await memeToken.getAddress(), INITIAL_USDC, INITIAL_MEME, 0n, 0n
      );
      const receipt = await tx.wait();
      const log = receipt!.logs
        .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
        .find((l) => l?.name === "MarketCreated")!;
      const pool = await ethers.getContractAt("EXNIHILOPool", log.args.pool as string);
      expect(await pool.effectiveLeverageCap()).to.equal(ethers.MaxUint256);
    });

    it("effectiveLeverageCap when only maxPositionBps is set (bps cap binds)", async function () {
      // Deploy a pool with maxPositionUsd=0 and maxPositionBps=100 (1 %).
      // The cap should equal 1 % of backedAirUsd.
      const { factory, usdc, memeToken, creator } = await loadFixture(deployFactoryFixtureForPool);
      const tx = await factory.connect(creator).createMarket(
        await memeToken.getAddress(), INITIAL_USDC, INITIAL_MEME, 0n, 100n // 1% bps
      );
      const receipt = await tx.wait();
      const log = receipt!.logs
        .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
        .find((l) => l?.name === "MarketCreated")!;
      const pool = await ethers.getContractAt("EXNIHILOPool", log.args.pool as string);
      const backedAirUsd = await pool.backedAirUsd();
      const expectedBpsCap = (backedAirUsd * 100n) / 10_000n;
      expect(await pool.effectiveLeverageCap()).to.equal(expectedBpsCap);
    });

    it("effectiveLeverageCap when bpsCap < usdCap (bps binds)", async function () {
      // maxPositionBps=10 (0.1%), maxPositionUsd=very large → bps cap binds.
      const { factory, usdc, memeToken, creator } = await loadFixture(deployFactoryFixtureForPool);
      const tx = await factory.connect(creator).createMarket(
        await memeToken.getAddress(), INITIAL_USDC, INITIAL_MEME,
        ethers.parseUnits("9999", 6), // large USD cap
        10n                           // 0.1% bps cap (binding)
      );
      const receipt = await tx.wait();
      const log = receipt!.logs
        .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
        .find((l) => l?.name === "MarketCreated")!;
      const pool = await ethers.getContractAt("EXNIHILOPool", log.args.pool as string);
      const backedAirUsd = await pool.backedAirUsd();
      const bpsCap = (backedAirUsd * 10n) / 10_000n;
      expect(await pool.effectiveLeverageCap()).to.equal(bpsCap);
    });

    it("removeLiquidity reverts with ZeroLiquidity when reserves are already zero", async function () {
      const { pool, creator } = await loadFixture(deployPoolFixture);
      // Remove once to drain reserves.
      await pool.connect(creator).removeLiquidity();
      // A second remove on an empty pool should revert.
      await expect(
        pool.connect(creator).removeLiquidity()
      ).to.be.revertedWithCustomError(pool, "ZeroLiquidity");
    });

    it("setPositionCaps emits PositionCapsUpdated with correct args", async function () {
      const { pool, creator } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(creator).setPositionCaps(ethers.parseUnits("500", 6), 250n))
        .to.emit(pool, "PositionCapsUpdated")
        .withArgs(ethers.parseUnits("500", 6), 250n, creator.address);
    });

    it("isLongUnderwater returns true for a freshly opened long (double-fee immediately underwater)", async function () {
      // A long opened at the current spot price is immediately underwater because
      // SWAP-2 pays a fee on open AND SWAP-3 deducts a fee on close at the same price.
      const { pool, trader1 } = await loadFixture(deployPoolFixture);
      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      expect(await pool.isLongUnderwater(nftId)).to.equal(true);
    });

    it("isLongUnderwater returns false after the meme price pumps sufficiently", async function () {
      const { pool, usdc, trader1, trader2 } = await loadFixture(deployPoolFixture);
      const nftId = await openLong(pool, trader1, ethers.parseUnits("100", 6));
      // Pump meme price with a large USDC→meme swap.
      const pumpUsdc = ethers.parseUnits("500", 6);
      await usdc.mint(trader2.address, pumpUsdc);
      await usdc.connect(trader2).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(trader2).swap(pumpUsdc, 0n, false);
      expect(await pool.isLongUnderwater(nftId)).to.equal(false);
    });

    it("isShortUnderwater returns true for a standard 18-dec/6-dec pool short", async function () {
      // For 18-dec meme / 6-dec USDC, lockedAmount (6-dec) can never buy back
      // airMemeMinted (18-dec) → always underwater.
      const { pool, trader1 } = await loadFixture(deployPoolFixture);
      const nftId = await openShort(pool, trader1, ethers.parseUnits("100", 6));
      expect(await pool.isShortUnderwater(nftId)).to.equal(true);
    });

    it("openLong reverts with bps cap when only maxPositionBps is set", async function () {
      // Pool with maxPositionBps=10 (0.1 %), maxPositionUsd=0.
      const { factory, usdc, memeToken, creator, trader1 } = await loadFixture(deployFactoryFixtureForPool);
      await factory.connect(creator).createMarket(
        await memeToken.getAddress(), INITIAL_USDC, INITIAL_MEME, 0n, 10n
      );
      const poolAddr = await factory.allPools(0n);
      const pool = await ethers.getContractAt("EXNIHILOPool", poolAddr);

      const bpsCap = (INITIAL_USDC * 10n) / 10_000n; // 0.1% of 10,000 USDC = 10 USDC
      const overCap = bpsCap + 1n;
      await usdc.mint(trader1.address, overCap);
      await usdc.connect(trader1).approve(poolAddr, ethers.MaxUint256);
      await expect(
        pool.connect(trader1).openLong(overCap, 0n)
      ).to.be.revertedWithCustomError(pool, "LeverageCapExceeded");
    });
  });

  // ── Trading Scenario ────────────────────────────────────────────────────────

  describe("Trading Scenario: open long → large swap → close → reswap", function () {
    /**
     * Scenario constants — trader starts with TRADER_USDC*10 = 10,000 USDC.
     * $9,999 leaves $0.50 headroom for the long fee without running dry.
     */
    const LONG_NOTIONAL = ethers.parseUnits("10",   6); // $10 notional long
    const LONG_FEE      = (ethers.parseUnits("10", 6) * 500n) / 10_000n; // $0.50
    const SWAP_IN_USDC  = ethers.parseUnits("9999", 6); // $9,999 USDC→PEPE swap

    /**
     * The full 4-step sequence on the STANDARD pool (10,000 USDC / 1,000,000 PEPE):
     *   1. openLong($10):  pays $0.50 fee; SWAP-2 locks ~989 airMeme collateral.
     *   2. swap($9,999 USDC→PEPE):  burns ~497k airMeme; price roughly doubles.
     *   3. closeLong: SWAP-3 returns ~$29 profit (price up but supply only halved).
     *   4. swap(PEPE→USDC):  ~$9,882 back.
     *
     *   Net ≈ −$0.50 − $9,999 + $29 + $9,882 = −$88 (negative — pool protected).
     *
     * Why thin pools (e.g. 1,000/1,000) are dangerous:
     *   The same swap burns ~90% of airMeme supply instead of ~50%, collapsing
     *   SWAP-3's (totalSupply − locked) denominator to ~91 tokens and inflating
     *   the profit to ~$1,051 → net ≈ +$68, draining the LP.
     *   Pool creators should seed with adequate liquidity; the leverage cap
     *   further limits the exploitable position-to-pool ratio.
     */
    it("full sequence is net NEGATIVE — standard pool cannot be drained by pump-and-dump", async function () {
      const { pool, memeToken, usdc, trader1 } = await loadFixture(deployPoolFixture);

      const usdcBefore = await usdc.balanceOf(trader1.address);
      const memeBefore = await memeToken.balanceOf(trader1.address);

      // Step 1: open $10 long (pays only $0.50 fee upfront)
      const nftId = await openLong(pool, trader1, LONG_NOTIONAL);

      // Step 2: pump — $9,999 USDC → PEPE
      await pool.connect(trader1).swap(SWAP_IN_USDC, 0n, false);
      const memeReceived = (await memeToken.balanceOf(trader1.address)) - memeBefore;

      // Step 3: close long (collects profit from the price increase)
      await pool.connect(trader1).closeLong(nftId, 0n);

      // Step 4: dump — sell all received PEPE back to USDC
      await pool.connect(trader1).swap(memeReceived, 0n, true);

      const netGain = (await usdc.balanceOf(trader1.address)) - usdcBefore;

      // Total invested: $0.50 fee + $9,999 swap = $9,999.50
      // Total returned: ~$29 profit + ~$9,882 reswap ≈ $9,911
      // Net ≈ −$88 — the round-trip price-impact + fees exceed the long profit
      expect(netGain).to.be.lt(0n);

      console.log(`      [scenario] net: $${ethers.formatUnits(netGain, 6)} USDC (expected ≈ −$88)`);
    });

    /**
     * FEE-05 / DEX-05 check: confirm that SWAP-2 (openLong) and SWAP-3
     * (closeLong) run through the same _cpAmountOut(feeBps=swapFeeBps) path
     * as SWAP-1, so the 1% swap fee bites in both directions.
     *
     * Effect of the fee:
     *   SWAP-2: fewer airMeme tokens locked (fee reduces output)
     *   SWAP-3: less airUsd returned to the trader (fee reduces output)
     *
     * At pool creation, airUsd.totalSupply() == backedAirUsd (LP holds all
     * airUsd), so backedAirUsd is a valid stand-in for the SWAP-2 reserveIn.
     * After a single USDC→PEPE swap, backedAirMeme == airMeme.totalSupply()
     * minus the locked amount (one open position), so backedAirMeme is a
     * valid stand-in for the SWAP-3 reserveIn.
     */
    it("SWAP-2 and SWAP-3 apply the 1% swapFee (same _cpAmountOut as SWAP-1)", async function () {
      const { pool, usdc, positionNFT, trader1 } = await loadFixture(deployPoolFixture);

      const backedMeme = await pool.backedAirMeme(); // = airMeme.totalSupply() initially
      const backedUsd  = await pool.backedAirUsd();  // = airUsd.totalSupply() initially

      // ── SWAP-2 fee verification ──────────────────────────────────────────
      // With 1% fee the locked amount is strictly less than the fee-free amount
      const lockedWithFee    = cpOut(LONG_NOTIONAL, backedUsd,  backedMeme);      // 100 bps
      const lockedWithoutFee = cpOut(LONG_NOTIONAL, backedUsd,  backedMeme, 0n);  //   0 bps
      expect(lockedWithFee).to.be.lt(lockedWithoutFee);

      // The contract must produce the fee-reduced amount
      const nftId = await openLong(pool, trader1, LONG_NOTIONAL);
      const pos   = await positionNFT.getPosition(nftId);
      expect(pos.lockedAmount).to.equal(lockedWithFee);

      // Pump the price so the long is in-the-money
      await pool.connect(trader1).swap(SWAP_IN_USDC, 0n, false);

      // ── SWAP-3 fee verification ──────────────────────────────────────────
      // After one open position + one USDC→PEPE swap:
      //   backedAirMeme = airMeme.totalSupply() − lockedAmount  (identity holds)
      // so backedAirMeme is the correct SWAP-3 reserveIn.
      const reserveIn  = await pool.backedAirMeme();
      const reserveOut = await pool.backedAirUsd();

      const airUsdWithFee    = cpOut(pos.lockedAmount, reserveIn, reserveOut);      // 100 bps
      const airUsdWithoutFee = cpOut(pos.lockedAmount, reserveIn, reserveOut, 0n);  //   0 bps
      expect(airUsdWithFee).to.be.lt(airUsdWithoutFee);

      // The contract returns the surplus minus the 1% close fee to the holder.
      const usdcBefore = await usdc.balanceOf(trader1.address);
      await pool.connect(trader1).closeLong(nftId, 0n);
      const actualProfit   = (await usdc.balanceOf(trader1.address)) - usdcBefore;
      const grossSurplus   = airUsdWithFee - pos.airUsdMinted;
      const closeFee       = (grossSurplus * 100n) / 10_000n; // CLOSE_FEE_BPS = 100
      const expectedProfit = grossSurplus - closeFee;
      expect(actualProfit).to.equal(expectedProfit);
    });

    it("step 1 — only the 5% fee is pulled from the trader (not the notional)", async function () {
      const { pool, usdc, trader1 } = await loadFixture(deployPoolFixture);

      const usdcBefore = await usdc.balanceOf(trader1.address);
      await openLong(pool, trader1, LONG_NOTIONAL);

      expect(usdcBefore - await usdc.balanceOf(trader1.address)).to.equal(LONG_FEE);
    });

    it("step 2 — USDC→PEPE swap burns airMeme, reducing totalSupply by ~50%", async function () {
      const { pool, memeToken, usdc, trader1 } = await loadFixture(deployPoolFixture);

      await openLong(pool, trader1, LONG_NOTIONAL);
      const backedMemeBefore = await pool.backedAirMeme();

      const memeBefore = await memeToken.balanceOf(trader1.address);
      await pool.connect(trader1).swap(SWAP_IN_USDC, 0n, false);
      const memeOut = (await memeToken.balanceOf(trader1.address)) - memeBefore;

      // ~497k PEPE out of ~999k backed (standard pool handles the swap without
      // supply implosion — contrast with thin pool where >90% is consumed)
      expect(memeOut).to.be.gt(ethers.parseEther("400000"));
      expect(memeOut).to.be.lt(backedMemeBefore); // cannot exceed what was backed

      // USDC side grew by the full swap input
      expect(await pool.backedAirUsd()).to.be.gt(ethers.parseUnits("19000", 6));
    });

    it("step 3 — close long yields a small positive profit bounded below $100", async function () {
      const { pool, usdc, trader1 } = await loadFixture(deployPoolFixture);

      const nftId = await openLong(pool, trader1, LONG_NOTIONAL);
      await pool.connect(trader1).swap(SWAP_IN_USDC, 0n, false);

      const usdcBeforeClose = await usdc.balanceOf(trader1.address);
      await pool.connect(trader1).closeLong(nftId, 0n);
      const profit = (await usdc.balanceOf(trader1.address)) - usdcBeforeClose;

      // Profit is positive (price roughly doubled) but small (~$28):
      // airMeme supply only halved so SWAP-3's denominator is still large.
      // This is what keeps the full sequence net negative.
      expect(profit).to.be.gt(0n);
      expect(profit).to.be.lt(ethers.parseUnits("100", 6));
    });

    it("step 4 — PEPE reswap recovers most but not all of the swap cost", async function () {
      const { pool, memeToken, usdc, trader1 } = await loadFixture(deployPoolFixture);

      const memeBefore = await memeToken.balanceOf(trader1.address);
      const nftId      = await openLong(pool, trader1, LONG_NOTIONAL);
      await pool.connect(trader1).swap(SWAP_IN_USDC, 0n, false);
      const memeReceived = (await memeToken.balanceOf(trader1.address)) - memeBefore;

      await pool.connect(trader1).closeLong(nftId, 0n);

      const usdcBeforeReswap = await usdc.balanceOf(trader1.address);
      await pool.connect(trader1).swap(memeReceived, 0n, true);
      const usdcFromReswap = (await usdc.balanceOf(trader1.address)) - usdcBeforeReswap;

      // Round-trip slippage means the reswap always returns less than was put in
      expect(usdcFromReswap).to.be.gt(ethers.parseUnits("8000", 6));
      expect(usdcFromReswap).to.be.lt(SWAP_IN_USDC);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Minimal fixture used by extra view / coverage tests above that need fresh
// factory+pool without pre-existing open positions.
// ─────────────────────────────────────────────────────────────────────────────

async function deployFactoryFixtureForPool() {
  const [deployer, treasury, creator, trader1] = await ethers.getSigners();

  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const memeToken = (await MockERC20F.connect(deployer).deploy("PEPE", "PEPE", 18)) as MockERC20;
  const usdc      = (await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6)) as MockERC20;
  const positionNFT = (await (await ethers.getContractFactory("PositionNFT"))
    .connect(deployer).deploy()) as PositionNFT;

  const { factory, lpNft } = await deploySystem(treasury.address, await positionNFT.getAddress(), await usdc.getAddress());
  const factoryAddr = await factory.getAddress();

  await memeToken.mint(creator.address, INITIAL_MEME * 5n);
  await usdc.mint(creator.address, INITIAL_USDC * 5n);
  await memeToken.connect(creator).approve(factoryAddr, ethers.MaxUint256);
  await usdc.connect(creator).approve(factoryAddr, ethers.MaxUint256);

  await usdc.mint(trader1.address, INITIAL_USDC * 2n);

  return { factory, positionNFT, lpNft, memeToken, usdc, deployer, treasury, creator, trader1 };
}
