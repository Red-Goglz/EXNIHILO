import { preMarketAbi, preMarketFactoryAbi, erc20Abi } from "@exnihilio/abis";
import type { Address, Hash } from "viem";
import { requireAccount, requireAddress, requireWallet, type Ctx } from "./client.js";
import {
  DEFAULT_DECAY_BPS_PER_MINUTE,
  DEFAULT_START_PRICE_MARKUP_BPS,
  BPS_DENOM,
} from "./constants.js";

/**
 * Launchpad integration. A PreMarket is a token/quote AMM with a descending-price
 * USDC auction on its quote reserve; the buyout creates the real token/USDC
 * market and locks its LP NFT in a LockedLpVault. Seeding is irreversible.
 * A USDC quote skips the auction and launches at seed time (`directLaunch`).
 */

export class PreFlightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreFlightError";
  }
}

export interface CreatePreMarketArgs {
  /** Project token being launched. */
  token: Address;
  /** Token liquidity to seed. */
  tokenAmount: bigint;
  /**
   * Any standard ERC-20 the curve bonded in. Pass USDC itself to skip the
   * auction and open the real market immediately at the seeded ratio.
   */
  quote: Address;
  /** Quote liquidity to seed. */
  quoteAmount: bigint;
  /**
   * Honest spot price of one whole `quote` unit in USDC (6 dec). The SDK adds
   * the markup below; do not pre-mark it up yourself.
   *
   * Not required — and ignored — when `quote` is USDC, where there is no
   * auction and therefore no price to quote.
   */
  quoteSpotPriceUsdc?: bigint;
  /** Claims the LP half of the fee stream once the market launches. */
  lpOwner: Address;
  /** Claims the integrator half. Zero address means no integrator. */
  integrator?: Address;
  /** Override the +1 % markup on `quoteSpotPriceUsdc`. */
  startPriceMarkupBps?: bigint;
  /** Override the 2 %/minute decay. */
  decayBpsPerMinute?: bigint;
}

/** Everything the launcher will send, so a caller can inspect it first. */
export interface PreMarketPlan {
  token: Address;
  tokenAmount: bigint;
  quote: Address;
  quoteAmount: bigint;
  startPrice: bigint;
  decayBpsPerMinute: bigint;
  lpOwner: Address;
  integrator: Address;
  /** Seconds until the auction price crosses the honest spot quote. */
  secondsToBreakeven: number;
  /** Auction price at t=0: USDC (6 dec) per whole quote unit, i.e. `startPrice`. */
  openingBuyoutCost: bigint;
  /**
   * True when `quote` is USDC: no auction runs, `startPrice` and
   * `decayBpsPerMinute` are zero, and `createPreMarket` returns a premarket
   * that is already launched.
   */
  directLaunch: boolean;
}

const ZERO: Address = "0x0000000000000000000000000000000000000000";

/**
 * Build and validate the parameters without sending anything.
 *
 * `quoteSpotPriceUsdc` cannot be checked on-chain. Too high delays the fill
 * (~30 s per 1 % at the default decay); more than ~10 % too high and the price,
 * which stops at 90 % of the start, floors above spot, so nobody fills it. Too
 * low and the reserve is bought out at that number almost at once.
 *
 * @param usdc The chain's USDC address, so a USDC quote can be recognised as a
 *             direct launch. `createPreMarket` passes it from the context; a
 *             caller planning by hand should pass it too, or the plan will
 *             describe an auction the contract is going to ignore.
 */
