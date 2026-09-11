import { positionNFTAbi, exnihiloPoolAbi } from "@exnihilio/abis";
import type { Address } from "viem";
import type { Ctx } from "./client.js";

export interface Position {
  tokenId: bigint;
  isLong: boolean;
  pool: Address;
  /** Long: airToken locked. Short: airUsd locked. */
  lockedAmount: bigint;
  /** USDC notional at open, 6 dec. */
  usdcIn: bigint;
  airUsdMinted: bigint;
  airTokenMinted: bigint;
  /** Cumulative fees paid, including renewals. */
  feesPaid: bigint;
  openedAt: bigint;
  /** Unix seconds after which the position can be settled by anyone. */
  deadline: bigint;
}

function decodePosition(tokenId: bigint, raw: readonly unknown[] | Record<string, unknown>): Position {
  const p = raw as Record<string, unknown>;
  return {
    tokenId,
    isLong: p.isLong as boolean,
    pool: p.pool as Address,
    lockedAmount: p.lockedAmount as bigint,
    usdcIn: p.usdcIn as bigint,
    airUsdMinted: p.airUsdMinted as bigint,
    airTokenMinted: p.airTokenMinted as bigint,
    feesPaid: p.feesPaid as bigint,
    openedAt: p.openedAt as bigint,
    deadline: p.deadline as bigint,
  };
}

/** Read one position by NFT id. */
export async function getPosition(ctx: Ctx, tokenId: bigint): Promise<Position> {
  const raw = await ctx.publicClient.readContract({
    address: ctx.addresses.positionNFT,
    abi: positionNFTAbi,
    functionName: "getPosition",
    args: [tokenId],
  });
  return decodePosition(tokenId, raw as Record<string, unknown>);
}

/** Current owner of a position NFT. Positions are transferable. */
export async function getPositionOwner(ctx: Ctx, tokenId: bigint): Promise<Address> {
  return ctx.publicClient.readContract({
    address: ctx.addresses.positionNFT,
    abi: positionNFTAbi,
    functionName: "ownerOf",
    args: [tokenId],
  }) as Promise<Address>;
}

export interface PositionState extends Position {
  owner: Address;
  /** Live close quote. `ready` false means it cannot be settled right now. */
  close: { ready: boolean; pnl: bigint };
  /** True once `deadline` has passed and anyone may settle it. */
  isExpired: boolean;
  /** Seconds until expiry, 0 once expired. */
  secondsToExpiry: bigint;
}

/**
 * Position plus everything needed to render it: owner, live PnL and expiry.
 *
 * @param nowSeconds Current unix time, passed in so React callers stay pure.
 */
export async function getPositionState(
  ctx: Ctx,
  tokenId: bigint,
  nowSeconds: bigint
): Promise<PositionState> {
  const position = await getPosition(ctx, tokenId);

  const [owner, closeRaw] = (await ctx.publicClient.multicall({
    contracts: [
      {
        address: ctx.addresses.positionNFT,
        abi: positionNFTAbi,
        functionName: "ownerOf",
        args: [tokenId],
      },
      {
        address: position.pool,
        abi: exnihiloPoolAbi,
        functionName: "quoteClose",
        args: [tokenId],
      },
    ],
    allowFailure: false,
  })) as [Address, [boolean, bigint]];

  const isExpired = nowSeconds >= position.deadline;

  return {
    ...position,
    owner,
    close: { ready: closeRaw[0], pnl: closeRaw[1] },
    isExpired,
    secondsToExpiry: isExpired ? 0n : position.deadline - nowSeconds,
  };
}

/**
 * Auto-renew preference for a position.
 *
 * Renewal is funded from the position's own equity, so a profitable position
 * can roll without the holder sending USDC. `maxFee` caps what the holder will
 * let a renewal cost.
 */
export async function getAutoRenew(
  ctx: Ctx,
  tokenId: bigint
): Promise<{ enabled: boolean; maxFee: bigint }> {
  const [enabled, maxFee] = (await ctx.publicClient.readContract({
    address: ctx.addresses.positionNFT,
    abi: positionNFTAbi,
    functionName: "getAutoRenew",
    args: [tokenId],
  })) as [boolean, bigint];
  return { enabled, maxFee };
}
