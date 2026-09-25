import { exnihiloPoolAbi, exnihiloRouterAbi, erc20Abi } from "@exnihilio/abis";
import type { Address, Hash } from "viem";
import { requireAccount, requireWallet, type Ctx } from "./client.js";

// ─────────────────────────────────────────────────────────────────────────────
// Quotes — every one proxies to the pool; fee maths is never reimplemented here.
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

export interface OpenQuote {
  /** Collateral the position would lock: airToken (long) or airUsd (short). */
  locked: bigint;
  /** What it would owe: airUsd (long, equal to the notional) or airToken (short). */
  debt: bigint;
}

/**
 * What an open sent now would lock, priced as the pool will price it: at the
 * worst of live reserves and the last few block opens (see CLAMP_BLOCKS). A
 * floor, so `locked` less a slippage margin is a safe `minAmountOut`.
 */
export async function quoteOpen(
  ctx: Ctx,
  pool: Address,
  notional: bigint,
  isLong: boolean
): Promise<OpenQuote> {
  const [locked, debt] = (await ctx.publicClient.readContract({
    address: pool,
    abi: exnihiloPoolAbi,
    functionName: "quoteOpen",
    args: [notional, isLong],
  })) as [bigint, bigint];
  return { locked, debt };
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

/**
 * Close quote as a close sent now would settle, including the close-price
 * clamp (see CLAMP_BLOCKS). This is what a close pays, and what gates it.
 */
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

/**
 * Close quote at live reserves, without the clamp. Not what a close pays now:
 * use it only to tell a real loss from a close a recent price move is holding
 * back. When this is in profit and `quoteClose` is not, retry within a few
 * blocks.
 */
export async function quoteCloseUnclamped(
  ctx: Ctx,
  pool: Address,
  tokenId: bigint
): Promise<CloseQuote> {
  const [ready, pnl] = (await ctx.publicClient.readContract({
    address: pool,
    abi: exnihiloPoolAbi,
    functionName: "quoteCloseUnclamped",
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
  /**
   * USDC that must be approved and held: the fee alone, since the notional is
   * synthetic. The impact fee can rise before the open lands, so leave headroom.
   */
  totalRequired: bigint;
  cap: bigint;
}

/** Check an open before sending it: closing market, position cap, balance, allowance. */
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

  // The router pulls only the fee; the notional is minted, never deposited.
  const totalRequired = fee;

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
    return { ...base, ok: false, reason: `Need ${totalRequired} USDC for the fee, have ${balance}.` };
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
  /** Slippage guard on what the position locks; derive it from `quoteOpen`. 0 accepts any outcome. */
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
 * @param minUsdcOut Payout floor. Set it: the close-price clamp never protects
 *                   against a move made just before the close lands.
 * @param to Where the profit is sent. Defaults to the caller; use another
 *           address when the holder's wallet cannot receive USDC.
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
