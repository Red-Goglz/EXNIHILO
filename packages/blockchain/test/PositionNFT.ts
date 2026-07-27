import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { PositionNFT } from "../typechain-types";

describe("PositionNFT", function () {
  // ── Helpers ────────────────────────────────────────────────────────────────

  const LOCK_AMOUNT = ethers.parseUnits("100", 18); // airToken locked in long
  const AIR_USD_MINTED = ethers.parseUnits("10", 6); // synthetic airUsd debt
  const USDC_IN = ethers.parseUnits("10", 6);
  const FEES_PAID = ethers.parseUnits("0.5", 6);

  const AIR_TOKEN_MINTED = ethers.parseUnits("500", 18); // synthetic airToken debt
  const AIR_USD_LOCKED = ethers.parseUnits("9", 6); // airUsd locked in short
  const SHORT_USDC_NOTIONAL = ethers.parseUnits("10", 6); // notional for OI tracking

  // ── Fixtures ───────────────────────────────────────────────────────────────

  /**
   * Deploys PositionNFT. The NFT is a pure registry: no collateral custody,
   * positions are described entirely by the stored struct. `pool` signer acts
   * as msg.sender for mintLong / mintShort calls. A MockFactory registers the
   * pool signer so PositionNFT's registered-pool mint guard passes.
   */
  async function baseFixture() {
    const [factory, pool, trader, other] = await ethers.getSigners();

    const PositionNFT = await ethers.getContractFactory("PositionNFT");
    const nft: PositionNFT = await PositionNFT.deploy();

    const mockFactory = await (await ethers.getContractFactory("MockFactory")).deploy();
    await nft.connect(factory).initFactory(await mockFactory.getAddress());
    await mockFactory.setPool(pool.address, true);

    return { nft, mockFactory, factory, pool, trader, other };
  }

  /**
   * Extends baseFixture with a minted long position.
   */
  async function withLongPositionFixture() {
    const base = await baseFixture();
    const { nft, pool, trader } = base;

    await nft
      .connect(pool)
      .mintLong(
        trader.address,
        pool.address,
        USDC_IN,
        AIR_USD_MINTED,
        LOCK_AMOUNT,
        FEES_PAID,
        9999999999n
      );

    return { ...base, longTokenId: 0n };
  }

  async function withShortPositionFixture() {
    const base = await baseFixture();
    const { nft, pool, trader } = base;

    await nft
      .connect(pool)
      .mintShort(
        trader.address,
        pool.address,
        AIR_TOKEN_MINTED,
        AIR_USD_LOCKED,
        SHORT_USDC_NOTIONAL,
        FEES_PAID,
        9999999999n
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
      const { nft, pool } = await loadFixture(withLongPositionFixture);
      const pos = await nft.getPosition(0n);

      expect(pos.isLong).to.equal(true);
      expect(pos.pool).to.equal(pool.address);
      expect(pos.lockedAmount).to.equal(LOCK_AMOUNT);
      expect(pos.usdcIn).to.equal(USDC_IN);
      expect(pos.airUsdMinted).to.equal(AIR_USD_MINTED);
      expect(pos.airTokenMinted).to.equal(0n);
      expect(pos.feesPaid).to.equal(FEES_PAID);
    });

    it("records openedAt as current block timestamp", async function () {
      const { nft } = await loadFixture(withLongPositionFixture);
      const pos = await nft.getPosition(0n);
      const block = await ethers.provider.getBlock("latest");
      expect(pos.openedAt).to.equal(BigInt(block!.timestamp));
    });

    it("increments token IDs for successive mints", async function () {
      const { nft, pool, trader } = await loadFixture(baseFixture);

      await nft
        .connect(pool)
        .mintLong(
          trader.address, pool.address,
          USDC_IN, AIR_USD_MINTED, LOCK_AMOUNT, FEES_PAID, 9999999999n
        );
      await nft
        .connect(pool)
        .mintLong(
          trader.address, pool.address,
          USDC_IN, AIR_USD_MINTED, LOCK_AMOUNT, FEES_PAID, 9999999999n
        );

      expect(await nft.ownerOf(0n)).to.equal(trader.address);
      expect(await nft.ownerOf(1n)).to.equal(trader.address);
    });

    it("reverts when msg.sender differs from pool argument", async function () {
      const { nft, pool, other, trader } = await loadFixture(baseFixture);

      await expect(
        nft
          .connect(other) // not `pool`
          .mintLong(
            trader.address, pool.address,
            USDC_IN, AIR_USD_MINTED, LOCK_AMOUNT, FEES_PAID, 9999999999n
          )
      ).to.be.revertedWithCustomError(nft, "OnlyPool");
    });

    it("reverts with FactoryNotSet before initFactory is called (NM-001)", async function () {
      const { pool, trader } = await loadFixture(baseFixture);
      const freshNft = await (await ethers.getContractFactory("PositionNFT")).deploy();

      await expect(
        freshNft
          .connect(pool)
          .mintLong(
            trader.address, pool.address,
            USDC_IN, AIR_USD_MINTED, LOCK_AMOUNT, FEES_PAID, 9999999999n
          )
      ).to.be.revertedWithCustomError(freshNft, "FactoryNotSet");
    });

    it("reverts when the pool is not registered with the factory (NM-001)", async function () {
      const { nft, other, trader } = await loadFixture(baseFixture);

      // `other` passes the msg.sender == pool check by naming itself as the
      // pool, but is not registered with the factory.
      await expect(
        nft
          .connect(other)
          .mintLong(
            trader.address, other.address,
            USDC_IN, AIR_USD_MINTED, LOCK_AMOUNT, FEES_PAID, 9999999999n
          )
      ).to.be.revertedWithCustomError(nft, "OnlyPool");
    });
  });

  // ── mintShort ──────────────────────────────────────────────────────────────

  describe("mintShort", function () {
    it("mints the NFT to the trader", async function () {
      const { nft, trader } = await loadFixture(withShortPositionFixture);
      expect(await nft.ownerOf(0n)).to.equal(trader.address);
    });

    it("stores correct position data", async function () {
      const { nft, pool } = await loadFixture(withShortPositionFixture);
      const pos = await nft.getPosition(0n);

      expect(pos.isLong).to.equal(false);
      expect(pos.pool).to.equal(pool.address);
      expect(pos.lockedAmount).to.equal(AIR_USD_LOCKED);
      expect(pos.usdcIn).to.equal(SHORT_USDC_NOTIONAL);
      expect(pos.airUsdMinted).to.equal(0n);
      expect(pos.airTokenMinted).to.equal(AIR_TOKEN_MINTED);
      expect(pos.feesPaid).to.equal(FEES_PAID);
    });

    it("reverts when msg.sender differs from pool argument", async function () {
      const { nft, pool, other, trader } = await loadFixture(baseFixture);

      await expect(
        nft
          .connect(other)
          .mintShort(
            trader.address, pool.address,
            AIR_TOKEN_MINTED, AIR_USD_LOCKED, SHORT_USDC_NOTIONAL, FEES_PAID, 9999999999n
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

    it("returns correct position data for a long", async function () {
      const { nft, pool } = await loadFixture(withLongPositionFixture);
      const pos = await nft.connect(pool).release.staticCall(0n);

      expect(pos.isLong).to.equal(true);
      expect(pos.lockedAmount).to.equal(LOCK_AMOUNT);
      expect(pos.airUsdMinted).to.equal(AIR_USD_MINTED);
      expect(pos.usdcIn).to.equal(USDC_IN);
    });

    it("burns the short NFT", async function () {
      const { nft, pool } = await loadFixture(withShortPositionFixture);
      await nft.connect(pool).release(0n);
      await expect(nft.ownerOf(0n)).to.be.reverted;
    });

    it("returns correct position data for a short", async function () {
      const { nft, pool } = await loadFixture(withShortPositionFixture);
      const pos = await nft.connect(pool).release.staticCall(0n);

      expect(pos.isLong).to.equal(false);
      expect(pos.lockedAmount).to.equal(AIR_USD_LOCKED);
      expect(pos.airTokenMinted).to.equal(AIR_TOKEN_MINTED);
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

    it("pool can still release after an ownership transfer", async function () {
      const { nft, pool, trader, other } =
        await loadFixture(withLongPositionFixture);

      // trader transfers position to other
      await nft.connect(trader).transferFrom(trader.address, other.address, 0n);

      // pool still calls release (pool is always the caller for settlement)
      await nft.connect(pool).release(0n);
      await expect(nft.ownerOf(0n)).to.be.reverted;
    });
  });
});
