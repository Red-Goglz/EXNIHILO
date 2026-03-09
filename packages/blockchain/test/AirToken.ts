import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { AirToken } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("AirToken", function () {
  // ── Fixtures ───────────────────────────────────────────────────────────────

  /**
   * Deploys AirToken as a meme-side wrapper (18 decimals).
   * The deployer acts as the factory; `pool` signer acts as the pool.
   */
  async function deployMemeTokenFixture() {
    const [factory, pool, other] = await ethers.getSigners();

    const AirToken = await ethers.getContractFactory("AirToken");
    const token: AirToken = await AirToken.connect(factory).deploy(
      "airPEPE",
      "airPEPE",
      18
    );

    return { token, factory, pool, other };
  }

  /**
   * Same as above but with pool already initialised — used by most tests.
   */
  async function deployAndInitFixture() {
    const { token, factory, pool, other } = await deployMemeTokenFixture();
    await token.connect(factory).initPool(pool.address);
    return { token, factory, pool, other };
  }

  /**
   * USDC-side wrapper (6 decimals).
   */
  async function deployUsdTokenFixture() {
    const [factory, pool] = await ethers.getSigners();

    const AirToken = await ethers.getContractFactory("AirToken");
    const token: AirToken = await AirToken.connect(factory).deploy(
      "airPEPEUsd",
      "airPEPEUsd",
      6
    );
    await token.connect(factory).initPool(pool.address);

    return { token, factory, pool };
  }

  // ── Deployment ─────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets name, symbol, and decimals correctly (meme side)", async function () {
      const { token } = await loadFixture(deployMemeTokenFixture);
      expect(await token.name()).to.equal("airPEPE");
      expect(await token.symbol()).to.equal("airPEPE");
      expect(await token.decimals()).to.equal(18);
    });

    it("sets name, symbol, and decimals correctly (USD side)", async function () {
      const { token } = await loadFixture(deployUsdTokenFixture);
      expect(await token.name()).to.equal("airPEPEUsd");
      expect(await token.symbol()).to.equal("airPEPEUsd");
      expect(await token.decimals()).to.equal(6);
    });

    it("stores the deployer as factory", async function () {
      const { token, factory } = await loadFixture(deployMemeTokenFixture);
      expect(await token.factory()).to.equal(factory.address);
    });

    it("initialises pool to the zero address before initPool", async function () {
      const { token } = await loadFixture(deployMemeTokenFixture);
      expect(await token.pool()).to.equal(ethers.ZeroAddress);
    });

    it("starts with zero total supply", async function () {
      const { token } = await loadFixture(deployMemeTokenFixture);
      expect(await token.totalSupply()).to.equal(0n);
    });
  });

  // ── initPool ───────────────────────────────────────────────────────────────

  describe("initPool", function () {
    it("sets pool address when called by factory", async function () {
      const { token, factory, pool } = await loadFixture(deployMemeTokenFixture);
      await token.connect(factory).initPool(pool.address);
      expect(await token.pool()).to.equal(pool.address);
    });

    it("reverts when called by a non-factory address", async function () {
      const { token, pool, other } = await loadFixture(deployMemeTokenFixture);
      await expect(token.connect(other).initPool(pool.address))
        .to.be.revertedWithCustomError(token, "OnlyFactory");
    });

    it("reverts when called a second time", async function () {
      const { token, factory, pool, other } =
        await loadFixture(deployMemeTokenFixture);
      await token.connect(factory).initPool(pool.address);
      await expect(token.connect(factory).initPool(other.address))
        .to.be.revertedWithCustomError(token, "PoolAlreadySet");
    });

    it("reverts when given the zero address", async function () {
      const { token, factory } = await loadFixture(deployMemeTokenFixture);
      await expect(token.connect(factory).initPool(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(token, "ZeroAddress");
    });
  });

  // ── mint ───────────────────────────────────────────────────────────────────

  describe("mint", function () {
    it("mints tokens to the specified address when called by pool", async function () {
      const { token, pool, other } = await loadFixture(deployAndInitFixture);
      await token.connect(pool).mint(other.address, 1000n);
      expect(await token.balanceOf(other.address)).to.equal(1000n);
      expect(await token.totalSupply()).to.equal(1000n);
    });

    it("emits a Transfer event from the zero address", async function () {
      const { token, pool, other } = await loadFixture(deployAndInitFixture);
      await expect(token.connect(pool).mint(other.address, 500n))
        .to.emit(token, "Transfer")
        .withArgs(ethers.ZeroAddress, other.address, 500n);
    });

    it("reverts when called by a non-pool address", async function () {
      const { token, other } = await loadFixture(deployAndInitFixture);
      await expect(token.connect(other).mint(other.address, 1000n))
        .to.be.revertedWithCustomError(token, "OnlyPool");
    });

    it("reverts when called by the factory after initPool", async function () {
      const { token, factory, other } = await loadFixture(deployAndInitFixture);
      await expect(token.connect(factory).mint(other.address, 1000n))
        .to.be.revertedWithCustomError(token, "OnlyPool");
    });

    it("reverts when pool is not yet initialised", async function () {
      const { token, pool, other } = await loadFixture(deployMemeTokenFixture);
      // pool signer is not the actual pool yet — initPool not called
      await expect(token.connect(pool).mint(other.address, 1000n))
        .to.be.revertedWithCustomError(token, "OnlyPool");
    });
  });

  // ── burn ───────────────────────────────────────────────────────────────────

  describe("burn", function () {
    async function deployWithBalanceFixture() {
      const { token, factory, pool, other } =
        await loadFixture(deployAndInitFixture);
      await token.connect(pool).mint(other.address, 2000n);
      return { token, factory, pool, other };
    }

    it("burns tokens from the specified address when called by pool", async function () {
      const { token, pool, other } = await loadFixture(deployWithBalanceFixture);
      await token.connect(pool).burn(other.address, 500n);
      expect(await token.balanceOf(other.address)).to.equal(1500n);
      expect(await token.totalSupply()).to.equal(1500n);
    });

    it("emits a Transfer event to the zero address", async function () {
      const { token, pool, other } = await loadFixture(deployWithBalanceFixture);
      await expect(token.connect(pool).burn(other.address, 500n))
        .to.emit(token, "Transfer")
        .withArgs(other.address, ethers.ZeroAddress, 500n);
    });

    it("reverts when called by a non-pool address", async function () {
      const { token, other } = await loadFixture(deployWithBalanceFixture);
      await expect(token.connect(other).burn(other.address, 500n))
        .to.be.revertedWithCustomError(token, "OnlyPool");
    });

    it("reverts when burning more than balance", async function () {
      const { token, pool, other } = await loadFixture(deployWithBalanceFixture);
      await expect(token.connect(pool).burn(other.address, 3000n))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
    });
  });

  // ── Standard ERC-20 behaviour ──────────────────────────────────────────────

  describe("ERC-20 transfers", function () {
    it("allows holders to transfer tokens freely", async function () {
      const { token, pool, other, factory } =
        await loadFixture(deployAndInitFixture);
      await token.connect(pool).mint(other.address, 1000n);
      await token.connect(other).transfer(factory.address, 400n);
      expect(await token.balanceOf(other.address)).to.equal(600n);
      expect(await token.balanceOf(factory.address)).to.equal(400n);
    });

    it("supports approve and transferFrom", async function () {
      const { token, pool, other, factory } =
        await loadFixture(deployAndInitFixture);
      await token.connect(pool).mint(other.address, 1000n);
      await token.connect(other).approve(factory.address, 300n);
      await token.connect(factory).transferFrom(other.address, factory.address, 300n);
      expect(await token.balanceOf(factory.address)).to.equal(300n);
    });
  });
});