export function planPreMarket(args: CreatePreMarketArgs, usdc?: Address): PreMarketPlan {
  if (args.tokenAmount <= 0n || args.quoteAmount <= 0n) {
    throw new PreFlightError("tokenAmount and quoteAmount must both be positive.");
  }

  const directLaunch =
    usdc !== undefined && args.quote.toLowerCase() === usdc.toLowerCase();

  const base = {
    token: args.token,
    tokenAmount: args.tokenAmount,
    quote: args.quote,
    quoteAmount: args.quoteAmount,
    lpOwner: args.lpOwner,
    integrator: args.integrator ?? ZERO,
  };

  // No auction on a USDC quote: nothing is bought, so there is no price to mark
  // up and nothing to decay. The contract records both as zero, and this plan
  // says the same rather than describing an auction that will not run.
  if (directLaunch) {
    return {
      ...base,
      startPrice: 0n,
      decayBpsPerMinute: 0n,
      secondsToBreakeven: 0,
      openingBuyoutCost: 0n,
      directLaunch: true,
    };
  }

  if (args.quoteSpotPriceUsdc === undefined || args.quoteSpotPriceUsdc <= 0n) {
    throw new PreFlightError(
      "quoteSpotPriceUsdc must be positive. It is only optional when `quote` is USDC."
    );
  }

  const markup = args.startPriceMarkupBps ?? DEFAULT_START_PRICE_MARKUP_BPS;
  const decay = args.decayBpsPerMinute ?? DEFAULT_DECAY_BPS_PER_MINUTE;
  if (decay === 0n || decay > BPS_DENOM) {
    throw new PreFlightError("decayBpsPerMinute must be between 1 and 10000.");
  }

  const startPrice = (args.quoteSpotPriceUsdc * (BPS_DENOM + markup)) / BPS_DENOM;

  // The price falls by `decay` bps of startPrice per minute, so reaching spot
  // takes markup/decay minutes.
  const secondsToBreakeven = Math.round((Number(markup) / Number(decay)) * 60);

  return {
    ...base,
    startPrice,
    decayBpsPerMinute: decay,
    secondsToBreakeven,
    openingBuyoutCost: startPrice, // per whole quote unit; scaled on-chain by decimals
    directLaunch: false,
  };
}

/**
 * Seed a premarket. Both legs must already be approved to the PreMarketFactory.
 *
 * Simulates first, so a misconfiguration surfaces as a decoded error rather
 * than a failed transaction during a live bond.
 *
 * When `quote` is USDC this call also launches the market — `plan.directLaunch`
 * says so, and the premarket it creates comes back with `launched`,
 * `launchedPool` and `lpVault` already set.
 */
export async function createPreMarket(
  ctx: Ctx,
  args: CreatePreMarketArgs
): Promise<{ hash: Hash; plan: PreMarketPlan }> {
  const factory = requireAddress(ctx, "preMarketFactory");
  const wallet = requireWallet(ctx, "createPreMarket");
  const account = requireAccount(ctx, "createPreMarket");
  const plan = planPreMarket(args, ctx.addresses.usdc);

  const params = {
    token: plan.token,
    tokenAmount: plan.tokenAmount,
    quote: plan.quote,
    quoteAmount: plan.quoteAmount,
    startPrice: plan.startPrice,
    decayBpsPerMinute: plan.decayBpsPerMinute,
    lpOwner: plan.lpOwner,
    integrator: plan.integrator,
  } as const;

  const { request } = await ctx.publicClient.simulateContract({
    address: factory,
    abi: preMarketFactoryAbi,
    functionName: "createPreMarket",
    args: [params],
    account,
  });

  const hash = await wallet.writeContract(request);
  return { hash, plan };
}

/** Approve both legs to the PreMarketFactory. Two transactions. */
export async function approvePreMarketSeed(
  ctx: Ctx,
  token: Address,
  tokenAmount: bigint,
  quote: Address,
  quoteAmount: bigint
): Promise<[Hash, Hash]> {
  const factory = requireAddress(ctx, "preMarketFactory");
  const wallet = requireWallet(ctx, "approvePreMarketSeed");
  const account = requireAccount(ctx, "approvePreMarketSeed");

  const tokenHash = await wallet.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [factory, tokenAmount],
    account,
    chain: wallet.chain,
  });
  const quoteHash = await wallet.writeContract({
    address: quote,
    abi: erc20Abi,
    functionName: "approve",
    args: [factory, quoteAmount],
    account,
    chain: wallet.chain,
  });
  return [tokenHash, quoteHash];
}

export interface PreMarketState {
  address: Address;
  token: Address;
  quote: Address;
  tokenReserve: bigint;
  quoteReserve: bigint;
  /** Current Dutch price: USDC (6 dec) per whole quote unit. */
  currentPrice: bigint;
  /**
   * USDC to buy the entire quote reserve right now: currentPrice × quoteReserve.
   * Zero when a drawn-down reserve prices to nothing; buyout then reverts
   * `BuyoutNotPriceable` until quote is swapped in.
   */
  buyoutCostUsdc: bigint;
  /** Quote received for that USDC. */
  buyoutQuoteOut: bigint;
  /** True once a buyout has created the real market. */
  launched: boolean;
  /**
   * True when the quote asset is USDC, so no auction ever ran: the market was
   * created at seed time. `currentPrice` and `buyoutCostUsdc` are zero here and
   * `swap`/`buyout` revert — read `launchedPool` instead.
   */
  directLaunch: boolean;
  /** The EXNIHILOPool created by the buyout. Zero until launched. */
  launchedPool: Address;
  /** The LockedLpVault holding the LP NFT. Zero until launched. */
  lpVault: Address;
}

