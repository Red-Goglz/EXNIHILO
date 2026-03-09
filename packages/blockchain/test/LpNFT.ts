import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { LpNFT } from "../typechain-types";

describe("LpNFT", function () {
  // ── Fixtures ───────────────────────────────────────────────────────────────

  async function deployFixture() {
    const [factory, pool, creator, other] = await ethers.getSigners();

    const LpNFT = await ethers.getContractFactory("LpNFT");
    const nft: LpNFT = await LpNFT.connect(factory).deploy(factory.address);

    return { nft, factory, pool, creator, other };
  }

  async function withOneTokenFixture() {
    const base = await deployFixture();
    const { nft, factory, pool, creator } = base;
    await nft.connect(factory).mint(creator.address, pool.address);
    return { ...base, tokenId: 0n };
  }

  // ── Deployment ─────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets name and symbol", async function () {
      const { nft } = await loadFixture(deployFixture);
      expect(await nft.name()).to.equal("EXNIHILO LP");
      expect(await nft.symbol()).to.equal("EXLP");
    });

    it("stores the deployer as factory", async function () {
      const { nft, factory } = await loadFixture(deployFixture);
      expect(await nft.factory()).to.equal(factory.address);
    });
  });

  // ── mint ───────────────────────────────────────────────────────────────────

  describe("mint", function () {
    it("mints token 0 to the creator", async function () {
      const { nft, creator } = await loadFixture(withOneTokenFixture);
      expect(await nft.ownerOf(0n)).to.equal(creator.address);
    });

    it("associates the correct pool address with the token", async function () {
      const { nft, pool } = await loadFixture(withOneTokenFixture);
      expect(await nft.poolOf(0n)).to.equal(pool.address);
    });

    it("emits a Transfer event from the zero address", async function () {
      const { nft, factory, pool, creator } = await loadFixture(deployFixture);
      await expect(nft.connect(factory).mint(creator.address, pool.address))
        .to.emit(nft, "Transfer")
        .withArgs(ethers.ZeroAddress, creator.address, 0n);
    });

    it("increments token IDs for successive mints", async function () {
      const { nft, factory, pool, creator, other } =
        await loadFixture(deployFixture);

      await nft.connect(factory).mint(creator.address, pool.address);
      await nft.connect(factory).mint(other.address, other.address); // second pool

      expect(await nft.ownerOf(0n)).to.equal(creator.address);
      expect(await nft.ownerOf(1n)).to.equal(other.address);
      expect(await nft.poolOf(0n)).to.equal(pool.address);
      expect(await nft.poolOf(1n)).to.equal(other.address);
    });

    it("returns the new token ID", async function () {
      const { nft, factory, pool, creator } = await loadFixture(deployFixture);
      const tokenId = await nft.connect(factory).mint.staticCall(
        creator.address,
        pool.address
      );
      expect(tokenId).to.equal(0n);
    });

    it("reverts when called by a non-factory address", async function () {
      const { nft, pool, creator, other } = await loadFixture(deployFixture);
      await expect(
        nft.connect(other).mint(creator.address, pool.address)
      ).to.be.revertedWithCustomError(nft, "OnlyFactory");
    });

    it("reverts when pool is the zero address", async function () {
      const { nft, factory, creator } = await loadFixture(deployFixture);
      await expect(
        nft.connect(factory).mint(creator.address, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(nft, "ZeroAddress");
    });
  });

  // ── poolOf ─────────────────────────────────────────────────────────────────

  describe("poolOf", function () {
    it("reverts for a non-existent token", async function () {
      const { nft } = await loadFixture(deployFixture);
      await expect(nft.poolOf(999n)).to.be.revertedWithCustomError(
        nft,
        "TokenNotFound"
      );
    });
  });

  // ── ERC-721 transferability ────────────────────────────────────────────────

  describe("ERC-721 transferability", function () {
    it("holder can transfer the LP NFT to another address", async function () {
      const { nft, creator, other } = await loadFixture(withOneTokenFixture);
      await nft.connect(creator).transferFrom(creator.address, other.address, 0n);
      expect(await nft.ownerOf(0n)).to.equal(other.address);
    });

    it("poolOf remains correct after transfer", async function () {
      const { nft, pool, creator, other } =
        await loadFixture(withOneTokenFixture);
      await nft.connect(creator).transferFrom(creator.address, other.address, 0n);
      expect(await nft.poolOf(0n)).to.equal(pool.address);
    });

    it("supports approve and transferFrom", async function () {
      const { nft, creator, other } = await loadFixture(withOneTokenFixture);
      await nft.connect(creator).approve(other.address, 0n);
      await nft.connect(other).transferFrom(creator.address, other.address, 0n);
      expect(await nft.ownerOf(0n)).to.equal(other.address);
    });

    it("supports setApprovalForAll", async function () {
      const { nft, creator, other } = await loadFixture(withOneTokenFixture);
      await nft.connect(creator).setApprovalForAll(other.address, true);
      await nft.connect(other).transferFrom(creator.address, other.address, 0n);
      expect(await nft.ownerOf(0n)).to.equal(other.address);
    });
  });
});
