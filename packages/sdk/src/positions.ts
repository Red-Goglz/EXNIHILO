import { positionNFTAbi, exnihiloPoolAbi } from "@exnihilio/abis";
import type { Address } from "viem";
import type { Ctx } from "./client.js";

export interface Position {
  tokenId: bigint;
  isLong: boolean;
  pool: Address;
  /**
   * Collateral AS AT OPEN — long: airToken, short: airUsd.
   *
   * This is NOT the position's current size. Funding decays every open position
   * on a side by the same factor every second, so the live figure is
   * `lockedAmountAtOpen * poolIndex / fundingIndexAtOpen`. Use
   * {@link getPositionState}, whose `lockedAmount` is the live one, or the
   * pool's own `liveAmountsOf`.
   */
  lockedAmountAtOpen: bigint;
  /** USDC notional at open, 6 dec. Decays with funding — see `notional`. */
  usdcIn: bigint;
  /** Long only: synthetic airUsd debt at open. Decays with funding — see `debt`. */
  airUsdMinted: bigint;
  /** Short only: synthetic airToken debt at open. Decays with funding — see `debt`. */
  airTokenMinted: bigint;
  /** Total fees paid to open. Funding is not a fee and is not counted here. */
  feesPaid: bigint;
  openedAt: bigint;
  /**
   * The pool's funding index for this position's side when it was minted, in
   * RAY. Replaces what used to be `deadline`: positions do not expire, they are
   * charged continuously instead.
   */
  fundingIndexAtOpen: bigint;
}

function decodePosition(tokenId: bigint, raw: readonly unknown[] | Record<string, unknown>): Position {
  const p = raw as Record<string, unknown>;
  return {
    tokenId,
    isLong: p.isLong as boolean,
    pool: p.pool as Address,
    lockedAmountAtOpen: p.lockedAmountAtOpen as bigint,
    usdcIn: p.usdcIn as bigint,
    airUsdMinted: p.airUsdMinted as bigint,
    airTokenMinted: p.airTokenMinted as bigint,
    feesPaid: p.feesPaid as bigint,
    openedAt: p.openedAt as bigint,
    fundingIndexAtOpen: p.fundingIndexAtOpen as bigint,
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
  /** Close quote, clamped as a close sent now settles. `ready` false means it cannot be settled right now. */
  close: { ready: boolean; pnl: bigint };
  /**
   * True when the position is in profit at live reserves but a price move in
   * the last few blocks is holding the close back. It clears on its own within
   * CLAMP_BLOCKS; tell the holder to retry shortly rather than that they are
   * losing.
   */
  closeHeldBack: boolean;
  /**
   * Collateral backing the position RIGHT NOW, net of all funding charged since
   * it opened — including funding the pool has accrued but not yet written to
   * storage. This is the number to show a holder.
   */
  lockedAmount: bigint;
  /**
   * Synthetic debt left RIGHT NOW — airUsd for a long, airToken for a short.
   * Funding shrinks it in step with the collateral, which is why the position's
   * break-even price never moves.
   */
  debt: bigint;
  /** USDC notional left RIGHT NOW, 6 dec. Shrinks in step with the collateral. */
  notional: bigint;
  /**
   * What the position has left as a fraction of its opening size, in bps — the
   * same for collateral, debt and notional. 10000 means funding has taken
   * nothing yet; 0 means the position is gone. The honest headline for what
   * holding has cost.
   */
  remainingBps: bigint;
  /** True once the position has decayed far enough for anyone to sweep it. */
  isDust: boolean;
}

/**
 * Position plus everything needed to render it: owner, live PnL, and the size
 * funding has left it.
 */
export async function getPositionState(
  ctx: Ctx,
  tokenId: bigint
): Promise<PositionState> {
  const position = await getPosition(ctx, tokenId);

  const [owner, closeRaw, live, remainingBps, unclampedRaw] = (await ctx.publicClient.multicall({
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
      {
        address: position.pool,
        abi: exnihiloPoolAbi,
        functionName: "liveAmountsOf",
        args: [tokenId],
      },
      {
        address: position.pool,
        abi: exnihiloPoolAbi,
        functionName: "remainingSizeBps",
        args: [tokenId],
      },
      {
        address: position.pool,
        abi: exnihiloPoolAbi,
        functionName: "quoteCloseUnclamped",
        args: [tokenId],
      },
    ],
    allowFailure: false,
  })) as [Address, [boolean, bigint], readonly [bigint, bigint, bigint], bigint, [boolean, bigint]];

  const canClose = closeRaw[0] && closeRaw[1] > 0n;
  const liveInProfit = unclampedRaw[0] && unclampedRaw[1] > 0n;

  return {
    ...position,
    owner,
    close: { ready: closeRaw[0], pnl: closeRaw[1] },
    closeHeldBack: liveInProfit && !canClose,
    lockedAmount: live[0],
    debt: live[1],
    notional: live[2],
    remainingBps,
    // Strictly below: remainingBps rounds down, so a reading of 10 can still be
    // refused by sweepDust.
    isDust: remainingBps < 10n,
  };
}


