import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { AirToken, PositionNFT } from "../typechain-types";

describe("PositionNFT", function () {
  // ── Helpers ────────────────────────────────────────────────────────────────

  const LOCK_AMOUNT = ethers.parseUnits("100", 18); // airMeme locked in long
  const AIR_USD_MINTED = ethers.parseUnits("10", 6); // synthetic airUsd debt
  const USDC_IN = ethers.parseUnits("10", 6);
  const FEES_PAID = ethers.parseUnits("0.5", 6);

  const AIR_MEME_MINTED = ethers.parseUnits("500", 18); // synthetic airMeme debt
  const AIR_USD_LOCKED = ethers.parseUnits("9", 6); // airUsd locked in short

  // ── Fixtures ───────────────────────────────────────────────────────────────

  /**
   * Deploys PositionNFT and two AirTokens (airMeme 18dec, airUsd 6dec).
   * `pool` signer acts as the pool for both AirTokens and as msg.sender for
   * mintLong / mintShort calls.
   */
  async function baseFixture() {
    const [factory, pool, trader, other] = await ethers.getSigners();

    // Deploy and wire airMeme (18 decimals)
    const AirToken = await ethers.getContractFactory("AirToken");
    const airMeme: AirToken = await AirToken.connect(factory).deploy(
      "airPEPE",
      "airPEPE",
      18
    );
    await airMeme.connect(factory).initPool(pool.address);

    // Deploy and wire airUsd (6 decimals)
    const airUsd: AirToken = await AirToken.connect(factory).deploy(
      "airPEPEUsd",
      "airPEPEUsd",
      6
    );
    await airUsd.connect(factory).initPool(pool.address);

    // Deploy PositionNFT
    const PositionNFT = await ethers.getContractFactory("PositionNFT");
    const nft: PositionNFT = await PositionNFT.deploy();

    return { nft, airMeme, airUsd, factory, pool, trader, other };
  }

  /**
   * Extends baseFixture with a pool-side helper that mints wrapper tokens to
   * the pool, approves the NFT contract, and calls mintLong.
   */
  async function withLongPositionFixture() {
    const base = await baseFixture();
    const { nft, airMeme, pool, trader } = base;

    // Pool mints airMeme to itself, then approves and locks
    await airMeme.connect(pool).mint(pool.address, LOCK_AMOUNT);
    await airMeme.connect(pool).approve(await nft.getAddress(), LOCK_AMOUNT);

    const tx = await nft
      .connect(pool)
      .mintLong(
        trader.address,
        pool.address,
        await airMeme.getAddress(),
        USDC_IN,
        AIR_USD_MINTED,
        LOCK_AMOUNT,
        FEES_PAID
      );
    const receipt = await tx.wait();

    return { ...base, longTokenId: 0n };
  }

  async function withShortPositionFixture() {
    const base = await baseFixture();
    const { nft, airUsd, pool, trader } = base;

    await airUsd.connect(pool).mint(pool.address, AIR_USD_LOCKED);
    await airUsd.connect(pool).approve(await nft.getAddress(), AIR_USD_LOCKED);

    await nft
      .connect(pool)
      .mintShort(
        trader.address,
        pool.address,
        await airUsd.getAddress(),
        AIR_MEME_MINTED,
        AIR_USD_LOCKED,
        FEES_PAID
      );

    return { ...base, shortTokenId: 0n };
  }

  // ── Deployment ─────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("has correct name and symbol", async function () {
      const { nft } = await loadFixture(baseFixture);
      expect(await nft.name()).to.equal("EXNIHILO Position");
      expect(await nft.symbol()).to.equal("EXPOS");
    });
  });

  // ── mintLong ───────────────────────────────────────────────────────────────

  describe("mintLong", function () {
    it("mints the NFT to the trader", async function () {
      const { nft, trader } = await loadFixture(withLongPositionFixture);
      expect(await nft.ownerOf(0n)).to.equal(trader.address);
    });

    it("stores correct position data", async function () {
      const { nft, airMeme, pool } = await loadFixture(withLongPositionFixture);
      const pos = await nft.getPosition(0n);

      expect(pos.isLong).to.equal(true);
      expect(pos.pool).to.equal(pool.address);
      expect(pos.lockedToken).to.equal(await airMeme.getAddress());
      expect(pos.lockedAmount).to.equal(LOCK_AMOUNT);
      expect(pos.usdcIn).to.equal(USDC_IN);
      expect(pos.airUsdMinted).to.equal(AIR_USD_MINTED);
      expect(pos.airMemeMinted).to.equal(0n);
      expect(pos.feesPaid).to.equal(FEES_PAID);
    });

    it("records openedAt as current block timestamp", async function () {
      const { nft } = await loadFixture(withLongPositionFixture);
      const pos = await nft.getPosition(0n);
      const block = await ethers.provider.getBlock("latest");
      expect(pos.openedAt).to.equal(BigInt(block!.timestamp));
    });

    it("pulls airMeme into the NFT contract custody", async function () {
      const { nft, airMeme } = await loadFixture(withLongPositionFixture);
      expect(await airMeme.balanceOf(await nft.getAddress())).to.equal(
        LOCK_AMOUNT
      );
    });

    it("removes airMeme from the pool", async function () {
      const { airMeme, pool } = await loadFixture(withLongPositionFixture);
      expect(await airMeme.balanceOf(pool.address)).to.equal(0n);
    });

    it("increments token IDs for successive mints", async function () {
      const { nft, airMeme, airUsd, pool, trader } =
        await loadFixture(baseFixture);

      await airMeme.connect(pool).mint(pool.address, LOCK_AMOUNT * 2n);
      await airMeme
        .connect(pool)
        .approve(await nft.getAddress(), LOCK_AMOUNT * 2n);

      await nft
        .connect(pool)
        .mintLong(
          trader.address, pool.address, await airMeme.getAddress(),
          USDC_IN, AIR_USD_MINTED, LOCK_AMOUNT, FEES_PAID
        );
      await nft
        .connect(pool)
        .mintLong(
          trader.address, pool.address, await airMeme.getAddress(),
          USDC_IN, AIR_USD_MINTED, LOCK_AMOUNT, FEES_PAID
        );

      expect(await nft.ownerOf(0n)).to.equal(trader.address);
      expect(await nft.ownerOf(1n)).to.equal(trader.address);
    });

    it("reverts when msg.sender differs from pool argument", async function () {
      const { nft, airMeme, pool, other, trader } =
        await loadFixture(baseFixture);
      await airMeme.connect(pool).mint(pool.address, LOCK_AMOUNT);
      await airMeme.connect(pool).approve(await nft.getAddress(), LOCK_AMOUNT);

      await expect(
        nft
          .connect(other) // not `pool`
          .mintLong(
            trader.address, pool.address, await airMeme.getAddress(),
            USDC_IN, AIR_USD_MINTED, LOCK_AMOUNT, FEES_PAID
          )
      ).to.be.revertedWithCustomError(nft, "OnlyPool");
    });

    it("reverts when pool has not approved enough airMeme", async function () {
      const { nft, airMeme, pool, trader } = await loadFixture(baseFixture);
      await airMeme.connect(pool).mint(pool.address, LOCK_AMOUNT);
      // No approve call

      await expect(
        nft
          .connect(pool)
          .mintLong(
            trader.address, pool.address, await airMeme.getAddress(),
            USDC_IN, AIR_USD_MINTED, LOCK_AMOUNT, FEES_PAID
          )
      ).to.be.revertedWithCustomError(airMeme, "ERC20InsufficientAllowance");
    });
  });

  // ── mintShort ──────────────────────────────────────────────────────────────

  describe("mintShort", function () {
    it("mints the NFT to the trader", async function () {
      const { nft, trader } = await loadFixture(withShortPositionFixture);
      expect(await nft.ownerOf(0n)).to.equal(trader.address);
    });

    it("stores correct position data", async function () {
      const { nft, airUsd, pool } = await loadFixture(withShortPositionFixture);
      const pos = await nft.getPosition(0n);

      expect(pos.isLong).to.equal(false);
      expect(pos.pool).to.equal(pool.address);
      expect(pos.lockedToken).to.equal(await airUsd.getAddress());
      expect(pos.lockedAmount).to.equal(AIR_USD_LOCKED);
      expect(pos.usdcIn).to.equal(0n);
      expect(pos.airUsdMinted).to.equal(0n);
      expect(pos.airMemeMinted).to.equal(AIR_MEME_MINTED);
      expect(pos.feesPaid).to.equal(FEES_PAID);
    });

    it("pulls airUsd into the NFT contract custody", async function () {
      const { nft, airUsd } = await loadFixture(withShortPositionFixture);
      expect(await airUsd.balanceOf(await nft.getAddress())).to.equal(
        AIR_USD_LOCKED
      );
    });

    it("reverts when msg.sender differs from pool argument", async function () {
      const { nft, airUsd, pool, other, trader } =
        await loadFixture(baseFixture);
      await airUsd.connect(pool).mint(pool.address, AIR_USD_LOCKED);
      await airUsd.connect(pool).approve(await nft.getAddress(), AIR_USD_LOCKED);

      await expect(
        nft
          .connect(other)
          .mintShort(
            trader.address, pool.address, await airUsd.getAddress(),
            AIR_MEME_MINTED, AIR_USD_LOCKED, FEES_PAID
          )
      ).to.be.revertedWithCustomError(nft, "OnlyPool");
    });
  });

  // ── getPosition ────────────────────────────────────────────────────────────

  describe("getPosition", function () {
    it("reverts for a non-existent token", async function () {
      const { nft } = await loadFixture(baseFixture);
      await expect(nft.getPosition(999n)).to.be.revertedWithCustomError(
        nft,
        "PositionNotFound"
      );
    });
  });

  // ── release ────────────────────────────────────────────────────────────────

  describe("release", function () {
    it("burns the long NFT", async function () {
      const { nft, pool } = await loadFixture(withLongPositionFixture);
      await nft.connect(pool).release(0n);
      await expect(nft.ownerOf(0n)).to.be.reverted;
    });

    it("returns locked airMeme to the pool", async function () {
      const { nft, airMeme, pool } = await loadFixture(withLongPositionFixture);
      await nft.connect(pool).release(0n);
      expect(await airMeme.balanceOf(pool.address)).to.equal(LOCK_AMOUNT);
    });

    it("returns correct position data for a long", async function () {
      const { nft, airMeme, pool } = await loadFixture(withLongPositionFixture);
      const pos = await nft.connect(pool).release.staticCall(0n);

      expect(pos.isLong).to.equal(true);
      expect(pos.lockedAmount).to.equal(LOCK_AMOUNT);
      expect(pos.airUsdMinted).to.equal(AIR_USD_MINTED);
      expect(pos.usdcIn).to.equal(USDC_IN);
    });

    it("burns the short NFT and returns airUsd to the pool", async function () {
      const { nft, airUsd, pool } = await loadFixture(withShortPositionFixture);
      await nft.connect(pool).release(0n);

      await expect(nft.ownerOf(0n)).to.be.reverted;
      expect(await airUsd.balanceOf(pool.address)).to.equal(AIR_USD_LOCKED);
    });

    it("returns correct position data for a short", async function () {
      const { nft, pool } = await loadFixture(withShortPositionFixture);
      const pos = await nft.connect(pool).release.staticCall(0n);

      expect(pos.isLong).to.equal(false);
      expect(pos.lockedAmount).to.equal(AIR_USD_LOCKED);
      expect(pos.airMemeMinted).to.equal(AIR_MEME_MINTED);
    });

    it("clears position data after release", async function () {
      const { nft, pool } = await loadFixture(withLongPositionFixture);
      await nft.connect(pool).release(0n);
      await expect(nft.getPosition(0n)).to.be.revertedWithCustomError(
        nft,
        "PositionNotFound"
      );
    });

    it("reverts when called by a non-pool address", async function () {
      const { nft, other } = await loadFixture(withLongPositionFixture);
      await expect(nft.connect(other).release(0n)).to.be.revertedWithCustomError(
        nft,
        "PositionNotFromPool"
      );
    });

    it("reverts for a non-existent token", async function () {
      const { nft, pool } = await loadFixture(withLongPositionFixture);
      await expect(nft.connect(pool).release(999n)).to.be.revertedWithCustomError(
        nft,
        "PositionNotFound"
      );
    });

    it("reverts on double-release", async function () {
      const { nft, pool } = await loadFixture(withLongPositionFixture);
      await nft.connect(pool).release(0n);
      await expect(nft.connect(pool).release(0n)).to.be.revertedWithCustomError(
        nft,
        "PositionNotFound"
      );
    });
  });

  // ── ERC-721 transferability ────────────────────────────────────────────────

  describe("ERC-721 transferability", function () {
    it("owner can transfer a long position to another address", async function () {
      const { nft, trader, other } = await loadFixture(withLongPositionFixture);
      await nft
        .connect(trader)
        .transferFrom(trader.address, other.address, 0n);
      expect(await nft.ownerOf(0n)).to.equal(other.address);
    });

    it("owner can approve and transferFrom a long position", async function () {
      const { nft, trader, other } = await loadFixture(withLongPositionFixture);
      await nft.connect(trader).approve(other.address, 0n);
      await nft
        .connect(other)
        .transferFrom(trader.address, other.address, 0n);
      expect(await nft.ownerOf(0n)).to.equal(other.address);
    });

    it("new owner receives the locked tokens on release", async function () {
      const { nft, airMeme, pool, trader, other } =
        await loadFixture(withLongPositionFixture);

      // trader transfers position to other
      await nft.connect(trader).transferFrom(trader.address, other.address, 0n);

      // pool still calls release (pool is always the caller for settlement)
      await nft.connect(pool).release(0n);

      // locked airMeme returned to pool; owner change doesn't affect custody
      expect(await airMeme.balanceOf(pool.address)).to.equal(LOCK_AMOUNT);
    });
  });
});
