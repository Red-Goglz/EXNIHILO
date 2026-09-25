import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import {
  EXNIHILOFactory,
  LpNFT,
  PositionNFT,
  MockERC20,
} from "../typechain-types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const INITIAL_USDC = ethers.parseUnits("10000", 6); // 10,000 USDC
const INITIAL_TOKEN = ethers.parseEther("1000000");  // 1,000,000 token
const SWAP_FEE_BPS = 100n;                          // 1 %

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
 * LpNFT.factory is set to msg.sender at construction time (immutable).
 * EXNIHILOFactory.createMarket() calls lpNftContract.mint(), which requires
 * msg.sender == lpNft.factory.  Therefore LpNFT.factory must equal the
 * EXNIHILOFactory address.
 *
 * Bytecode-patch strategy (avoids EIP-161 nonce conflict):
 *   signers[7] = throwaway signer — deploys LpNFT (LpNFT.factory = throwaway)
 *   signers[8] = sysDeployer      — deploys EXNIHILOFactory
 *   After factory deploy, patch LpNFT bytecode to replace throwaway with factory.
 */
async function deploySystem(
  treasuryAddr: string,
  positionNFTAddr: string,
  usdcAddr: string
): Promise<{ factory: EXNIHILOFactory; lpNft: LpNFT }> {
  const signers = await ethers.getSigners();
  const throwaway   = signers[7]; // temporary LpNFT deployer
  const sysDeployer = signers[8]; // factory deployer

  // Deploy LpNFT with throwaway.address as factory (will be patched to real factory below)
  const lpNft = (await (await ethers.getContractFactory("LpNFT"))
    .connect(throwaway)
    .deploy(throwaway.address)) as unknown as LpNFT;

  const poolDeployer = await (await ethers.getContractFactory("PoolDeployer")).connect(sysDeployer).deploy();

  // Deploy EXNIHILOFactory from sysDeployer
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

  // Patch LpNFT bytecode: replace throwaway.address with factory address
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
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

async function deployFactoryFixture() {
  // signers[0]=deployer [1]=treasury [2]=creator [3]=creator2 [4]=other
  // signers[7]=throwaway (LpNFT deployer) [8]=sysDeployer (factory deployer)
  const [deployer, treasury, creator, creator2, other] = await ethers.getSigners();

  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const baseToken  = (await MockERC20F.connect(deployer).deploy("PEPE", "PEPE", 18)) as unknown as MockERC20;
  const usdc       = (await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6)) as unknown as MockERC20;
  const positionNFT = (await (await ethers.getContractFactory("PositionNFT"))
    .connect(deployer)
    .deploy()) as unknown as PositionNFT;

  const { factory, lpNft } = await deploySystem(
    treasury.address,
    await positionNFT.getAddress(),
    await usdc.getAddress()
  );

  // Wire PositionNFT to factory so only registered pools can mint positions
  const factoryAddr = await factory.getAddress();
  await positionNFT.connect(deployer).initFactory(factoryAddr);

  // Fund creators and approve factory
  await baseToken.mint(creator.address,  INITIAL_TOKEN * 3n);
  await usdc.mint(creator.address,       INITIAL_USDC * 3n);
  await baseToken.connect(creator).approve(factoryAddr, ethers.MaxUint256);
  await usdc.connect(creator).approve(factoryAddr, ethers.MaxUint256);

  await baseToken.mint(creator2.address, INITIAL_TOKEN * 3n);
  await usdc.mint(creator2.address,      INITIAL_USDC * 3n);
  await baseToken.connect(creator2).approve(factoryAddr, ethers.MaxUint256);
  await usdc.connect(creator2).approve(factoryAddr, ethers.MaxUint256);

  return { factory, positionNFT, lpNft, baseToken, usdc, deployer, treasury, creator, creator2, other };
}