/** One round-trip snapshot of a premarket. */
export async function getPreMarket(ctx: Ctx, preMarket: Address): Promise<PreMarketState> {
  const c = { address: preMarket, abi: preMarketAbi } as const;

  const results = await ctx.publicClient.multicall({
    contracts: [
      { ...c, functionName: "token" },
      { ...c, functionName: "quote" },
      { ...c, functionName: "tokenReserve" },
      { ...c, functionName: "quoteReserve" },
      { ...c, functionName: "currentPrice" },
      { ...c, functionName: "buyoutCost" },
      { ...c, functionName: "launched" },
      { ...c, functionName: "launchedPool" },
      { ...c, functionName: "lpVault" },
      { ...c, functionName: "directLaunch" },
    ],
    allowFailure: false,
  });

  const [usdcCost, quoteOut] = results[5] as [bigint, bigint];

  return {
    address: preMarket,
    token: results[0] as Address,
    quote: results[1] as Address,
    tokenReserve: results[2] as bigint,
    quoteReserve: results[3] as bigint,
    currentPrice: results[4] as bigint,
    buyoutCostUsdc: usdcCost,
    buyoutQuoteOut: quoteOut,
    launched: results[6] as boolean,
    launchedPool: results[7] as Address,
    lpVault: results[8] as Address,
    directLaunch: results[9] as boolean,
  };
}

/** Every premarket the factory has created, oldest first. */
export async function listPreMarkets(ctx: Ctx): Promise<Address[]> {
  const factory = requireAddress(ctx, "preMarketFactory");
  const count = await ctx.publicClient.readContract({
    address: factory,
    abi: preMarketFactoryAbi,
    functionName: "allPreMarketsLength",
  });

  const results = await ctx.publicClient.multicall({
    contracts: Array.from({ length: Number(count) }, (_, i) => ({
      address: factory,
      abi: preMarketFactoryAbi,
      functionName: "allPreMarkets" as const,
      args: [BigInt(i)] as const,
    })),
  });
  return results.map((r) => r.result as Address);
}

/**
 * Trade the premarket AMM while the auction runs. Keeps the ratio honest.
 *
 * Not available on a direct-launch premarket: it has no auction to keep honest,
 * and its reserves are already in the pool.
 */
export async function swapPreMarket(
  ctx: Ctx,
  preMarket: Address,
  amountIn: bigint,
  tokenToQuote: boolean,
  minAmountOut = 0n,
  to?: Address
): Promise<Hash> {
  const wallet = requireWallet(ctx, "swapPreMarket");
  const account = requireAccount(ctx, "swapPreMarket");

  return wallet.writeContract({
    address: preMarket,
    abi: preMarketAbi,
    functionName: "swap",
    args: [amountIn, minAmountOut, tokenToQuote, to ?? account],
    account,
    chain: wallet.chain,
  });
}

/**
 * Buy the entire quote reserve at the current Dutch price and launch the real
 * market in the same transaction.
 *
 * @param maxUsdc      Cost guard; always set it. The price only falls, but a
 *                     quote-in swap grows the reserve and so the cost.
 * @param minQuoteOut  Guard against the reserve shrinking before execution.
 *
 * Reverts on a direct-launch premarket, which launched at seed time.
 */
export async function buyout(
  ctx: Ctx,
  preMarket: Address,
  maxUsdc: bigint,
  minQuoteOut = 0n
): Promise<Hash> {
  const wallet = requireWallet(ctx, "buyout");
  const account = requireAccount(ctx, "buyout");

  const { request } = await ctx.publicClient.simulateContract({
    address: preMarket,
    abi: preMarketAbi,
    functionName: "buyout",
    args: [maxUsdc, minQuoteOut],
    account,
  });
  return wallet.writeContract(request);
}
