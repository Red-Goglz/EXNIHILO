import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type {
  EXNIHILOFactory,
  EXNIHILOPool,
  LockedLpVault,
  LpNFT,
  MockERC20,
  PositionNFT,
} from "../typechain-types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SWAP_FEE_BPS = 100n; // 1 %
const BPS_DENOM    = 10_000n;

const SEED_USDC  = ethers.parseUnits("100000", 6);   // 100,000 USDC
const SEED_TOKEN = ethers.parseEther("1000000");     // 1,000,000 token


const INTEGRATOR_BPS = 2000n; // 20 % of the LP fee stream

// ─────────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────────

/** See test/EXNIHILOFactory.ts for why LpNFT's factory immutable is patched. */
async function patchImmutableAddress(
  contractAddress: string,
  fromAddress: string,
  toAddress: string
): Promise<void> {
  const bytecode = await ethers.provider.getCode(contractAddress);
  const raw = bytecode.slice(2).toLowerCase();
  const fromPadded = "000000000000000000000000" + fromAddress.toLowerCase().slice(2);
  const toPadded = "000000000000000000000000" + toAddress.toLowerCase().slice(2);
  if (!raw.includes(fromPadded)) {
    throw new Error(`patchImmutableAddress: ${fromAddress} not found in ${contractAddress}`);
  }
  await ethers.provider.send("hardhat_setCode", [
    contractAddress,
    "0x" + raw.split(fromPadded).join(toPadded),
  ]);
}

async function deployFixture() {
  // [0]=deployer [1]=treasury [2]=creator/lp [3]=integrator [4]=trader [5]=other
  // [7]=throwaway (LpNFT deployer)  [8]=sysDeployer (factory deployer)
  const signers = await ethers.getSigners();
  const [deployer, treasury, lp, integrator, trader, other] = signers;
  const throwaway = signers[7];
  const sysDeployer = signers[8];

  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const token = (await MockERC20F.connect(deployer).deploy("PEPE", "PEPE", 18)) as unknown as MockERC20;
  const usdc  = (await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6)) as unknown as MockERC20;

  const positionNFT = (await (await ethers.getContractFactory("PositionNFT"))
    .connect(deployer).deploy()) as unknown as PositionNFT;

  const lpNft = (await (await ethers.getContractFactory("LpNFT"))
    .connect(throwaway).deploy(throwaway.address)) as unknown as LpNFT;

  const poolDeployer = await (await ethers.getContractFactory("PoolDeployer"))
    .connect(sysDeployer).deploy();

  const factory = (await (await ethers.getContractFactory("EXNIHILOFactory"))
    .connect(sysDeployer)
    .deploy(
      await positionNFT.getAddress(),
      await lpNft.getAddress(),
      await usdc.getAddress(),
      treasury.address,
      await poolDeployer.getAddress()
    )) as unknown as EXNIHILOFactory;

  const factoryAddr = await factory.getAddress();
  await patchImmutableAddress(await lpNft.getAddress(), throwaway.address, factoryAddr);
  await positionNFT.connect(deployer).initFactory(factoryAddr);

  // Seed a market owned by `lp`.
  await token.mint(lp.address, SEED_TOKEN);
  await usdc.mint(lp.address, SEED_USDC);
  await token.connect(lp).approve(factoryAddr, ethers.MaxUint256);
  await usdc.connect(lp).approve(factoryAddr, ethers.MaxUint256);

  await factory.connect(lp).createMarket(
    await token.getAddress(), SEED_USDC, SEED_TOKEN);
  // Position caps ramp 1 %→20 % over 24 h. These tests are not about
  // caps, so start past the ramp where size is not the constraint.
  await time.increase(24 * 3600);

  const poolAddr = await factory.allPools(0);
  const pool = (await ethers.getContractAt("EXNIHILOPool", poolAddr)) as unknown as EXNIHILOPool;
  const lpNftId = 0n;

  // Fund a trader so positions can be opened to generate LP fees.
  await usdc.mint(trader.address, ethers.parseUnits("500000", 6));
  await token.mint(trader.address, SEED_TOKEN);
  await usdc.connect(trader).approve(poolAddr, ethers.MaxUint256);
  await token.connect(trader).approve(poolAddr, ethers.MaxUint256);

  return {
    deployer, treasury, lp, integrator, trader, other,
    token, usdc, positionNFT, lpNft, factory, pool, poolAddr, lpNftId, factoryAddr,
  };
}

/** Deploy a vault and lock the market's LP NFT into it. */
async function withVaultFixture() {
  const base = await deployFixture();

  const vault = (await (await ethers.getContractFactory("LockedLpVault"))
    .connect(base.deployer)
    .deploy(
      base.poolAddr,
      await base.lpNft.getAddress(),
      base.lpNftId,
      base.lp.address,
      base.integrator.address,
      INTEGRATOR_BPS
    )) as unknown as LockedLpVault;

  const vaultAddr = await vault.getAddress();
  await base.lpNft.connect(base.lp).transferFrom(base.lp.address, vaultAddr, base.lpNftId);

  return { ...base, vault, vaultAddr };
}

/** Open a long, generating base LP fee + impact fee in the pool. */
async function generateFees(
  base: Awaited<ReturnType<typeof deployFixture>>,
  notional = ethers.parseUnits("10000", 6)
) {
  await base.pool.connect(base.trader).openLong(notional, 0n, base.trader.address);
}

// ═════════════════════════════════════════════════════════════════════════════

