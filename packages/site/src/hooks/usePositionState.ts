import { useState, useEffect, useRef } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { useFormo } from "@formo/analytics";
import { exnihiloPoolAbi, erc20Abi } from "@exnihilio/abis";
import { useTx, type TxStatus } from "./useTx.ts";
import { useAppChain } from "./useAppChain.ts";

export interface Position {
  isLong: boolean;
  pool: `0x${string}`;
  /**
   * Collateral AS AT OPEN. Not the position's current size — funding decays
   * every open position on a side by the same factor every second. The live
   * figure comes from the pool (`liveAmountsOf`); see `lockedAmount` on
   * PositionState.
   */
  lockedAmountAtOpen: bigint;
  usdcIn: bigint;
  airUsdMinted: bigint;
  airTokenMinted: bigint;
  feesPaid: bigint;
  openedAt: bigint;
  /** The pool's funding index for this side at mint, in RAY. Replaces `deadline`. */
  fundingIndexAtOpen: bigint;
}

const RAY = 10n ** 27n;
/** Below this fraction of opening collateral, anyone may sweep the position. */
const SWEEP_DUST_BPS = 10n;

/** Shown when a recent price move is holding a profitable close back. */
export const CLOSE_HELD_BACK_TIP =
  "The price moved in the last few blocks. A close is priced against the worst " +
  "recent price, so it is held back until that move ages out, usually a few " +
  "seconds. Your position is still in profit: retry shortly.";

// Positions of the two close quotes in usePositionState's read batch.
const CLOSE_QUOTE_INDEX = 7;
const CLOSE_UNCLAMPED_INDEX = 8;

/**
 * How far below the quoted payout a close may still settle.
 *
 * A close is priced off the reserves as of the block it lands in, so anyone can
 * move it between the quote and the mine — sell the token ahead of a long, buy
 * ahead of a short — and the pool's clamp only ever lowers a payout, never
 * restores one. Without a floor the close takes whatever price it is handed.
 * The gap this has to absorb honestly is small: a few seconds of funding decay
 * and ordinary trading, not someone stepping in front.
 */
export const DEFAULT_CLOSE_SLIPPAGE_BPS = 100n; // 1 %

/** Floor for `minUsdcOut`. Zero whenever there is no positive quote to protect. */
export function closeFloor(quotedPayout: bigint, slippageBps = DEFAULT_CLOSE_SLIPPAGE_BPS): bigint {
  if (quotedPayout <= 0n) return 0n;
  return (quotedPayout * (10_000n - slippageBps)) / 10_000n;
}

/** In profit at live reserves, but not closeable at the clamped quote. */
function closeHeldBackFrom(data: unknown): boolean {
  const reads = data as ReadonlyArray<{ result?: unknown }> | undefined;
  const clamped = reads?.[CLOSE_QUOTE_INDEX]?.result as readonly [boolean, bigint] | undefined;
  const live = reads?.[CLOSE_UNCLAMPED_INDEX]?.result as readonly [boolean, bigint] | undefined;
  const canClose = (clamped?.[0] ?? false) && (clamped?.[1] ?? 0n) > 0n;
  return !canClose && (live?.[0] ?? false) && (live?.[1] ?? 0n) > 0n;
}

/** Parse a "12.50"-style USDC string into 6-dec units. Null if malformed. */
export function parseUsdcInput(s: string): bigint | null {
  const m = s.trim().match(/^(\d+)(?:\.(\d{0,6}))?$/);
  if (!m) return null;
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}

/**
 * A per-second funding rate in RAY, as a percentage per day.
 *
 * Per DAY rather than per hour or per year because that is the horizon the
 * number is actually decided on: a trader is choosing whether to hold
 * overnight, and a rate quoted per second is unreadable while one quoted
 * annually hides how fast a young market bites.
 */
export function fundingPctPerDay(rateRay: bigint): number {
  return Number((rateRay * 86_400n * 1_000_000n) / RAY) / 10_000;
}

/**
 * How long until funding has taken half of what a position has left, at the
 * current rate, in seconds. Returns null when the rate is zero.
 *
 * This is the honest way to express a decay to someone who has not thought
 * about continuous charging: "half gone in 9 days" lands where "7.7 % a day"
 * does not, and it is the same number.
 */
export function fundingHalfLife(rateRay: bigint): number | null {
  if (rateRay <= 0n) return null;
  const perSecond = Number(rateRay) / Number(RAY);
  return Math.log(2) / perSecond;
}

