import { exnihiloPoolAbi, exnihiloRouterAbi, erc20Abi } from "@exnihilio/abis";
import type { Address, Hash } from "viem";
import { requireAccount, requireWallet, type Ctx } from "./client.js";

// ─────────────────────────────────────────────────────────────────────────────
// Quotes
//
// Every quote proxies to the pool. Fee maths is never reimplemented here: the
// base fee has a floor, the impact fee depends on live open interest and
// reserves, and funding reprices against live open interest and depth.
// A client-side copy would drift the moment any of those move.
// ─────────────────────────────────────────────────────────────────────────────

/** Total USDC fee to open a position of `notional` right now. */
export async function quoteOpenFee(
  ctx: Ctx,
  pool: Address,
  notional: bigint,
  isLong: boolean
): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: pool,
    abi: exnihiloPoolAbi,
    functionName: "quoteOpenFee",
    args: [notional, isLong],
  }) as Promise<bigint>;
}

export interface CloseQuote {
  /**
   * False when current reserves cannot price the position at all. `pnl` then
   * carries an estimated shortfall and is display-only.
   */
  ready: boolean;
  /** USDC (6 dec). Positive = payout on close, net of the 1 % close fee. */
  pnl: bigint;
}

/** Live close quote, mirroring settlement maths exactly. */
export async function quoteClose(
  ctx: Ctx,
  pool: Address,
  tokenId: bigint
): Promise<CloseQuote> {
  const [ready, pnl] = (await ctx.publicClient.readContract({
    address: pool,
    abi: exnihiloPoolAbi,
    functionName: "quoteClose",
    args: [tokenId],
  })) as [boolean, bigint];
  return { ready, pnl };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-flight
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenPreflight {
  ok: boolean;
  /** Present when `ok` is false. Safe to show a user verbatim. */
  reason?: string;
  fee: bigint;
  /** Notional + fee. The USDC that must be approved and available. */
  totalRequired: bigint;
  cap: bigint;
}

/**
 * Check an open before sending it. Catches the two failures that actually
 * happen in production — over the position cap, and insufficient allowance or
 * balance — with a message worth showing rather than a bare revert.
 */
export async function preflightOpen(
  ctx: Ctx,
  pool: Address,
  notional: bigint,
  isLong: boolean,
  account: Address,
  spender: Address
): Promise<OpenPreflight> {
  const [fee, cap, closeDate, usdc] = (await ctx.publicClient.multicall({
    contracts: [
      { address: pool, abi: exnihiloPoolAbi, functionName: "quoteOpenFee", args: [notional, isLong] },
      { address: pool, abi: exnihiloPoolAbi, functionName: "effectiveLeverageCap" },
      { address: pool, abi: exnihiloPoolAbi, functionName: "closeDate" },
      { address: pool, abi: exnihiloPoolAbi, functionName: "underlyingUsdc" },
    ],
    allowFailure: false,
  })) as [bigint, bigint, bigint, Address];

  const totalRequired = notional + fee;

  const [balance, allowance] = (await ctx.publicClient.multicall({
    contracts: [
      { address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account] },
      { address: usdc, abi: erc20Abi, functionName: "allowance", args: [account, spender] },
    ],
    allowFailure: false,
  })) as [bigint, bigint];

  const base = { fee, totalRequired, cap };

  if (closeDate !== 0n) {
    return { ...base, ok: false, reason: "This market is closing; no new positions can be opened." };
  }
  if (notional > cap) {
    return {
      ...base,
      ok: false,
      reason:
        `Position cap is ${cap} USDC right now. The cap starts at 1 % of pool ` +
        `depth and widens to 20 % over the first 24 hours after a market opens.`,
    };
  }
  if (balance < totalRequired) {
    return { ...base, ok: false, reason: `Need ${totalRequired} USDC (notional + fee), have ${balance}.` };
  }
  if (allowance < totalRequired) {
    return { ...base, ok: false, reason: `USDC allowance is ${allowance}, need ${totalRequired}.` };
  }
  return { ...base, ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Trading
//
// Opens route through EXNIHILORouter so a user approves USDC once rather than
// per pool. Closes are holder-gated and go straight to the pool.
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenArgs {
  pool: Address;
  /** USDC notional, 6 dec. */
  notional: bigint;
  /** Slippage guard on what the position locks. 0 accepts any outcome. */
  minAmountOut?: bigint;
}

/** Open a long. Requires USDC approved to the router. */
export async function openLong(ctx: Ctx, args: OpenArgs): Promise<Hash> {
  const wallet = requireWallet(ctx, "openLong");
  const account = requireAccount(ctx, "openLong");

  return wallet.writeContract({
    address: ctx.addresses.router,
    abi: exnihiloRouterAbi,
    functionName: "openLong",
    args: [args.pool, args.notional, args.minAmountOut ?? 0n],
    account,
    chain: wallet.chain,
  });
}

/** Open a short. Requires USDC approved to the router. */
export async function openShort(ctx: Ctx, args: OpenArgs): Promise<Hash> {
  const wallet = requireWallet(ctx, "openShort");
  const account = requireAccount(ctx, "openShort");

  return wallet.writeContract({
    address: ctx.addresses.router,
    abi: exnihiloRouterAbi,
    functionName: "openShort",
    args: [args.pool, args.notional, args.minAmountOut ?? 0n],
    account,
    chain: wallet.chain,
  });
}

/**
 * Close a position. Only the holder may call this, and only against the pool
 * that issued it. `isLong` picks the entry point; read it from `getPosition`.
 *
 * @param to Where the profit is sent. Defaults to the caller. Pass something
 *           else when the holder's own wallet cannot receive USDC — there is no
 *           expiry path to fall back on, so this is the holder's only escape.
 */
export async function closePosition(
  ctx: Ctx,
  pool: Address,
  tokenId: bigint,
  isLong: boolean,
  minUsdcOut = 0n,
  to?: Address
): Promise<Hash> {
  const wallet = requireWallet(ctx, "closePosition");
  const account = requireAccount(ctx, "closePosition");

  return wallet.writeContract({
    address: pool,
    abi: exnihiloPoolAbi,
    functionName: isLong ? "closeLong" : "closeShort",
    args: [tokenId, minUsdcOut, to ?? account],
    account,
    chain: wallet.chain,
  });
}

/** Spot swap through the router. Not leveraged; no position is created. */
export async function swap(
  ctx: Ctx,
  pool: Address,
  amountIn: bigint,
  tokenToUsdc: boolean,
  minAmountOut = 0n
): Promise<Hash> {
  const wallet = requireWallet(ctx, "swap");
  const account = requireAccount(ctx, "swap");

  return wallet.writeContract({
    address: ctx.addresses.router,
    abi: exnihiloRouterAbi,
    functionName: "swap",
    args: [pool, amountIn, minAmountOut, tokenToUsdc],
    account,
    chain: wallet.chain,
  });
}

/**
 * Withdraw USDC credited to you when `sweepDust` cleared a position of yours
 * that still had a residual claim. Payouts are pull, not push, so a sweep never
 * fails because a recipient cannot receive USDC.
 */
export async function claimPayout(ctx: Ctx, pool: Address, to: Address): Promise<Hash> {
  const wallet = requireWallet(ctx, "claimPayout");
  const account = requireAccount(ctx, "claimPayout");

  return wallet.writeContract({
    address: pool,
    abi: exnihiloPoolAbi,
    functionName: "claimPayout",
    args: [to],
    account,
    chain: wallet.chain,
  });
}
