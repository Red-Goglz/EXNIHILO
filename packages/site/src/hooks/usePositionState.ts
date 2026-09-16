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
    contracts: [
      { ...poolContract, functionName: "underlyingToken" },
      { ...poolContract, functionName: "closeDate" },
      { ...poolContract, functionName: "fundingWindow" },
      { ...poolContract, functionName: "windDownShift" },
      { ...poolContract, functionName: "fundingRatePerSecond", args: [position.isLong] },
      { ...poolContract, functionName: "liveAmountsOf", args: [tokenId] },
      { ...poolContract, functionName: "remainingSizeBps", args: [tokenId] },
      { ...poolContract, functionName: "quoteClose", args: [tokenId] },
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
  const closeQuote      = data?.[7]?.result as readonly [boolean, bigint] | undefined;

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
  const close = (to?: `0x${string}`) => {
    lastActionRef.current = "close";
    const recipient = to ?? address;
    if (!recipient) return;
    writeContract({
      address: position.pool,
      abi: exnihiloPoolAbi,
      functionName: position.isLong ? "closeLong" : "closeShort",
      args: [tokenId, 0n, recipient],
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
  // `ready === false` means the pool cannot price the position at all — it is
  // underwater past the point its debt can be bought back. That is a loss, not
  // an unknown, and the pool reports the estimated shortfall as a negative pnl.
  const quoteReady = closeQuote?.[0] ?? false;
  const quotePnl   = closeQuote?.[1] ?? 0n;
  const hasPnl = closeQuote !== undefined;
  const canClose = quoteReady && quotePnl > 0n;

  const pnlPositiveRaw = quotePnl > 0n;
  const pnlAbsRaw = quotePnl >= 0n ? quotePnl : -quotePnl;

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
