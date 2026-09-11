import { lockedLpVaultAbi } from "@exnihilio/abis";
import type { Address, Hash } from "viem";
import { requireAccount, requireWallet, type Ctx } from "./client.js";

/**
 * LockedLpVault — where a launched market's LP NFT lives.
 *
 * The vault contains no code path that withdraws liquidity, so holding the NFT
 * there is economically identical to burning it. Unlike a burn, the fee stream
 * survives: `claimFees` stays reachable and is split between the project (the
 * LP owner) and the launchpad (the integrator).
 *
 * The vault's only income is the pool's LP fee stream — 4 % of notional on
 * every open and renewal, plus the whole impact fee. Protocol fees go to the
 * factory's treasury and are not part of this. Swap fees are retained in the
 * pool's reserves, so with a locked LP they permanently deepen the market
 * rather than becoming claimable.
 */

export interface VaultInfo {
  address: Address;
  pool: Address;
  usdc: Address;
  lpNftId: bigint;
  /** Claims the LP share. Transferable by its current holder. */
  lp: Address;
  /** Claims the integrator share. Zero when there is no integrator. */
  integrator: Address;
  /** Integrator's share of the LP fee stream in bps. Immutable. */
  integratorBps: bigint;
  lpAccrued: bigint;
  integratorAccrued: bigint;
  lpClaimedTotal: bigint;
  integratorClaimedTotal: bigint;
  harvestedTotal: bigint;
  /** True once the LP NFT has actually been transferred in. */
  isFunded: boolean;
}

export async function getVault(ctx: Ctx, vault: Address): Promise<VaultInfo> {
  const c = { address: vault, abi: lockedLpVaultAbi } as const;

  const r = await ctx.publicClient.multicall({
    contracts: [
      { ...c, functionName: "pool" },
      { ...c, functionName: "usdc" },
      { ...c, functionName: "lpNftId" },
      { ...c, functionName: "lp" },
      { ...c, functionName: "integrator" },
      { ...c, functionName: "integratorBps" },
      { ...c, functionName: "lpAccrued" },
      { ...c, functionName: "integratorAccrued" },
      { ...c, functionName: "lpClaimedTotal" },
      { ...c, functionName: "integratorClaimedTotal" },
      { ...c, functionName: "harvestedTotal" },
      { ...c, functionName: "isFunded" },
    ],
    allowFailure: false,
  });

  return {
    address: vault,
    pool: r[0] as Address,
    usdc: r[1] as Address,
    lpNftId: r[2] as bigint,
    lp: r[3] as Address,
    integrator: r[4] as Address,
    integratorBps: r[5] as bigint,
    lpAccrued: r[6] as bigint,
    integratorAccrued: r[7] as bigint,
    lpClaimedTotal: r[8] as bigint,
    integratorClaimedTotal: r[9] as bigint,
    harvestedTotal: r[10] as bigint,
    isFunded: r[11] as boolean,
  };
}

/**
 * What each side would hold after harvesting right now — already-accrued
 * balance plus their share of what is still sitting unclaimed in the pool.
 *
 * This is the number to show an integrator: `integratorAccrued` alone
 * understates it, because fees only move into the vault when someone harvests.
 */
export async function getPendingFees(
  ctx: Ctx,
  vault: Address
): Promise<{ lp: bigint; integrator: bigint }> {
  const [lp, integrator] = (await ctx.publicClient.readContract({
    address: vault,
    abi: lockedLpVaultAbi,
    functionName: "pending",
  })) as [bigint, bigint];
  return { lp, integrator };
}

/**
 * Pull the pool's accrued LP fees into the vault and split them.
 *
 * Permissionless — proceeds can only ever reach the LP owner and the
 * integrator, so anyone may trigger it. Rarely needed on its own, since both
 * claim functions harvest first.
 */
export async function harvest(ctx: Ctx, vault: Address): Promise<Hash> {
  const wallet = requireWallet(ctx, "harvest");
  const account = requireAccount(ctx, "harvest");

  return wallet.writeContract({
    address: vault,
    abi: lockedLpVaultAbi,
    functionName: "harvest",
    account,
    chain: wallet.chain,
  });
}

/**
 * Claim the integrator's share. Caller must be the current `integrator`.
 * Harvests first, so one call collects everything owed.
 *
 * @param to Destination, separate from the claiming address so a party that
 *           cannot receive USDC directly can redirect its own balance.
 */
export async function claimIntegratorFees(
  ctx: Ctx,
  vault: Address,
  to?: Address
): Promise<Hash> {
  const wallet = requireWallet(ctx, "claimIntegratorFees");
  const account = requireAccount(ctx, "claimIntegratorFees");

  return wallet.writeContract({
    address: vault,
    abi: lockedLpVaultAbi,
    functionName: "claimIntegratorFees",
    args: [to ?? account],
    account,
    chain: wallet.chain,
  });
}

/** Claim the LP owner's share. Caller must be the current `lp`. */
export async function claimLpFees(ctx: Ctx, vault: Address, to?: Address): Promise<Hash> {
  const wallet = requireWallet(ctx, "claimLpFees");
  const account = requireAccount(ctx, "claimLpFees");

  return wallet.writeContract({
    address: vault,
    abi: lockedLpVaultAbi,
    functionName: "claimLpFees",
    args: [to ?? account],
    account,
    chain: wallet.chain,
  });
}

/**
 * Hand the integrator claim role to another address — key rotation, or moving
 * to a multisig. Only the current holder may call it.
 *
 * Any balance already accrued goes with the role. Claim first if that is not
 * intended. The role gates a claim destination only: it cannot withdraw
 * liquidity, change the split, or affect the LP side.
 */
export async function setIntegrator(
  ctx: Ctx,
  vault: Address,
  newIntegrator: Address
): Promise<Hash> {
  const wallet = requireWallet(ctx, "setIntegrator");
  const account = requireAccount(ctx, "setIntegrator");

  return wallet.writeContract({
    address: vault,
    abi: lockedLpVaultAbi,
    functionName: "setIntegrator",
    args: [newIntegrator],
    account,
    chain: wallet.chain,
  });
}

/** Hand the LP claim role to another address. Only the current holder. */
export async function setLp(ctx: Ctx, vault: Address, newLp: Address): Promise<Hash> {
  const wallet = requireWallet(ctx, "setLp");
  const account = requireAccount(ctx, "setLp");

  return wallet.writeContract({
    address: vault,
    abi: lockedLpVaultAbi,
    functionName: "setLp",
    args: [newLp],
    account,
    chain: wallet.chain,
  });
}