async function withOneMarketFixture() {
  const base = await deployFactoryFixture();
  const { factory, creator, baseToken } = base;

  const tx = await factory.connect(creator).createMarket(
    await baseToken.getAddress(),
    INITIAL_USDC,
    INITIAL_TOKEN);
  // Position caps ramp 1 %→20 % over 24 h. These tests are not about
  // caps, so start past the ramp where size is not the constraint.
  await time.increase(24 * 3600);
  const receipt = await tx.wait();

  const iface = factory.interface;
  const log = receipt!.logs
    .map((l) => { try { return iface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "MarketCreated")!;

  return { ...base, poolAddress: log.args.pool as string, lpNftId: log.args.lpNftId as bigint };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("EXNIHILOFactory", function () {

  // ── 1. Deployment ──────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("stores positionNFT as an immutable", async function () {
      const { factory, positionNFT } = await loadFixture(deployFactoryFixture);
      expect(await factory.positionNFT()).to.equal(await positionNFT.getAddress());
    });

    it("stores lpNftContract as an immutable", async function () {
      const { factory, lpNft } = await loadFixture(deployFactoryFixture);
      expect(await factory.lpNftContract()).to.equal(await lpNft.getAddress());
    });

    it("stores usdc as an immutable", async function () {
      const { factory, usdc } = await loadFixture(deployFactoryFixture);
      expect(await factory.usdc()).to.equal(await usdc.getAddress());
    });

    it("stores protocolTreasury as an immutable", async function () {
      const { factory, treasury } = await loadFixture(deployFactoryFixture);
      expect(await factory.protocolTreasury()).to.equal(treasury.address);
    });

    it("has no defaultSwapFeeBps — the pool fee is a constant, not a factory setting", async function () {
      const { factory } = await loadFixture(deployFactoryFixture);
      const fns = factory.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => (f as { name: string }).name);
      expect(fns).to.not.include("defaultSwapFeeBps");
    });


  });

  // ── 2. createMarket — happy path ───────────────────────────────────────────

  describe("createMarket — happy path", function () {
    it("emits MarketCreated with correct fields", async function () {
      const { factory, creator, baseToken } =
        await loadFixture(deployFactoryFixture);

      await expect(
        factory.connect(creator).createMarket(
          await baseToken.getAddress(),
          INITIAL_USDC,
          INITIAL_TOKEN)
      )
        .to.emit(factory, "MarketCreated")
        .withArgs(
          (v: string) => v !== ethers.ZeroAddress,
          await baseToken.getAddress(),
          creator.address,
          0n
        );
    });

    it("returns a pool address and lpNftId via staticCall", async function () {
      const { factory, creator, baseToken } =
        await loadFixture(deployFactoryFixture);

      const [pool, lpNftId] = await factory.connect(creator).createMarket.staticCall(
        await baseToken.getAddress(),
        INITIAL_USDC,
        INITIAL_TOKEN
      );

      expect(pool).to.not.equal(ethers.ZeroAddress);
      expect(lpNftId).to.equal(0n);
    });

    it("registers the pool in isPool", async function () {
      const { factory, poolAddress } = await loadFixture(withOneMarketFixture);
      expect(await factory.isPool(poolAddress)).to.be.true;
    });

    it("registers the pool in allPools", async function () {
      const { factory, poolAddress } = await loadFixture(withOneMarketFixture);
      expect(await factory.allPools(0n)).to.equal(poolAddress);
    });

    it("transfers the LP NFT to the creator", async function () {
      const { lpNft, creator, lpNftId } = await loadFixture(withOneMarketFixture);
      expect(await lpNft.ownerOf(lpNftId)).to.equal(creator.address);
    });

    it("pool has the correct backed token reserve", async function () {
      const { poolAddress } = await loadFixture(withOneMarketFixture);
      const pool = await ethers.getContractAt("EXNIHILOPool", poolAddress);
      expect(await pool.backedAirToken()).to.equal(INITIAL_TOKEN);
    });

    it("pool has the correct backed USDC reserve", async function () {
      const { poolAddress } = await loadFixture(withOneMarketFixture);
      const pool = await ethers.getContractAt("EXNIHILOPool", poolAddress);
      expect(await pool.backedAirUsd()).to.equal(INITIAL_USDC);
    });

    it("pool's tokenDecimals matches the underlying token", async function () {
      const { poolAddress } = await loadFixture(withOneMarketFixture);
      const pool = await ethers.getContractAt("EXNIHILOPool", poolAddress);
      expect(await pool.tokenDecimals()).to.equal(18n);
    });

    it("pool's supply counters equal the seeded liquidity", async function () {
      const { poolAddress } = await loadFixture(withOneMarketFixture);
      const pool = await ethers.getContractAt("EXNIHILOPool", poolAddress);
      expect(await pool.airTokenSupply()).to.equal(INITIAL_TOKEN);
      expect(await pool.airUsdSupply()).to.equal(INITIAL_USDC);
    });

    it("pool sets its own position cap — no parameter, no setter", async function () {
      const { poolAddress } = await loadFixture(withOneMarketFixture);
      const pool = await ethers.getContractAt("EXNIHILOPool", poolAddress);

      // The fixture advances past the 24 h ramp, so the cap is at its ceiling.
      // The 1 % start and the ramp itself are covered in EXNIHILOPool.ts.
      expect(await pool.currentMaxPositionBps()).to.equal(2000n);
      expect(await pool.createdAt()).to.be.greaterThan(0n);

      const fns = pool.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => (f as { name: string }).name);
      expect(fns).to.not.include("setPositionCaps");
      expect(fns).to.not.include("maxPositionUsd");
    });

    it("pool's swapFeeBps is the fixed 1 %, whatever the factory was given", async function () {
      const { poolAddress } = await loadFixture(withOneMarketFixture);
      const pool = await ethers.getContractAt("EXNIHILOPool", poolAddress);
      expect(await pool.swapFeeBps()).to.equal(SWAP_FEE_BPS);
    });

    it("pool's protocolTreasury matches factory's protocolTreasury", async function () {
      const { factory, poolAddress } = await loadFixture(withOneMarketFixture);
      const pool = await ethers.getContractAt("EXNIHILOPool", poolAddress);
      expect(await pool.protocolTreasury()).to.equal(await factory.protocolTreasury());
    });
  });

  // ── 3. createMarket — validation ──────────────────────────────────────────

  describe("createMarket — validation", function () {
    it("reverts when tokenAddress is the zero address", async function () {
      const { factory, creator } = await loadFixture(deployFactoryFixture);
      await expect(
        factory.connect(creator).createMarket(ethers.ZeroAddress, INITIAL_USDC, INITIAL_TOKEN)
      ).to.be.reverted;
    });


  });

  // ── 4. createMarket — multiple markets ────────────────────────────────────

  describe("createMarket — multiple markets", function () {
    it("LP NFT IDs increment (first = 0, second = 1)", async function () {
      const { factory, creator, creator2, baseToken, usdc, lpNft } =
        await loadFixture(deployFactoryFixture);

      await factory.connect(creator).createMarket(await baseToken.getAddress(), INITIAL_USDC, INITIAL_TOKEN);
      // Position caps ramp 1 %→20 % over 24 h. These tests are not about
      // caps, so start past the ramp where size is not the constraint.
      await time.increase(24 * 3600);
      expect(await lpNft.ownerOf(0n)).to.equal(creator.address);

      const MockF = await ethers.getContractFactory("MockERC20");
      const token2 = await MockF.deploy("SHIB", "SHIB", 18) as unknown as MockERC20;
      await token2.mint(creator2.address, INITIAL_TOKEN);
      await token2.connect(creator2).approve(await factory.getAddress(), ethers.MaxUint256);

      await factory.connect(creator2).createMarket(await token2.getAddress(), INITIAL_USDC, INITIAL_TOKEN);
      // Position caps ramp 1 %→20 % over 24 h. These tests are not about
      // caps, so start past the ramp where size is not the constraint.
      await time.increase(24 * 3600);
      expect(await lpNft.ownerOf(1n)).to.equal(creator2.address);
    });

    it("both pools are registered in isPool", async function () {
      const { factory, creator, creator2, baseToken } =
        await loadFixture(deployFactoryFixture);

      await factory.connect(creator).createMarket(await baseToken.getAddress(), INITIAL_USDC, INITIAL_TOKEN);
      // Position caps ramp 1 %→20 % over 24 h. These tests are not about
      // caps, so start past the ramp where size is not the constraint.
      await time.increase(24 * 3600);
      await factory.connect(creator2).createMarket(await baseToken.getAddress(), INITIAL_USDC, INITIAL_TOKEN);
      // Position caps ramp 1 %→20 % over 24 h. These tests are not about
      // caps, so start past the ramp where size is not the constraint.
      await time.increase(24 * 3600);

      const pool1 = await factory.allPools(0n);
      const pool2 = await factory.allPools(1n);
      expect(await factory.isPool(pool1)).to.be.true;
      expect(await factory.isPool(pool2)).to.be.true;
      expect(pool1).to.not.equal(pool2);
    });
  });

  // ── 5. decimals() fallback branch ──────────────────────────────────────────

  describe("tokenDecimals fallback", function () {
    it("falls back to 18 when token has no decimals()", async function () {
      // NoMetaERC20 has no symbol() or decimals() — factory falls back to 18.
      const { factory, usdc, creator } = await loadFixture(deployFactoryFixture);

      const NoMetaF = await ethers.getContractFactory("NoMetaERC20");
      const noMeta  = await NoMetaF.deploy();
      await (noMeta as any).mint(creator.address, INITIAL_TOKEN);
      await (noMeta as any).connect(creator).approve(await factory.getAddress(), ethers.MaxUint256);
      await usdc.connect(creator).approve(await factory.getAddress(), ethers.MaxUint256);

      const tx = await factory.connect(creator).createMarket(
        await noMeta.getAddress(),
        INITIAL_USDC,
        INITIAL_TOKEN);
      // Position caps ramp 1 %→20 % over 24 h. These tests are not about
      // caps, so start past the ramp where size is not the constraint.
      await time.increase(24 * 3600);
      const receipt = await tx.wait();
      const iface = factory.interface;
      const log = receipt!.logs
        .map((l) => { try { return iface.parseLog(l); } catch { return null; } })
        .find((l) => l?.name === "MarketCreated")!;

      const pool = await ethers.getContractAt("EXNIHILOPool", log.args.pool as string);
      expect(await pool.tokenDecimals()).to.equal(18n);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Audit PU-001 — PoolDeployer had no caller check at all.
//
// The pool it builds is inert unless the factory registers it, so the risk was
// never a usable orphan pool. It was that anyone could build one NAMING the
// real factory while that factory has never heard of it. (The pool then read
// factory.deployer() for emergency-close authority; that role is gone, but a
// pool's `factory` should still name its real creator.)
// ═════════════════════════════════════════════════════════════════════════════

describe("PoolDeployer — caller must name itself", () => {
  it("rejects a pool built in the name of a factory that is not the caller", async () => {
    const [deployer, treasury, attacker] = await ethers.getSigners();

    const poolDeployer = await (await ethers.getContractFactory("PoolDeployer"))
      .connect(deployer).deploy();
    const token = await (await ethers.getContractFactory("MockERC20"))
      .connect(deployer).deploy("PEPE", "PEPE", 18);
    const usdc = await (await ethers.getContractFactory("MockERC20"))
      .connect(deployer).deploy("USD Coin", "USDC", 6);
    const positionNFT = await (await ethers.getContractFactory("PositionNFT"))
      .connect(deployer).deploy();
    const lpNft = await (await ethers.getContractFactory("LpNFT"))
      .connect(deployer).deploy(deployer.address);

    // Some real factory the attacker wants the forged pool to point at.
    const victimFactory = await (await ethers.getContractFactory("EXNIHILOFactory"))
      .connect(deployer)
      .deploy(
        await positionNFT.getAddress(),
        await lpNft.getAddress(),
        await usdc.getAddress(),
        treasury.address,
        await poolDeployer.getAddress(),
      );

    await expect(
      poolDeployer.connect(attacker).deploy(
        await token.getAddress(),
        await usdc.getAddress(),
        18,
        await positionNFT.getAddress(),
        await lpNft.getAddress(),
        0n,
        treasury.address,
        await victimFactory.getAddress(), // not the caller
      )
    ).to.be.revertedWithCustomError(poolDeployer, "FactoryMismatch");
  });

  // The ordinary path is satisfied by createMarket passing address(this),
  // and is exercised by every other fixture in this suite and the wider
  // test set — a market is created before almost every assertion in them.

});

// ═════════════════════════════════════════════════════════════════════════════
// Audit PROCESS-002 — "The returned id must equal our prediction" was a comment
// and nothing else.
//
// The pool takes its LP NFT id as a CONSTRUCTOR argument, so the factory has to
// predict it (allPools.length) before minting. That id gates addLiquidity,
// removeLiquidity, claimFees and closePool through ownerOf — a pool built with
// the wrong one answers to somebody else's NFT for its entire life.
//
// The prediction is sound while this factory is LpNFT's sole minter, which is
// exactly why nothing ever tested the failure. It is now enforced, and this
// drives it from outside using a stand-in the real LpNFT cannot imitate.
// ═════════════════════════════════════════════════════════════════════════════

describe("EXNIHILOFactory — the LP NFT id prediction is checked, not assumed", () => {
  it("refuses to seed a market when LpNFT returns an unpredicted id", async () => {
    const [deployer, treasury, creator] = await ethers.getSigners();

    const MockERC20F = await ethers.getContractFactory("MockERC20");
    const baseToken = (await MockERC20F.connect(deployer)
      .deploy("PEPE", "PEPE", 18)) as unknown as MockERC20;
    const usdc = (await MockERC20F.connect(deployer)
      .deploy("USD Coin", "USDC", 6)) as unknown as MockERC20;

    const positionNFT = await (await ethers.getContractFactory("PositionNFT"))
      .connect(deployer).deploy();
    const poolDeployer = await (await ethers.getContractFactory("PoolDeployer"))
      .connect(deployer).deploy();

    // Hands back 999 where the factory predicts 0.
    const badLpNft = await (await ethers.getContractFactory("MisnumberingLpNFT"))
      .connect(deployer).deploy(999n);

    const factory = await (await ethers.getContractFactory("EXNIHILOFactory"))
      .connect(deployer)
      .deploy(
        await positionNFT.getAddress(),
        await badLpNft.getAddress(),
        await usdc.getAddress(),
        treasury.address,
        await poolDeployer.getAddress(),
      );
    const factoryAddr = await factory.getAddress();

    await baseToken.mint(creator.address, INITIAL_TOKEN);
    await usdc.mint(creator.address, INITIAL_USDC);
    await baseToken.connect(creator).approve(factoryAddr, ethers.MaxUint256);
    await usdc.connect(creator).approve(factoryAddr, ethers.MaxUint256);

    await expect(
      factory.connect(creator).createMarket(
        await baseToken.getAddress(), INITIAL_USDC, INITIAL_TOKEN)
    ).to.be.revertedWithCustomError(factory, "LpNftIdMismatch");

    // The whole transaction is refused: no market, and the seed never left the
    // creator. Seeding into a pool whose controls answer to the wrong NFT is
    // the outcome being prevented, so a partial one would be no better.
    expect(await factory.allPoolsLength()).to.equal(0n);
    expect(await baseToken.balanceOf(creator.address)).to.equal(INITIAL_TOKEN);
    expect(await usdc.balanceOf(creator.address)).to.equal(INITIAL_USDC);
  });
});
