import { exnihiloPoolAbi } from "@exnihilio/abis";
import type { Address, Hash } from "viem";
import { requireAccount, requireWallet, type Ctx } from "./client.js";

/**
 * Maintenance operations. Not part of the partner-facing surface, but shipped
 * because someone has to run them.
 *
 * This module used to be the keeper interface: positions expired, and somebody
 * had to settle them or open interest never decremented and the impact fee
 * priced off a book that was no longer real. Positions no longer expire, and
 * funding retires them continuously instead, so nothing here is on a clock.
 *
 * What is left is two chores, neither urgent:
 *
 *   pokeFunding  realises accrued funding into the reserves. Never required —
 *                every trade does it — but a pool that has not traded for a
 *                while is carrying funding the LP is owed and the holders have
 *                not yet paid, and anyone may realise it without trading.
 *
 *   sweepDust    clears a position funding has decayed to dust. Its debt
 *                decays with it, so it no longer distorts anyone's price, but it
 *                still holds a slot in openPositionCount — and the LP cannot
 *                withdraw until every slot is released.
 *
 * Both are unpaid. The party with the motive is the LP, whose withdrawal a dead
 * position blocks — which is why neither needs a bounty to be run.
 */

/**
 * Charge funding to both sides up to the current block.
 *
 * Idempotent in effect: calling it twice in a block does nothing the second
 * time, and never calling it costs nobody anything, because the next trade
 * charges the same total. The charge for a stretch of time is the same however
 * many pieces it is accrued in.
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
 * Clear a position whose collateral has decayed to dust. Anyone may call it.
 *
 * Reverts `PositionNotDust` until the position has fallen below 0.1 % of the
 * collateral it opened with. That threshold is measured against the position's
 * own opening size rather than against its claim, so it cannot be reached by
 * pushing the mark down — only by funding, which no caller controls.
 *
 * Any residual claim is credited to the holder as a pull payment rather than
 * transferred, so the sweep cannot be blocked by the holder's wallet and cannot
 * be used to take value.
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