/** Format a duration in seconds as "Xd Xh", "Xh Xm", or "Xm". */
export function fmtDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export interface PositionState {
  tokenSymbol: string;
  // Market state
  isMarketClosed: boolean;
  marketClosedAt: bigint | undefined;
  /** Seconds the current funding rate is levied over. Widens as the market ages. */
  fundingWindow: bigint | undefined;
  // Funding
  /** This side's per-second funding rate, in RAY. */
  fundingRate: bigint;
  /** The same rate as a percentage of the position per day. */
  fundingPctDay: number;
  /** Seconds until funding halves what is left, at the current rate. */
  halfLifeSeconds: number | null;
  /** Collateral still backing the position, net of funding charged so far. */
  lockedAmount: bigint;
  /** Synthetic debt left, net of funding — airUsd for a long, airToken for a short. */
  debt: bigint;
  /** USDC notional left, net of funding. Shrinks in step with collateral and debt. */
  notional: bigint;
  /** What the position has left as a fraction of its opening size, in bps. */
  remainingBps: bigint;
  /** True once the position has decayed far enough for anyone to sweep it. */
  isDust: boolean;
  /**
   * Times the wind-down has doubled the funding rate. 0 unless the LP has
   * closed the pool and the grace period has passed.
   */
  windDownShift: bigint;
  // Close
  canClose: boolean;
  /**
   * In profit at live reserves, but a price move in the last few blocks is
   * holding the close back. Clears on its own within a few blocks — show
   * "retry shortly", not a loss.
   */
  closeHeldBack: boolean;
  closeStatus: TxStatus;
  close: (to?: `0x${string}`) => void;
  // Timing
  openedDate: string;
  ageSeconds: number;
  // PnL
  hasPnl: boolean;
  pnlPositive: boolean;
  pnlNetAbs: bigint;
  returnPct: number | null;
  tokenDecimals: number;
}

/**
 * All on-chain state and actions for one open position — shared by the
 * desktop table row and the mobile card so the two views can't drift.
 *
 * PnL comes from the pool's own `quoteClose` rather than a client-side mirror
 * of the AMM. The mirror used to be here for responsiveness, but it cannot see
 * two things the settlement path does: the funding already charged against the
 * position, and the close-price clamp that prices a close against the worst of
 * the last few block opens. Both move the number, so a mirror that ignored them
 * would quote a payout the pool would not honour.
 */
