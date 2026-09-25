import { exnihiloPoolAbi } from "@exnihilio/abis";
import type { Address, Hash } from "viem";
import { requireAccount, requireWallet, type Ctx } from "./client.js";

/**
 * Maintenance: unpaid, never urgent, permissionless. The LP has the motive —
 * a position that is still open blocks removeLiquidity.
 */

/**
 * Write accrued funding into the reserves without trading. Never required:
 * every trade accrues first. Accruing more often can only lower a side's
 * charge slightly, never raise it (see docs: Funding).
 */
export async function pokeFunding(ctx: Ctx, pool: Address): Promise<Hash> {
  const wallet = requireWallet(ctx, "pokeFunding");
  const account = requireAccount(ctx, "pokeFunding");

  const { request } = await ctx.publicClient.simulateContract({
    address: pool,
    abi: exnihiloPoolAbi,
    functionName: "pokeFunding",
    account,
  });
  return wallet.writeContract(request);
}

/**
 * Clear a position funding has decayed to 0.1 % of its opening collateral;
 * reverts `PositionNotDust` before that. Any residual payout is credited to the
 * holder (`claimPayout`), priced at sweep time.
 */
export async function sweepDust(
  ctx: Ctx,
  pool: Address,
  tokenId: bigint
): Promise<Hash> {
  const wallet = requireWallet(ctx, "sweepDust");
  const account = requireAccount(ctx, "sweepDust");

  const { request } = await ctx.publicClient.simulateContract({
    address: pool,
    abi: exnihiloPoolAbi,
    functionName: "sweepDust",
    args: [tokenId],
    account,
  });
  return wallet.writeContract(request);
}

/**
 * sweepDust over a list. Entries already gone, from another pool or not yet
 * dust are skipped, not reverted. Work is linear, so chunk large books.
 */
export async function sweepDustBatch(
  ctx: Ctx,
  pool: Address,
  tokenIds: readonly bigint[]
): Promise<Hash> {
  const wallet = requireWallet(ctx, "sweepDustBatch");
  const account = requireAccount(ctx, "sweepDustBatch");

  const { request } = await ctx.publicClient.simulateContract({
    address: pool,
    abi: exnihiloPoolAbi,
    functionName: "sweepDustBatch",
    args: [tokenIds],
    account,
  });
  return wallet.writeContract(request);
}

/**
 * Fraction of its opening collateral a position still has, in bps.
 * 10000 = untouched, 0 = fully decayed. Below 10 it is sweepable.
 */
export async function remainingSizeBps(
  ctx: Ctx,
  pool: Address,
  tokenId: bigint
): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: pool,
    abi: exnihiloPoolAbi,
    functionName: "remainingSizeBps",
    args: [tokenId],
  }) as Promise<bigint>;
}

/** True when `sweepDust` would succeed for this position right now. */
export async function canSweep(
  ctx: Ctx,
  pool: Address,
  tokenId: bigint
): Promise<boolean> {
  // Strictly below: remainingSizeBps rounds down, so a reading of 10 can be
  // anything up to 10.99 bps, which sweepDust still refuses.
  return (await remainingSizeBps(ctx, pool, tokenId)) < 10n;
}