describe("LockedLpVault", () => {

  describe("Deployment", () => {
    it("stores every parameter and reads USDC from the pool", async () => {
      const { vault, poolAddr, lpNft, lp, integrator, usdc } =
        await loadFixture(withVaultFixture);

      expect(await vault.pool()).to.equal(poolAddr);
      expect(await vault.lpNft()).to.equal(await lpNft.getAddress());
      expect(await vault.lpNftId()).to.equal(0n);
      expect(await vault.lp()).to.equal(lp.address);
      expect(await vault.integrator()).to.equal(integrator.address);
      expect(await vault.integratorBps()).to.equal(INTEGRATOR_BPS);
      expect(await vault.usdc()).to.equal(await usdc.getAddress());
    });

    it("reverts on a zero pool", async () => {
      const base = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("LockedLpVault");
      await expect(
        F.deploy(ethers.ZeroAddress, await base.lpNft.getAddress(), 0n,
          base.lp.address, base.integrator.address, INTEGRATOR_BPS)
      ).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("reverts on a zero LpNFT", async () => {
      const base = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("LockedLpVault");
      await expect(
        F.deploy(base.poolAddr, ethers.ZeroAddress, 0n,
          base.lp.address, base.integrator.address, INTEGRATOR_BPS)
      ).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("reverts on a zero lp", async () => {
      const base = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("LockedLpVault");
      await expect(
        F.deploy(base.poolAddr, await base.lpNft.getAddress(), 0n,
          ethers.ZeroAddress, base.integrator.address, INTEGRATOR_BPS)
      ).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("reverts when integratorBps exceeds 100 %", async () => {
      const base = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("LockedLpVault");
      await expect(
        F.deploy(base.poolAddr, await base.lpNft.getAddress(), 0n,
          base.lp.address, base.integrator.address, BPS_DENOM + 1n)
      ).to.be.revertedWithCustomError(F, "InvalidBps");
    });

    it("reverts on a zero integrator when its share is non-zero", async () => {
      const base = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("LockedLpVault");
      await expect(
        F.deploy(base.poolAddr, await base.lpNft.getAddress(), 0n,
          base.lp.address, ethers.ZeroAddress, 1n)
      ).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("allows a zero integrator when its share is zero", async () => {
      const base = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("LockedLpVault");
      await expect(
        F.deploy(base.poolAddr, await base.lpNft.getAddress(), 0n,
          base.lp.address, ethers.ZeroAddress, 0n)
      ).to.not.be.reverted;
    });

    it("accepts an integrator share of 100 %", async () => {
      const base = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("LockedLpVault");
      await expect(
        F.deploy(base.poolAddr, await base.lpNft.getAddress(), 0n,
          base.lp.address, base.integrator.address, BPS_DENOM)
      ).to.not.be.reverted;
    });

    it("reverts when the LP NFT id belongs to a different market", async () => {
      // Guards against a vault wired to the wrong market, which would otherwise
      // deploy fine and then never be able to harvest anything.
      const base = await loadFixture(deployFixture);

      // A second market, so token id 1 exists but governs a different pool.
      await base.token.mint(base.lp.address, SEED_TOKEN);
      await base.usdc.mint(base.lp.address, SEED_USDC);
      await base.factory.connect(base.lp).createMarket(
        await base.token.getAddress(), SEED_USDC, SEED_TOKEN);
      // Position caps ramp 1 %→20 % over 24 h. These tests are not about
      // caps, so start past the ramp where size is not the constraint.
      await time.increase(24 * 3600);

      const F = await ethers.getContractFactory("LockedLpVault");
      await expect(
        F.deploy(base.poolAddr, await base.lpNft.getAddress(), 1n,
          base.lp.address, base.integrator.address, INTEGRATOR_BPS)
      ).to.be.revertedWithCustomError(F, "PoolMismatch");
    });

    it("reverts when the LP NFT id does not exist at all", async () => {
      const base = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("LockedLpVault");
      await expect(
        F.deploy(base.poolAddr, await base.lpNft.getAddress(), 99n,
          base.lp.address, base.integrator.address, INTEGRATOR_BPS)
      ).to.be.revertedWithCustomError(base.lpNft, "TokenNotFound");
    });

    it("reports isFunded only once the NFT has arrived", async () => {
      const base = await loadFixture(deployFixture);
      const vault = (await (await ethers.getContractFactory("LockedLpVault"))
        .connect(base.deployer)
        .deploy(base.poolAddr, await base.lpNft.getAddress(), 0n,
          base.lp.address, base.integrator.address, INTEGRATOR_BPS)) as unknown as LockedLpVault;

      expect(await vault.isFunded()).to.equal(false);
      await base.lpNft.connect(base.lp)
        .transferFrom(base.lp.address, await vault.getAddress(), 0n);
      expect(await vault.isFunded()).to.equal(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────

  describe("The lock", () => {
    it("takes ownership of the LP NFT", async () => {
      const { lpNft, vaultAddr } = await loadFixture(withVaultFixture);
      expect(await lpNft.ownerOf(0n)).to.equal(vaultAddr);
    });

    it("exposes no way to withdraw liquidity, add liquidity, or close the pool", async () => {
      // The whole guarantee. If any of these ever appear in the ABI, the vault
      // no longer means "LP burned".
      const { vault } = await loadFixture(withVaultFixture);
      const fns = vault.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => (f as { name: string }).name);

      for (const forbidden of [
        "removeLiquidity", "addLiquidity", "closePool",
        "setPositionCaps", "transferFrom", "safeTransferFrom", "approve",
      ]) {
        expect(fns).to.not.include(forbidden);
      }
    });

    it("leaves the pool unable to have its liquidity removed by anyone", async () => {
      const { pool, lp, integrator, other, deployer } = await loadFixture(withVaultFixture);

      for (const who of [lp, integrator, other, deployer]) {
        await expect(
          pool.connect(who).removeLiquidity()
        ).to.be.revertedWithCustomError(pool, "OnlyLpHolder");
      }
    });

    it("leaves the previous LP unable to claim fees directly", async () => {
      const base = await loadFixture(withVaultFixture);
      await generateFees(base);

      await expect(
        base.pool.connect(base.lp).claimFees(base.lp.address)
      ).to.be.revertedWithCustomError(base.pool, "OnlyLpHolder");
    });

    it("keeps trading fully operational", async () => {
      const base = await loadFixture(withVaultFixture);

      await expect(
        base.pool.connect(base.trader).swap(
          ethers.parseEther("1000"), 0n, true, base.trader.address
        )
      ).to.not.be.reverted;

      await expect(
        base.pool.connect(base.trader).openLong(
          ethers.parseUnits("1000", 6), 0n, base.trader.address
        )
      ).to.not.be.reverted;
    });

    it("accepts the NFT via safeTransferFrom too", async () => {
      const base = await loadFixture(deployFixture);
      const vault = await (await ethers.getContractFactory("LockedLpVault"))
        .connect(base.deployer)
        .deploy(base.poolAddr, await base.lpNft.getAddress(), 0n,
          base.lp.address, base.integrator.address, INTEGRATOR_BPS);

      await expect(
        base.lpNft.connect(base.lp)["safeTransferFrom(address,address,uint256)"](
          base.lp.address, await vault.getAddress(), 0n
        )
      ).to.not.be.reverted;
    });
  });

  // ───────────────────────────────────────────────────────────────────────────

  describe("harvest", () => {
    it("pulls the pool's LP fees and splits them by integratorBps", async () => {
      const base = await loadFixture(withVaultFixture);
      await generateFees(base);

      const accrued = await base.pool.lpFeesAccumulated();
      expect(accrued).to.be.greaterThan(0n);

      const expectedIntegrator = (accrued * INTEGRATOR_BPS) / BPS_DENOM;
      const expectedLp = accrued - expectedIntegrator;

      await expect(base.vault.harvest())
        .to.emit(base.vault, "Harvested")
        .withArgs(accrued, expectedLp, expectedIntegrator);

      expect(await base.vault.lpAccrued()).to.equal(expectedLp);
      expect(await base.vault.integratorAccrued()).to.equal(expectedIntegrator);
      expect(await base.vault.harvestedTotal()).to.equal(accrued);
      expect(await base.usdc.balanceOf(base.vaultAddr)).to.equal(accrued);
      expect(await base.pool.lpFeesAccumulated()).to.equal(0n);
    });

    it("is permissionless", async () => {
      const base = await loadFixture(withVaultFixture);
      await generateFees(base);
      await expect(base.vault.connect(base.other).harvest()).to.not.be.reverted;
      expect(await base.vault.lpAccrued()).to.be.greaterThan(0n);
    });

    it("is a no-op when the pool has accrued nothing", async () => {
      const { vault } = await loadFixture(withVaultFixture);
      await expect(vault.harvest()).to.not.be.reverted;
      expect(await vault.lpAccrued()).to.equal(0n);
      expect(await vault.integratorAccrued()).to.equal(0n);
      expect(await vault.harvestedTotal()).to.equal(0n);
    });

    it("accumulates across several harvests", async () => {
      const base = await loadFixture(withVaultFixture);

      await generateFees(base);
      await base.vault.harvest();
      const afterFirst = await base.vault.harvestedTotal();

      await generateFees(base);
      await base.vault.harvest();

      expect(await base.vault.harvestedTotal()).to.be.greaterThan(afterFirst);
      expect(await base.vault.lpAccrued() + await base.vault.integratorAccrued())
        .to.equal(await base.vault.harvestedTotal());
    });

    it("gives the whole stream to the LP when integratorBps is zero", async () => {
      const base = await loadFixture(deployFixture);
      const vault = (await (await ethers.getContractFactory("LockedLpVault"))
        .connect(base.deployer)
        .deploy(base.poolAddr, await base.lpNft.getAddress(), 0n,
          base.lp.address, ethers.ZeroAddress, 0n)) as unknown as LockedLpVault;
      await base.lpNft.connect(base.lp)
        .transferFrom(base.lp.address, await vault.getAddress(), 0n);

      await generateFees(base);
      const accrued = await base.pool.lpFeesAccumulated();
      await vault.harvest();

      expect(await vault.lpAccrued()).to.equal(accrued);
      expect(await vault.integratorAccrued()).to.equal(0n);
    });

    it("gives the whole stream to the integrator at 100 %", async () => {
      const base = await loadFixture(deployFixture);
      const vault = (await (await ethers.getContractFactory("LockedLpVault"))
        .connect(base.deployer)
        .deploy(base.poolAddr, await base.lpNft.getAddress(), 0n,
          base.lp.address, base.integrator.address, BPS_DENOM)) as unknown as LockedLpVault;
      await base.lpNft.connect(base.lp)
        .transferFrom(base.lp.address, await vault.getAddress(), 0n);

      await generateFees(base);
      const accrued = await base.pool.lpFeesAccumulated();
      await vault.harvest();

      expect(await vault.integratorAccrued()).to.equal(accrued);
      expect(await vault.lpAccrued()).to.equal(0n);
    });

    it("sweeps USDC donated directly to the vault", async () => {
      // The split is measured from the balance delta, so a stray transfer is
      // picked up rather than stranded.
      const base = await loadFixture(withVaultFixture);
      await generateFees(base);

      const donation = ethers.parseUnits("100", 6);
      await base.usdc.mint(base.vaultAddr, donation);

      const accrued = await base.pool.lpFeesAccumulated();
      await base.vault.harvest();

      expect(await base.vault.harvestedTotal()).to.equal(accrued + donation);
    });

    it("reverts while the vault does not hold the LP NFT", async () => {
      const base = await loadFixture(deployFixture);
      const vault = (await (await ethers.getContractFactory("LockedLpVault"))
        .connect(base.deployer)
        .deploy(base.poolAddr, await base.lpNft.getAddress(), 0n,
          base.lp.address, base.integrator.address, INTEGRATOR_BPS)) as unknown as LockedLpVault;

      await generateFees(base);
      await expect(vault.harvest()).to.be.revertedWithCustomError(base.pool, "OnlyLpHolder");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────

  describe("claimLpFees", () => {
    it("pays the LP and zeroes the balance", async () => {
      const base = await loadFixture(withVaultFixture);
      await generateFees(base);
      await base.vault.harvest();

      const owed = await base.vault.lpAccrued();
      const before = await base.usdc.balanceOf(base.lp.address);

      await expect(base.vault.connect(base.lp).claimLpFees(base.lp.address))
        .to.emit(base.vault, "LpFeesClaimed")
        .withArgs(base.lp.address, owed);

      expect(await base.usdc.balanceOf(base.lp.address)).to.equal(before + owed);
      expect(await base.vault.lpAccrued()).to.equal(0n);
      expect(await base.vault.lpClaimedTotal()).to.equal(owed);
    });

    it("harvests first, so one call collects everything owed", async () => {
      const base = await loadFixture(withVaultFixture);
      await generateFees(base);

      // No explicit harvest.
      const accrued = await base.pool.lpFeesAccumulated();
      const expectedLp = accrued - (accrued * INTEGRATOR_BPS) / BPS_DENOM;
      const before = await base.usdc.balanceOf(base.lp.address);

      await base.vault.connect(base.lp).claimLpFees(base.lp.address);

      expect(await base.usdc.balanceOf(base.lp.address)).to.equal(before + expectedLp);
    });

    it("can redirect to another address", async () => {
      const base = await loadFixture(withVaultFixture);
      await generateFees(base);
      await base.vault.harvest();

      const owed = await base.vault.lpAccrued();
      await base.vault.connect(base.lp).claimLpFees(base.other.address);

      expect(await base.usdc.balanceOf(base.other.address)).to.equal(owed);
    });

    it("does not touch the integrator's balance", async () => {
      const base = await loadFixture(withVaultFixture);
      await generateFees(base);
      await base.vault.harvest();

      const integratorOwed = await base.vault.integratorAccrued();
      await base.vault.connect(base.lp).claimLpFees(base.lp.address);

      expect(await base.vault.integratorAccrued()).to.equal(integratorOwed);
      expect(await base.usdc.balanceOf(base.vaultAddr)).to.equal(integratorOwed);
    });

    it("reverts for anyone other than the LP", async () => {
      const base = await loadFixture(withVaultFixture);
      await generateFees(base);
      await base.vault.harvest();

      for (const who of [base.integrator, base.other, base.deployer]) {
        await expect(
          base.vault.connect(who).claimLpFees(who.address)
        ).to.be.revertedWithCustomError(base.vault, "NotLp");
      }
    });

    it("reverts on a zero destination", async () => {
      const base = await loadFixture(withVaultFixture);
      await generateFees(base);
      await base.vault.harvest();

      await expect(
        base.vault.connect(base.lp).claimLpFees(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(base.vault, "ZeroAddress");
    });

    it("reverts when there is nothing owed", async () => {
      const base = await loadFixture(withVaultFixture);
      await expect(
        base.vault.connect(base.lp).claimLpFees(base.lp.address)
      ).to.be.revertedWithCustomError(base.vault, "NothingToClaim");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────

  describe("claimIntegratorFees", () => {
    it("pays the integrator and zeroes the balance", async () => {
      const base = await loadFixture(withVaultFixture);
      await generateFees(base);
      await base.vault.harvest();

      const owed = await base.vault.integratorAccrued();
      expect(owed).to.be.greaterThan(0n);
      const before = await base.usdc.balanceOf(base.integrator.address);

      await expect(base.vault.connect(base.integrator).claimIntegratorFees(base.integrator.address))
        .to.emit(base.vault, "IntegratorFeesClaimed")
        .withArgs(base.integrator.address, owed);

      expect(await base.usdc.balanceOf(base.integrator.address)).to.equal(before + owed);
      expect(await base.vault.integratorAccrued()).to.equal(0n);
      expect(await base.vault.integratorClaimedTotal()).to.equal(owed);
    });

    it("harvests first, so one call collects everything owed", async () => {
      const base = await loadFixture(withVaultFixture);
      await generateFees(base);

      const accrued = await base.pool.lpFeesAccumulated();
      const expected = (accrued * INTEGRATOR_BPS) / BPS_DENOM;
      const before = await base.usdc.balanceOf(base.integrator.address);

      await base.vault.connect(base.integrator).claimIntegratorFees(base.integrator.address);

      expect(await base.usdc.balanceOf(base.integrator.address)).to.equal(before + expected);
    });

    it("can redirect to another address", async () => {
      const base = await loadFixture(withVaultFixture);
      await generateFees(base);
      await base.vault.harvest();

      const owed = await base.vault.integratorAccrued();
      await base.vault.connect(base.integrator).claimIntegratorFees(base.other.address);

      expect(await base.usdc.balanceOf(base.other.address)).to.equal(owed);
    });

    it("reverts for anyone other than the integrator", async () => {
      const base = await loadFixture(withVaultFixture);
      await generateFees(base);
      await base.vault.harvest();

      for (const who of [base.lp, base.other, base.deployer]) {
        await expect(
          base.vault.connect(who).claimIntegratorFees(who.address)
        ).to.be.revertedWithCustomError(base.vault, "NotIntegrator");
      }
    });

    it("reverts on a zero destination", async () => {
      const base = await loadFixture(withVaultFixture);
      await generateFees(base);
      await base.vault.harvest();

      await expect(
        base.vault.connect(base.integrator).claimIntegratorFees(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(base.vault, "ZeroAddress");
    });

    it("reverts when there is nothing owed", async () => {
      const base = await loadFixture(withVaultFixture);
      await expect(
        base.vault.connect(base.integrator).claimIntegratorFees(base.integrator.address)
      ).to.be.revertedWithCustomError(base.vault, "NothingToClaim");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────

  describe("Role transfer", () => {
    it("lets the LP hand its role to a new address", async () => {
      const base = await loadFixture(withVaultFixture);

      await expect(base.vault.connect(base.lp).setLp(base.other.address))
        .to.emit(base.vault, "LpTransferred")
        .withArgs(base.lp.address, base.other.address);

      expect(await base.vault.lp()).to.equal(base.other.address);
    });

    it("lets the integrator hand its role to a new address", async () => {
      const base = await loadFixture(withVaultFixture);

      await expect(base.vault.connect(base.integrator).setIntegrator(base.other.address))
        .to.emit(base.vault, "IntegratorTransferred")
        .withArgs(base.integrator.address, base.other.address);

      expect(await base.vault.integrator()).to.equal(base.other.address);
    });

    it("moves the claim right, including anything already accrued", async () => {
      const base = await loadFixture(withVaultFixture);
      await generateFees(base);
      await base.vault.harvest();

      const owed = await base.vault.lpAccrued();
      await base.vault.connect(base.lp).setLp(base.other.address);

      await expect(
        base.vault.connect(base.lp).claimLpFees(base.lp.address)
      ).to.be.revertedWithCustomError(base.vault, "NotLp");

      await base.vault.connect(base.other).claimLpFees(base.other.address);
      expect(await base.usdc.balanceOf(base.other.address)).to.equal(owed);
    });

    it("rejects a transfer from anyone but the current holder", async () => {
      const base = await loadFixture(withVaultFixture);

      await expect(
        base.vault.connect(base.integrator).setLp(base.other.address)
      ).to.be.revertedWithCustomError(base.vault, "NotLp");

      await expect(
        base.vault.connect(base.lp).setIntegrator(base.other.address)
      ).to.be.revertedWithCustomError(base.vault, "NotIntegrator");
    });

    it("rejects transferring either role to the zero address", async () => {
      const base = await loadFixture(withVaultFixture);

      await expect(
        base.vault.connect(base.lp).setLp(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(base.vault, "ZeroAddress");

      await expect(
        base.vault.connect(base.integrator).setIntegrator(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(base.vault, "ZeroAddress");
    });

    it("cannot change the split or unlock the liquidity", async () => {
      const base = await loadFixture(withVaultFixture);
      const bpsBefore = await base.vault.integratorBps();

      await base.vault.connect(base.lp).setLp(base.other.address);
      await base.vault.connect(base.integrator).setIntegrator(base.trader.address);

      expect(await base.vault.integratorBps()).to.equal(bpsBefore);
      expect(await base.lpNft.ownerOf(0n)).to.equal(base.vaultAddr);
      await expect(
        base.pool.connect(base.other).removeLiquidity()
      ).to.be.revertedWithCustomError(base.pool, "OnlyLpHolder");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────

  describe("pending", () => {
    it("is zero on a fresh vault", async () => {
      const { vault } = await loadFixture(withVaultFixture);
      const [lpPending, integratorPending] = await vault.pending();
      expect(lpPending).to.equal(0n);
      expect(integratorPending).to.equal(0n);
    });

    it("counts fees still sitting unharvested in the pool", async () => {
      const base = await loadFixture(withVaultFixture);
      await generateFees(base);

      const accrued = await base.pool.lpFeesAccumulated();
      const expectedIntegrator = (accrued * INTEGRATOR_BPS) / BPS_DENOM;

      const [lpPending, integratorPending] = await base.vault.pending();
      expect(integratorPending).to.equal(expectedIntegrator);
      expect(lpPending).to.equal(accrued - expectedIntegrator);
    });

    it("matches the accrued balances after harvesting", async () => {
      const base = await loadFixture(withVaultFixture);
      await generateFees(base);
      await base.vault.harvest();

      const [lpPending, integratorPending] = await base.vault.pending();
      expect(lpPending).to.equal(await base.vault.lpAccrued());
      expect(integratorPending).to.equal(await base.vault.integratorAccrued());
    });

    it("drops the claimed side after a claim", async () => {
      const base = await loadFixture(withVaultFixture);
      await generateFees(base);
      await base.vault.connect(base.lp).claimLpFees(base.lp.address);

      const [lpPending, integratorPending] = await base.vault.pending();
      expect(lpPending).to.equal(0n);
      expect(integratorPending).to.be.greaterThan(0n);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The vault splits whatever its balance holds over what is already banked. If
   * the balance instead falls BELOW the banked total — a seizure, a burn, a
   * negative rebase — that subtraction used to underflow, and since both claim
   * paths and the view harvest first, a deficit of one unit froze every exit.
   * Nothing can conjure the missing USDC back, but what is still there has to
   * stay reachable.
   */
  describe("A balance below what is banked", () => {
    async function withDeficit() {
      const base = await loadFixture(withVaultFixture);
      await generateFees(base);
      await base.vault.harvest();

      const banked = (await base.vault.lpAccrued()) + (await base.vault.integratorAccrued());
      const vaultAddr = await base.vault.getAddress();
      expect(await base.usdc.balanceOf(vaultAddr)).to.equal(banked);

      // Take out exactly the integrator's share: the balance still covers the LP
      // on its own, but no longer covers the pair, which is what used to underflow.
      const bite = await base.vault.integratorAccrued();
      expect(bite).to.be.greaterThan(0n);
      await (await base.usdc.burn(vaultAddr, bite)).wait();
      expect(await base.usdc.balanceOf(vaultAddr)).to.be.lessThan(banked);

      return base;
    }

    it("leaves the view readable", async () => {
      const { vault } = await withDeficit();
      await expect(vault.pending()).to.not.be.reverted;
    });

    it("leaves harvest callable, with nothing to split", async () => {
      const { vault } = await withDeficit();
      await expect(vault.harvest()).to.not.be.reverted;
      expect(await vault.harvest.staticCall()).to.equal(0n);
    });

    it("still pays a claim the remaining balance covers", async () => {
      const { vault, usdc, lp } = await withDeficit();
      const owed = await vault.lpAccrued();

      await expect(vault.connect(lp).claimLpFees(lp.address)).to.not.be.reverted;
      expect(await usdc.balanceOf(lp.address)).to.equal(owed);
      expect(await vault.lpAccrued()).to.equal(0n);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────

  describe("Reentrancy", () => {
    /**
     * Build a system whose USDC re-enters on transfer. Theoretical against real
     * Circle USDC, but it is the only way the vault's guards can be reached —
     * every path out of this contract is a USDC transfer.
     */
    async function withReentrantUsdc() {
      const signers = await ethers.getSigners();
      const [deployer, treasury, lp, integrator, trader] = signers;
      const throwaway = signers[7];
      const sysDeployer = signers[8];

      const token = (await (await ethers.getContractFactory("MockERC20"))
        .connect(deployer).deploy("PEPE", "PEPE", 18)) as unknown as MockERC20;
      const evilUsdc = await (await ethers.getContractFactory("ReentrantToken"))
        .connect(deployer).deploy("USD Coin", "USDC", 6);

      const positionNFT = (await (await ethers.getContractFactory("PositionNFT"))
        .connect(deployer).deploy()) as unknown as PositionNFT;
      const lpNft = (await (await ethers.getContractFactory("LpNFT"))
        .connect(throwaway).deploy(throwaway.address)) as unknown as LpNFT;
      const poolDeployer = await (await ethers.getContractFactory("PoolDeployer"))
        .connect(sysDeployer).deploy();

      const factory = (await (await ethers.getContractFactory("EXNIHILOFactory"))
        .connect(sysDeployer)
        .deploy(
          await positionNFT.getAddress(), await lpNft.getAddress(),
          await evilUsdc.getAddress(), treasury.address,
          await poolDeployer.getAddress()
        )) as unknown as EXNIHILOFactory;

      const factoryAddr = await factory.getAddress();
      await patchImmutableAddress(await lpNft.getAddress(), throwaway.address, factoryAddr);
      await positionNFT.connect(deployer).initFactory(factoryAddr);

      await token.mint(lp.address, SEED_TOKEN);
      await evilUsdc.mint(lp.address, SEED_USDC);
      await token.connect(lp).approve(factoryAddr, ethers.MaxUint256);
      await evilUsdc.connect(lp).approve(factoryAddr, ethers.MaxUint256);
      await factory.connect(lp).createMarket(
        await token.getAddress(), SEED_USDC, SEED_TOKEN);
      // Position caps ramp 1 %→20 % over 24 h. These tests are not about
      // caps, so start past the ramp where size is not the constraint.
      await time.increase(24 * 3600);

      const poolAddr = await factory.allPools(0);
      const pool = (await ethers.getContractAt("EXNIHILOPool", poolAddr)) as unknown as EXNIHILOPool;

      const vault = (await (await ethers.getContractFactory("LockedLpVault"))
        .connect(deployer)
        .deploy(poolAddr, await lpNft.getAddress(), 0n,
          lp.address, integrator.address, INTEGRATOR_BPS)) as unknown as LockedLpVault;
      await lpNft.connect(lp).transferFrom(lp.address, await vault.getAddress(), 0n);

      // Generate fees while the token still behaves normally.
      await evilUsdc.mint(trader.address, ethers.parseUnits("200000", 6));
      await evilUsdc.connect(trader).approve(poolAddr, ethers.MaxUint256);
      await pool.connect(trader).openLong(
        ethers.parseUnits("10000", 6), 0n, trader.address
      );

      return { evilUsdc, vault, pool, lp, integrator, deployer };
    }

    it("blocks re-entering harvest from the USDC payout", async () => {
      const { evilUsdc, vault } = await withReentrantUsdc();

      await evilUsdc.setReentrantTransferCall(
        await vault.getAddress(),
        vault.interface.encodeFunctionData("harvest", [])
      );

      await expect(vault.harvest())
        .to.be.revertedWithCustomError(vault, "ReentrancyGuardReentrantCall");
    });

    it("blocks re-entering claimLpFees", async () => {
      const { evilUsdc, vault, lp } = await withReentrantUsdc();

      await evilUsdc.setReentrantTransferCall(
        await vault.getAddress(),
        vault.interface.encodeFunctionData("claimLpFees", [lp.address])
      );

      await expect(vault.connect(lp).claimLpFees(lp.address))
        .to.be.revertedWithCustomError(vault, "ReentrancyGuardReentrantCall");
    });

    it("blocks re-entering claimIntegratorFees", async () => {
      const { evilUsdc, vault, integrator } = await withReentrantUsdc();

      await evilUsdc.setReentrantTransferCall(
        await vault.getAddress(),
        vault.interface.encodeFunctionData("claimIntegratorFees", [integrator.address])
      );

      await expect(vault.connect(integrator).claimIntegratorFees(integrator.address))
        .to.be.revertedWithCustomError(vault, "ReentrancyGuardReentrantCall");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────

  describe("End to end", () => {
    it("splits a full lifecycle of fees between both parties", async () => {
      const base = await loadFixture(withVaultFixture);

      // A mix of opens and spot flow.
      await generateFees(base, ethers.parseUnits("5000", 6));
      await base.pool.connect(base.trader).swap(
        ethers.parseEther("20000"), 0n, true, base.trader.address
      );
      await generateFees(base, ethers.parseUnits("8000", 6));
      await base.pool.connect(base.trader).openShort(
        ethers.parseUnits("3000", 6), 0n, base.trader.address
      );

      const totalFees = await base.pool.lpFeesAccumulated();
      await base.vault.harvest();

      const lpOwed = await base.vault.lpAccrued();
      const integratorOwed = await base.vault.integratorAccrued();

      // Conservation: nothing is created or lost in the split.
      expect(lpOwed + integratorOwed).to.equal(totalFees);
      expect(integratorOwed).to.equal((totalFees * INTEGRATOR_BPS) / BPS_DENOM);

      await base.vault.connect(base.lp).claimLpFees(base.lp.address);
      await base.vault.connect(base.integrator).claimIntegratorFees(base.integrator.address);

      // The vault holds nothing once both sides have withdrawn.
      expect(await base.usdc.balanceOf(base.vaultAddr)).to.equal(0n);
      expect(await base.vault.lpAccrued()).to.equal(0n);
      expect(await base.vault.integratorAccrued()).to.equal(0n);
    });

    it("keeps the liquidity locked no matter what happens to the market", async () => {
      const base = await loadFixture(withVaultFixture);

      await generateFees(base);
      await base.vault.harvest();
      await base.vault.connect(base.lp).claimLpFees(base.lp.address);

      // Reserves are still in the pool and unreachable.
      expect(await base.pool.backedAirUsd()).to.be.greaterThan(0n);
      await expect(
        base.pool.connect(base.lp).removeLiquidity()
      ).to.be.revertedWithCustomError(base.pool, "OnlyLpHolder");
      expect(await base.lpNft.ownerOf(0n)).to.equal(base.vaultAddr);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Audit IA-R2-7 / ECS-R2-3 — a failure to COLLECT must not become a failure to
// PAY OUT.
//
// Both claim paths harvest first. While that harvest was unconditional and
// strict, one reverting pool.claimFees froze USDC that had already been
// harvested and was already sitting in the vault: money with no dependency
// whatsoever on the failing call.
//
// Staged with the pool itself blacklisted, which is the shape that separates
// the two — the pool can no longer send USDC, while the vault can still send
// its own. Blacklisting the vault would block both directions and prove
// nothing about this.
// ═════════════════════════════════════════════════════════════════════════════

describe("LockedLpVault — pool-side failure", () => {
  async function blacklistablePoolVaultFixture() {
    const signers = await ethers.getSigners();
    const [deployer, treasury, lp, integrator, trader] = signers;
    const throwaway = signers[7];
    const sysDeployer = signers[8];

    const token = (await (await ethers.getContractFactory("MockERC20"))
      .connect(deployer).deploy("PEPE", "PEPE", 18)) as unknown as MockERC20;
    const usdc = await (await ethers.getContractFactory("BlacklistableERC20"))
      .connect(deployer).deploy("USD Coin", "USDC", 6);

    const positionNFT = (await (await ethers.getContractFactory("PositionNFT"))
      .connect(deployer).deploy()) as unknown as PositionNFT;
    const lpNft = (await (await ethers.getContractFactory("LpNFT"))
      .connect(throwaway).deploy(throwaway.address)) as unknown as LpNFT;
    const poolDeployer = await (await ethers.getContractFactory("PoolDeployer"))
      .connect(sysDeployer).deploy();

    const factory = (await (await ethers.getContractFactory("EXNIHILOFactory"))
      .connect(sysDeployer)
      .deploy(
        await positionNFT.getAddress(),
        await lpNft.getAddress(),
        await usdc.getAddress(),
        treasury.address,
        await poolDeployer.getAddress()
      )) as unknown as EXNIHILOFactory;

    const factoryAddr = await factory.getAddress();
    await patchImmutableAddress(await lpNft.getAddress(), throwaway.address, factoryAddr);
    await positionNFT.connect(deployer).initFactory(factoryAddr);

    await token.mint(lp.address, SEED_TOKEN);
    await usdc.mint(lp.address, SEED_USDC);
    await token.connect(lp).approve(factoryAddr, ethers.MaxUint256);
    await usdc.connect(lp).approve(factoryAddr, ethers.MaxUint256);
    await factory.connect(lp).createMarket(await token.getAddress(), SEED_USDC, SEED_TOKEN);
    await time.increase(24 * 3600);

    const poolAddr = await factory.allPools(0);
    const pool = (await ethers.getContractAt("EXNIHILOPool", poolAddr)) as unknown as EXNIHILOPool;

    await usdc.mint(trader.address, ethers.parseUnits("500000", 6));
    await usdc.connect(trader).approve(poolAddr, ethers.MaxUint256);

    const vault = (await (await ethers.getContractFactory("LockedLpVault"))
      .connect(deployer)
      .deploy(poolAddr, await lpNft.getAddress(), 0n,
        lp.address, integrator.address, INTEGRATOR_BPS)) as unknown as LockedLpVault;
    const vaultAddr = await vault.getAddress();
    await lpNft.connect(lp).transferFrom(lp.address, vaultAddr, 0n);

    return { usdc, pool, poolAddr, vault, vaultAddr, lp, integrator, trader, other: signers[5] };
  }

  /** Harvest once so a balance is banked, then leave more fees in the pool. */
  async function bankedThenBlocked() {
    const fix = await loadFixture(blacklistablePoolVaultFixture);

    await fix.pool.connect(fix.trader).openLong(
      ethers.parseUnits("10000", 6), 0n, fix.trader.address);
    await fix.vault.harvest();

    // More fees waiting in the pool, so the claim paths actually attempt the
    // pull rather than skipping it on the lpFeesAccumulated == 0 shortcut.
    await fix.pool.connect(fix.trader).openLong(
      ethers.parseUnits("10000", 6), 0n, fix.trader.address);

    await fix.usdc.blacklist(fix.poolAddr);
    return fix;
  }

  it("pays out a banked LP balance even though the pool can no longer send", async () => {
    const fix = await bankedThenBlocked();

    const owed = await fix.vault.lpAccrued();
    expect(owed, "the LP must have something banked for this to mean anything")
      .to.be.gt(0n);
    expect(await fix.pool.lpFeesAccumulated(), "and the pool must have more waiting")
      .to.be.gt(0n);

    const before = await fix.usdc.balanceOf(fix.lp.address);
    await expect(fix.vault.connect(fix.lp).claimLpFees(fix.lp.address))
      .to.emit(fix.vault, "PoolClaimFailed");

    expect((await fix.usdc.balanceOf(fix.lp.address)) - before).to.equal(owed);
    expect(await fix.vault.lpAccrued()).to.equal(0n);
  });

  it("pays out a banked integrator balance on the same terms", async () => {
    const fix = await bankedThenBlocked();

    const owed = await fix.vault.integratorAccrued();
    expect(owed).to.be.gt(0n);

    const before = await fix.usdc.balanceOf(fix.integrator.address);
    await fix.vault.connect(fix.integrator).claimIntegratorFees(fix.integrator.address);

    expect((await fix.usdc.balanceOf(fix.integrator.address)) - before).to.equal(owed);
    expect(await fix.vault.integratorAccrued()).to.equal(0n);
  });

  it("leaves the uncollected fees in the pool for a later harvest", async () => {
    const fix = await bankedThenBlocked();
    const stranded = await fix.pool.lpFeesAccumulated();

    await fix.vault.connect(fix.lp).claimLpFees(fix.lp.address);

    // Skipped, not lost: still on the pool's books, and collectable the moment
    // the pool can transfer again.
    expect(await fix.pool.lpFeesAccumulated()).to.equal(stranded);

    await fix.usdc.unblacklist(fix.poolAddr);
    await fix.vault.harvest();
    expect(await fix.pool.lpFeesAccumulated()).to.equal(0n);
    expect(await fix.vault.lpAccrued()).to.be.gt(0n);
  });

  it("still surfaces the failure to an explicit harvest", async () => {
    const fix = await bankedThenBlocked();

    // harvest() is strict: the caller asked for precisely the call that failed,
    // and nothing of theirs is being held hostage by saying so.
    await expect(fix.vault.harvest()).to.be.reverted;
  });

  it("is strict for a claimant with nothing banked", async () => {
    const fix = await loadFixture(blacklistablePoolVaultFixture);
    await fix.pool.connect(fix.trader).openLong(
      ethers.parseUnits("10000", 6), 0n, fix.trader.address);
    await fix.usdc.blacklist(fix.poolAddr);

    // Nothing banked, so the whole claim depends on the pull. Swallowing here
    // would report NothingToClaim and hide the real cause — and it is what
    // keeps the reentrancy guard's revert reaching the caller.
    await expect(fix.vault.connect(fix.lp).claimLpFees(fix.lp.address)).to.be.reverted;
  });
});
