import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
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
const MAX_POS_USD  = ethers.parseUnits("5000", 6);  // 5,000 USDC hard cap
const MAX_POS_BPS  = 500n;                          // 5 % of backedAirUsd
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

  // Fund creators and approve factory
  const factoryAddr = await factory.getAddress();
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
    INITIAL_TOKEN,
    MAX_POS_USD,
    MAX_POS_BPS
  );
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

    it("stores defaultSwapFeeBps as an immutable", async function () {
      const { factory } = await loadFixture(deployFactoryFixture);
      expect(await factory.defaultSwapFeeBps()).to.equal(SWAP_FEE_BPS);
    });

    it("starts with zero pools in the registry", async function () {
      const { factory } = await loadFixture(deployFactoryFixture);
      expect(await factory.allPoolsLength()).to.equal(0n);
    });

    it("reverts when positionNFT_ is the zero address", async function () {
      const FactoryF = await ethers.getContractFactory("EXNIHILOFactory");
      const { factory, lpNft, usdc } = await loadFixture(deployFactoryFixture);
      await expect(
        FactoryF.deploy(
          ethers.ZeroAddress,
          await lpNft.getAddress(),
          await usdc.getAddress(),
          (await ethers.getSigners())[1].address,
          SWAP_FEE_BPS
        )
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("reverts when lpNftContract_ is the zero address", async function () {
      const FactoryF = await ethers.getContractFactory("EXNIHILOFactory");
      const { factory, positionNFT, usdc } = await loadFixture(deployFactoryFixture);
      await expect(
        FactoryF.deploy(
          await positionNFT.getAddress(),
          ethers.ZeroAddress,
          await usdc.getAddress(),
          (await ethers.getSigners())[1].address,
          SWAP_FEE_BPS
        )
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("reverts when usdc_ is the zero address", async function () {
      const FactoryF = await ethers.getContractFactory("EXNIHILOFactory");
      const { factory, positionNFT, lpNft } = await loadFixture(deployFactoryFixture);
      await expect(
        FactoryF.deploy(
          await positionNFT.getAddress(),
          await lpNft.getAddress(),
          ethers.ZeroAddress,
          (await ethers.getSigners())[1].address,
          SWAP_FEE_BPS
        )
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("reverts when protocolTreasury_ is the zero address", async function () {
      const FactoryF = await ethers.getContractFactory("EXNIHILOFactory");
      const { factory, positionNFT, lpNft, usdc } = await loadFixture(deployFactoryFixture);
      await expect(
        FactoryF.deploy(
          await positionNFT.getAddress(),
          await lpNft.getAddress(),
          await usdc.getAddress(),
          ethers.ZeroAddress,
          SWAP_FEE_BPS
        )
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
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
          INITIAL_TOKEN,
          MAX_POS_USD,
          MAX_POS_BPS
        )
      )
        .to.emit(factory, "MarketCreated")
        .withArgs(
          (v: string) => v !== ethers.ZeroAddress,
          await baseToken.getAddress(),
          INITIAL_USDC,
          INITIAL_TOKEN,
          0n,
          creator.address,
          MAX_POS_USD,
          MAX_POS_BPS
        );
    });

    it("returns a pool address and lpNftId via staticCall", async function () {
      const { factory, creator, baseToken } =
        await loadFixture(deployFactoryFixture);

      const [pool, lpNftId] = await factory.connect(creator).createMarket.staticCall(
        await baseToken.getAddress(),
        INITIAL_USDC,
        INITIAL_TOKEN,
        MAX_POS_USD,
        MAX_POS_BPS
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

    it("registers the pool in poolForToken", async function () {
      const { factory, poolAddress, baseToken } = await loadFixture(withOneMarketFixture);
      expect(await factory.poolForToken(await baseToken.getAddress())).to.equal(poolAddress);
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

    it("pool's airToken token is named correctly", async function () {
      const { poolAddress } = await loadFixture(withOneMarketFixture);
      const pool = await ethers.getContractAt("EXNIHILOPool", poolAddress);
      const airToken = await ethers.getContractAt("AirToken", await pool.airToken());
      expect(await airToken.name()).to.equal("airPEPE");
      expect(await airToken.symbol()).to.equal("airPEPE");
    });

    it("pool's airUsd token is named correctly", async function () {
      const { poolAddress } = await loadFixture(withOneMarketFixture);
      const pool = await ethers.getContractAt("EXNIHILOPool", poolAddress);
      const airUsd = await ethers.getContractAt("AirToken", await pool.airUsdToken());
      expect(await airUsd.name()).to.equal("airPEPEUsd");
      expect(await airUsd.symbol()).to.equal("airPEPEUsd");
    });

    it("pool's maxPositionUsd is set correctly", async function () {
      const { poolAddress } = await loadFixture(withOneMarketFixture);
      const pool = await ethers.getContractAt("EXNIHILOPool", poolAddress);
      expect(await pool.maxPositionUsd()).to.equal(MAX_POS_USD);
    });

    it("pool's maxPositionBps is set correctly", async function () {
      const { poolAddress } = await loadFixture(withOneMarketFixture);
      const pool = await ethers.getContractAt("EXNIHILOPool", poolAddress);
      expect(await pool.maxPositionBps()).to.equal(MAX_POS_BPS);
    });

    it("pool's swapFeeBps matches factory's defaultSwapFeeBps", async function () {
      const { factory, poolAddress } = await loadFixture(withOneMarketFixture);
      const pool = await ethers.getContractAt("EXNIHILOPool", poolAddress);
      expect(await pool.swapFeeBps()).to.equal(await factory.defaultSwapFeeBps());
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
        factory.connect(creator).createMarket(ethers.ZeroAddress, INITIAL_USDC, INITIAL_TOKEN, 0n, 0n)
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("reverts when usdcAmount is zero", async function () {
      const { factory, creator, baseToken } = await loadFixture(deployFactoryFixture);
      await expect(
        factory.connect(creator).createMarket(await baseToken.getAddress(), 0n, INITIAL_TOKEN, 0n, 0n)
      ).to.be.revertedWithCustomError(factory, "ZeroAmount");
    });

    it("reverts when tokenAmount is zero", async function () {
      const { factory, creator, baseToken } = await loadFixture(deployFactoryFixture);
      await expect(
        factory.connect(creator).createMarket(await baseToken.getAddress(), INITIAL_USDC, 0n, 0n, 0n)
      ).to.be.revertedWithCustomError(factory, "ZeroAmount");
    });

    it("reverts when maxPositionBps is 5 (below minimum of 10)", async function () {
      const { factory, creator, baseToken } = await loadFixture(deployFactoryFixture);
      await expect(
        factory.connect(creator).createMarket(await baseToken.getAddress(), INITIAL_USDC, INITIAL_TOKEN, 0n, 5n)
      ).to.be.revertedWithCustomError(factory, "InvalidMaxPositionBps");
    });

    it("reverts when maxPositionBps is 9901 (above maximum of 9900)", async function () {
      const { factory, creator, baseToken } = await loadFixture(deployFactoryFixture);
      await expect(
        factory.connect(creator).createMarket(await baseToken.getAddress(), INITIAL_USDC, INITIAL_TOKEN, 0n, 9901n)
      ).to.be.revertedWithCustomError(factory, "InvalidMaxPositionBps");
    });

    it("accepts maxPositionBps of 10 (minimum boundary)", async function () {
      const { factory, creator, baseToken } = await loadFixture(deployFactoryFixture);
      await expect(
        factory.connect(creator).createMarket(await baseToken.getAddress(), INITIAL_USDC, INITIAL_TOKEN, 0n, 10n)
      ).to.emit(factory, "MarketCreated");
    });

    it("accepts maxPositionBps of 9900 (maximum boundary)", async function () {
      const { factory, creator, usdc } = await loadFixture(deployFactoryFixture);
      const MockF = await ethers.getContractFactory("MockERC20");
      const token2 = await MockF.deploy("DOGE", "DOGE", 18);
      await (token2 as unknown as MockERC20).mint(creator.address, INITIAL_TOKEN);
      await (token2 as any).connect(creator).approve(await factory.getAddress(), ethers.MaxUint256);
      await expect(
        factory.connect(creator).createMarket(await token2.getAddress(), INITIAL_USDC, INITIAL_TOKEN, 0n, 9900n)
      ).to.emit(factory, "MarketCreated");
    });

    it("accepts maxPositionBps of 0 (disabled)", async function () {
      const { factory, creator, baseToken } = await loadFixture(deployFactoryFixture);
      await expect(
        factory.connect(creator).createMarket(await baseToken.getAddress(), INITIAL_USDC, INITIAL_TOKEN, 0n, 0n)
      ).to.emit(factory, "MarketCreated");
    });
  });

  // ── 4. createMarket — multiple markets ────────────────────────────────────

  describe("createMarket — multiple markets", function () {
    it("allPoolsLength increments for each market", async function () {
      const { factory, creator, creator2, baseToken, usdc } =
        await loadFixture(deployFactoryFixture);

      const MockF = await ethers.getContractFactory("MockERC20");
      const token2 = await MockF.deploy("DOGE", "DOGE", 18) as unknown as MockERC20;
      await token2.mint(creator2.address, INITIAL_TOKEN);
      await token2.connect(creator2).approve(await factory.getAddress(), ethers.MaxUint256);

      await factory.connect(creator).createMarket(await baseToken.getAddress(), INITIAL_USDC, INITIAL_TOKEN, 0n, 0n);
      expect(await factory.allPoolsLength()).to.equal(1n);

      await factory.connect(creator2).createMarket(await token2.getAddress(), INITIAL_USDC, INITIAL_TOKEN, 0n, 0n);
      expect(await factory.allPoolsLength()).to.equal(2n);
    });

    it("LP NFT IDs increment (first = 0, second = 1)", async function () {
      const { factory, creator, creator2, baseToken, usdc, lpNft } =
        await loadFixture(deployFactoryFixture);

      await factory.connect(creator).createMarket(await baseToken.getAddress(), INITIAL_USDC, INITIAL_TOKEN, 0n, 0n);
      expect(await lpNft.ownerOf(0n)).to.equal(creator.address);

      const MockF = await ethers.getContractFactory("MockERC20");
      const token2 = await MockF.deploy("SHIB", "SHIB", 18) as unknown as MockERC20;
      await token2.mint(creator2.address, INITIAL_TOKEN);
      await token2.connect(creator2).approve(await factory.getAddress(), ethers.MaxUint256);

      await factory.connect(creator2).createMarket(await token2.getAddress(), INITIAL_USDC, INITIAL_TOKEN, 0n, 0n);
      expect(await lpNft.ownerOf(1n)).to.equal(creator2.address);
    });

    it("second market for the same token does NOT overwrite poolForToken", async function () {
      const { factory, creator, creator2, baseToken } =
        await loadFixture(deployFactoryFixture);

      await factory.connect(creator).createMarket(await baseToken.getAddress(), INITIAL_USDC, INITIAL_TOKEN, 0n, 0n);
      const firstPool = await factory.poolForToken(await baseToken.getAddress());

      await factory.connect(creator2).createMarket(await baseToken.getAddress(), INITIAL_USDC, INITIAL_TOKEN, 0n, 0n);

      expect(await factory.poolForToken(await baseToken.getAddress())).to.equal(firstPool);
    });

    it("both pools are registered in isPool", async function () {
      const { factory, creator, creator2, baseToken } =
        await loadFixture(deployFactoryFixture);

      await factory.connect(creator).createMarket(await baseToken.getAddress(), INITIAL_USDC, INITIAL_TOKEN, 0n, 0n);
      await factory.connect(creator2).createMarket(await baseToken.getAddress(), INITIAL_USDC, INITIAL_TOKEN, 0n, 0n);

      const pool1 = await factory.allPools(0n);
      const pool2 = await factory.allPools(1n);
      expect(await factory.isPool(pool1)).to.be.true;
      expect(await factory.isPool(pool2)).to.be.true;
      expect(pool1).to.not.equal(pool2);
    });
  });

  // ── 5. allPoolsLength view ─────────────────────────────────────────────────

  describe("allPoolsLength", function () {
    it("returns 0 before any market is created", async function () {
      const { factory } = await loadFixture(deployFactoryFixture);
      expect(await factory.allPoolsLength()).to.equal(0n);
    });

    it("returns 1 after one market is created", async function () {
      const { factory } = await loadFixture(withOneMarketFixture);
      expect(await factory.allPoolsLength()).to.equal(1n);
    });

    it("non-pool address returns false from isPool", async function () {
      const { factory, other } = await loadFixture(withOneMarketFixture);
      expect(await factory.isPool(other.address)).to.be.false;
    });
  });

  // ── 6. _safeSymbol / _safeDecimals fallback branches ──────────────────────

  describe("_safeSymbol / _safeDecimals fallback", function () {
    it("falls back to 'TOKEN' when token has no symbol()", async function () {
      // NoMetaERC20 has no symbol() or decimals() — factory falls back to "TOKEN" / 18.
      const { factory, usdc, creator } = await loadFixture(deployFactoryFixture);

      const NoMetaF = await ethers.getContractFactory("NoMetaERC20");
      const noMeta  = await NoMetaF.deploy();
      await (noMeta as any).mint(creator.address, INITIAL_TOKEN);
      await (noMeta as any).connect(creator).approve(await factory.getAddress(), ethers.MaxUint256);
      await usdc.connect(creator).approve(await factory.getAddress(), ethers.MaxUint256);

      const tx = await factory.connect(creator).createMarket(
        await noMeta.getAddress(),
        INITIAL_USDC,
        INITIAL_TOKEN,
        0n,
        0n
      );
      const receipt = await tx.wait();
      const iface = factory.interface;
      const log = receipt!.logs
        .map((l) => { try { return iface.parseLog(l); } catch { return null; } })
        .find((l) => l?.name === "MarketCreated")!;

      const pool = await ethers.getContractAt("EXNIHILOPool", log.args.pool as string);
      const airToken = await ethers.getContractAt("AirToken", await pool.airToken());
      const airUsd  = await ethers.getContractAt("AirToken", await pool.airUsdToken());

      // Fallback symbol used as name
      expect(await airToken.name()).to.equal("airTOKEN");
      expect(await airUsd.name()).to.equal("airTOKENUsd");
    });
  });
});
