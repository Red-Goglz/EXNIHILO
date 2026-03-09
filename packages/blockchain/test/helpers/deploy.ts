/**
 * Shared deployment helper for EXNIHILOFactory and EXNIHILOPool tests.
 *
 * Architecture constraint
 * ──────────────────────
 * LpNFT.factory is an immutable set to msg.sender at construction.
 * EXNIHILOFactory.createMarket() calls lpNftContract.mint(), which requires
 * msg.sender == lpNft.factory.  Therefore LpNFT.factory must equal the
 * EXNIHILOFactory address.
 *
 * The naive approach (impersonate the predicted factory address, deploy LpNFT
 * from it) fails because of EIP-161: impersonating that address to deploy LpNFT
 * increments its nonce to 1, which prevents any subsequent CREATE from landing
 * at the same address (EVM rejects CREATE to an address with nonce != 0).
 *
 * Bytecode-patch approach (no contract modifications required)
 * ────────────────────────────────────────────────────────────
 *   1.  Deploy LpNFT from a dedicated throwaway signer (signers[7]).
 *       LpNFT.factory = throwaway.address  (baked into deployed bytecode)
 *   2.  Deploy EXNIHILOFactory from sysDeployer (signers[8]) at nonce 0.
 *       The factory address is predictable and has no nonce conflict.
 *   3.  Read LpNFT's deployed bytecode and replace the embedded throwaway
 *       address with the real factory address using hardhat_setCode.
 *   4.  Assert lpNft.factory() == factory.address to confirm the patch.
 *
 * Immutable layout in deployed bytecode
 * ──────────────────────────────────────
 *   Solidity stores address immutables as 32-byte (64 hex chars) zero-left-padded
 *   values directly in the deployed bytecode.
 *   Pattern to replace:  "000000000000000000000000" + throwaway.address.toLowerCase()[2:]
 *   Replace with:        "000000000000000000000000" + factory.address.toLowerCase()[2:]
 */

import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { EXNIHILOFactory, LpNFT, PositionNFT, MockERC20 } from "../../typechain-types";

export const SWAP_FEE_BPS = 100n; // 1 %

/**
 * Patch an immutable address value baked into deployed EVM bytecode.
 *
 * Immutable addresses are stored in deployed bytecode as 32-byte (64 hex
 * character) zero-left-padded values:
 *   000000000000000000000000<20-byte-address>
 *
 * This helper reads the bytecode at `contractAddress`, replaces every
 * occurrence of the `from` address with the `to` address (both zero-padded),
 * and writes the patched bytecode back with hardhat_setCode.
 */
async function patchImmutableAddress(
  contractAddress: string,
  fromAddress: string,
  toAddress: string
): Promise<void> {
  const bytecode = await ethers.provider.getCode(contractAddress);

  // Remove "0x" prefix for manipulation.
  const raw = bytecode.slice(2).toLowerCase();

  // Zero-padded 32-byte representations (no "0x" prefix).
  const fromPadded = "000000000000000000000000" + fromAddress.toLowerCase().slice(2);
  const toPadded   = "000000000000000000000000" + toAddress.toLowerCase().slice(2);

  if (!raw.includes(fromPadded)) {
    throw new Error(
      `patchImmutableAddress: address ${fromAddress} not found in bytecode of ${contractAddress}.\n` +
      `Searched for: ${fromPadded}`
    );
  }

  // Replace all occurrences (there is typically exactly one per immutable).
  const patched = raw.split(fromPadded).join(toPadded);

  await ethers.provider.send("hardhat_setCode", [contractAddress, "0x" + patched]);
}

/**
 * Deploy the full protocol system with a correctly wired LpNFT.
 *
 * @param deployer  Signer used for MockERC20 and PositionNFT deployment.
 * @param treasury  Address that receives protocol fees.
 */
export async function deployProtocol(
  deployer: HardhatEthersSigner,
  treasury: HardhatEthersSigner
): Promise<{
  factory: EXNIHILOFactory;
  positionNFT: PositionNFT;
  lpNft: LpNFT;
  memeToken: MockERC20;
  usdc: MockERC20;
}> {
  const signers = await ethers.getSigners();

  // ── 1. Contracts that don't depend on the factory ─────────────────────────
  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const memeToken = (await MockERC20F.connect(deployer).deploy(
    "PEPE", "PEPE", 18
  )) as MockERC20;
  const usdc = (await MockERC20F.connect(deployer).deploy(
    "USD Coin", "USDC", 6
  )) as MockERC20;
  const positionNFT = (await (
    await ethers.getContractFactory("PositionNFT")
  ).connect(deployer).deploy()) as PositionNFT;

  // ── 2. Deploy LpNFT from a throwaway signer ────────────────────────────────
  // signers[7] is used here as a throwaway signer.  Its address will be
  // temporarily embedded in LpNFT.factory, then overwritten in step 4.
  // IMPORTANT: signers[7] must NOT be used for any other deployment in the
  // fixture chain, otherwise the LpNFT bytecode might contain its address in
  // another context.  Signers[7] is reserved for this role only.
  const throwaway = signers[7];
  const lpNft = (await (
    await ethers.getContractFactory("LpNFT")
  ).connect(throwaway).deploy()) as LpNFT;

  // Confirm the initial (wrong) factory reference.
  const initialFactory = await lpNft.factory();
  if (initialFactory.toLowerCase() !== throwaway.address.toLowerCase()) {
    throw new Error(
      `LpNFT.factory mismatch after initial deploy.\n` +
      `  expected: ${throwaway.address}\n  actual: ${initialFactory}`
    );
  }

  // ── 3. Deploy EXNIHILOFactory from sysDeployer ────────────────────────────
  // signers[8] is used as a dedicated system deployer whose nonce is always
  // 0 at the start of each fixture (reset by loadFixture snapshot).
  const sysDeployer = signers[8];
  const FactoryF = await ethers.getContractFactory("EXNIHILOFactory");
  const factory = (await FactoryF.connect(sysDeployer).deploy(
    await positionNFT.getAddress(),
    await lpNft.getAddress(),
    await usdc.getAddress(),
    treasury.address,
    SWAP_FEE_BPS
  )) as EXNIHILOFactory;

  const factoryAddr = await factory.getAddress();

  // ── 4. Patch LpNFT bytecode to replace throwaway address with factory addr ─
  await patchImmutableAddress(
    await lpNft.getAddress(),
    throwaway.address,
    factoryAddr
  );

  // ── 5. Verify the patch took effect ───────────────────────────────────────
  const patchedFactory = await lpNft.factory();
  if (patchedFactory.toLowerCase() !== factoryAddr.toLowerCase()) {
    throw new Error(
      `LpNFT.factory mismatch after bytecode patch.\n` +
      `  expected: ${factoryAddr}\n  actual: ${patchedFactory}`
    );
  }

  return { factory, positionNFT, lpNft, memeToken, usdc };
}
