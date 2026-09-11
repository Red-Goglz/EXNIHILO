import { exnihiloPoolAbi } from "@exnihilio/abis";
import type { Address, Hash } from "viem";
import { requireAccount, requireWallet, type Ctx } from "./client.js";

/**
 * Keeper operations. Not part of the partner-facing surface, but shipped
 * because someone has to run them.
 *
 * `settleExpired` is permissionless and is what clears expired positions from a
 * pool's book. Open interest only decrements on settlement, and the impact fee
 * is priced off open interest — so a market nobody sweeps becomes progressively
 * more expensive to trade.
 *
 * With the LP NFT locked in a vault, no participant has a natural incentive to
 * do this: fee recipients are, if anything, mildly better off with inflated
 * open interest. The cost lands on traders as slow competitive decay. Whoever
 * operates a market should run this.
 */

/**
 * Settle an expired position. Anyone may call it once the deadline has passed.
 *
 * If the holder opted into auto-renew and the position's own equity covers the
 * renewal fee plus margin, this renews rather than closes.
 *
 * @param minPayout Slippage guard on the holder's credited payout when the
 *                  close path runs. 0 accepts any outcome.
 */
export async function settleExpired(
  ctx: Ctx,
  pool: Address,
  tokenId: bigint,
  minPayout = 0n
): Promise<Hash> {
  const wallet = requireWallet(ctx, "settleExpired");
  const account = requireAccount(ctx, "settleExpired");

  const { request } = await ctx.publicClient.simulateContract({
    address: pool,
    abi: exnihiloPoolAbi,
    functionName: "settleExpired",
    args: [tokenId, minPayout],
    account,
  });
  return wallet.writeContract(request);
}

/**
 * First block at which a third party may settle an expired position on this
 * pool. `0` means unguarded right now.
 *
 * A move of at least 1 % in either settlement price within a single block arms
 * a 5-block guard, which blocks third-party settlement so an expired position
 * cannot be settled at a price the settler just moved. Poll this rather than
 * discovering the window through a reverted `settleExpired` — the position
 * holder is never blocked, so this only applies to keepers.
 */
export async function settlementGuardedUntilBlock(
  ctx: Ctx,
  pool: Address
): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: pool,
    abi: exnihiloPoolAbi,
    functionName: "settlementGuardedUntilBlock",
  }) as Promise<bigint>;
}

/**
 * Relative move, in bps, that either settlement price must make within one
 * block to arm the guard.
 *
 * There is no "size that arms". Arming is the net displacement of
 * backedAirUsd / airTokenSupply or backedAirToken / airUsdSupply since the
 * block opened, from any reserve-mutating path — not a property of one call.
 */
export async function settlementGuardBps(
  ctx: Ctx,
  pool: Address
): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: pool,
    abi: exnihiloPoolAbi,
    functionName: "settlementGuardBps",
  }) as Promise<bigint>;
}

/** True when a keeper can settle on this pool right now. */
export async function canSettleNow(ctx: Ctx, pool: Address): Promise<boolean> {
  const [until, current] = await Promise.all([
    settlementGuardedUntilBlock(ctx, pool),
    ctx.publicClient.getBlockNumber(),
  ]);
  return until === 0n || current >= until;
}