export function usePositionState(
  tokenId: bigint,
  position: Position,
): PositionState {
  const { address } = useAccount();
  const { chainId } = useAppChain();
  const queryClient = useQueryClient();
  const analytics = useFormo();

  const poolContract = { address: position.pool, abi: exnihiloPoolAbi, chainId } as const;

  const { data } = useReadContracts({
    // While a close is held back, re-read until it clears so the button comes
    // back without a reload.
    query: {
      refetchInterval: (q: { state: { data?: unknown } }) =>
        closeHeldBackFrom(q.state.data) ? 3_000 : false,
    },
    contracts: [
      { ...poolContract, functionName: "underlyingToken" },
      { ...poolContract, functionName: "closeDate" },
      { ...poolContract, functionName: "fundingWindow" },
      { ...poolContract, functionName: "windDownShift" },
      { ...poolContract, functionName: "fundingRatePerSecond", args: [position.isLong] },
      { ...poolContract, functionName: "liveAmountsOf", args: [tokenId] },
      { ...poolContract, functionName: "remainingSizeBps", args: [tokenId] },
      { ...poolContract, functionName: "quoteClose", args: [tokenId] },
      { ...poolContract, functionName: "quoteCloseUnclamped", args: [tokenId] },
    ],
  });

  const underlyingToken = data?.[0]?.result as `0x${string}` | undefined;
  const poolCloseDate   = data?.[1]?.result as bigint | undefined;
  const fundingWindow   = data?.[2]?.result as bigint | undefined;
  const windDownShift   = (data?.[3]?.result as bigint | undefined) ?? 0n;
  const fundingRate     = (data?.[4]?.result as bigint | undefined) ?? 0n;
  // Collateral, debt and notional all decay by the same factor; the opening
  // figures are only a fallback while the read is in flight.
  const live            = data?.[5]?.result as readonly [bigint, bigint, bigint] | undefined;
  const lockedAmount    = live?.[0] ?? position.lockedAmountAtOpen;
  const debt            = live?.[1] ?? (position.isLong ? position.airUsdMinted : position.airTokenMinted);
  const notional        = live?.[2] ?? position.usdcIn;
  const remainingBps    = (data?.[6]?.result as bigint | undefined) ?? 10_000n;
  const closeQuote      = data?.[CLOSE_QUOTE_INDEX]?.result as readonly [boolean, bigint] | undefined;
  const unclampedQuote  = data?.[CLOSE_UNCLAMPED_INDEX]?.result as readonly [boolean, bigint] | undefined;

  // `ready === false` means the pool cannot price the position at all — it is
  // underwater past the point its debt can be bought back. That is a loss, not
  // an unknown, and the pool reports the estimated shortfall as a negative pnl.
  // Read here rather than with the rest of the PnL maths because `close` floors
  // its payout with it.
  const quoteReady = closeQuote?.[0] ?? false;
  const quotePnl   = closeQuote?.[1] ?? 0n;

  const isMarketClosed = poolCloseDate !== undefined && poolCloseDate > 0n;
  // closeDate is the END of the grace period; show when closePool was called.
  const WIND_DOWN_GRACE = 604_800n; // 7 days — mirrors EXNIHILOPool
  const marketClosedAt = isMarketClosed ? poolCloseDate! - WIND_DOWN_GRACE : undefined;

  const { data: tokenMeta } = useReadContracts({
    contracts: underlyingToken
      ? [
          { address: underlyingToken, abi: erc20Abi, functionName: "symbol" as const, chainId },
          { address: underlyingToken, abi: erc20Abi, functionName: "decimals" as const, chainId },
        ]
      : [],
    query: { enabled: !!underlyingToken },
  });

  const tokenSymbol = (tokenMeta?.[0]?.result as string | undefined) ?? "...";
  const tokenDecimals = (tokenMeta?.[1]?.result as number | undefined) ?? 18;

  // ── Close tx state ──────────────────────────────────────────────────────
  const { writeContract, status: closeStatus, isSuccess } = useTx("CLOSE");
  const lastActionRef = useRef<"close" | null>(null);

  useEffect(() => {
    if (isSuccess) {
      queryClient.invalidateQueries();
      const notionalRaw = position.isLong ? position.airUsdMinted : position.usdcIn;
      analytics?.track("Position Closed", {
        pool: position.pool,
        tokenId: tokenId.toString(),
        side: position.isLong ? "long" : "short",
        action: lastActionRef.current ?? "unknown",
        volume: Number(notionalRaw) / 1_000_000,
      });
    }
  }, [isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * @param to Where the profit goes. Defaults to the connected wallet. It is a
   *           parameter because the pool takes one: a holder whose own address
   *           cannot receive USDC has no other exit, since positions no longer
   *           expire into a claimable payout.
   */
  const close = (to?: `0x${string}`, slippageBps = DEFAULT_CLOSE_SLIPPAGE_BPS) => {
    lastActionRef.current = "close";
    const recipient = to ?? address;
    if (!recipient) return;
    writeContract({
      address: position.pool,
      abi: exnihiloPoolAbi,
      functionName: position.isLong ? "closeLong" : "closeShort",
      args: [tokenId, closeFloor(quotePnl, slippageBps), recipient],
      chainId,
    });
  };

  // ── Clock ───────────────────────────────────────────────────────────────
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(interval);
  }, []);

  // ── PnL ─────────────────────────────────────────────────────────────────
  const hasPnl = closeQuote !== undefined;
  const canClose = quoteReady && quotePnl > 0n;

  // quoteClose prices against the worst of the last few block opens, so a
  // price move that stood at one of them can make a profitable position quote
  // as underwater for a few blocks. The unclamped quote tells that apart from a
  // real loss. While held back, show the live figure: the clamped one would
  // flash a loss that is gone a few seconds later.
  const closeHeldBack = closeHeldBackFrom(data);
  const shownPnl = closeHeldBack ? unclampedQuote![1] : quotePnl;

  const pnlPositiveRaw = shownPnl > 0n;
  const pnlAbsRaw = shownPnl >= 0n ? shownPnl : -shownPnl;

  // ── Net result ──────────────────────────────────────────────────────────
  // Mirrors PositionNFT._netReturn exactly, so the app and the position
  // certificate can never print different numbers for the same position.
  //
  // The fee IS the cost basis: openLong/openShort pull only `totalFee` from the
  // trader, the notional is minted synthetically. What they staked is
  // `feesPaid` and what they get back is the payout, so the result is
  // payout − premium — NOT the payout on its own.
  //
  // Funding does not appear here as a cost, and that is deliberate rather than
  // an omission: it is charged by shrinking the position, so it is already
  // inside the payout. Adding it again would count it twice.
  const premium = position.feesPaid;
  const payout = pnlPositiveRaw ? pnlAbsRaw : 0n;
  const netUp = payout >= premium;
  const netAbs = netUp ? payout - premium : premium - payout;

  let returnPct: number | null = null;
  if (hasPnl && premium > 0n) {
    returnPct = (Number(netAbs) / Number(premium)) * 100 * (netUp ? 1 : -1);
  }

  const openedDate = new Date(Number(position.openedAt) * 1000).toLocaleDateString();
  const ageSeconds = now - Number(position.openedAt);

  return {
    tokenSymbol,
    isMarketClosed,
    marketClosedAt,
    fundingWindow,
    fundingRate,
    fundingPctDay: fundingPctPerDay(fundingRate),
    halfLifeSeconds: fundingHalfLife(fundingRate),
    lockedAmount,
    debt,
    notional,
    remainingBps,
    // Strictly below: remainingBps rounds down, so a reading of 10 can still be
    // refused by sweepDust.
    isDust: remainingBps < SWEEP_DUST_BPS,
    windDownShift,
    canClose,
    closeHeldBack,
    closeStatus,
    close,
    openedDate,
    ageSeconds,
    hasPnl,
    // Both net of the premium — see the derivation above.
    pnlPositive: netUp,
    pnlNetAbs: netAbs,
    returnPct,
    tokenDecimals,
  };
}
