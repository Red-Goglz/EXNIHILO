import { useState, useEffect, useRef } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { useFormo } from "@formo/analytics";
import { exnihiloPoolAbi, positionNFTAbi, erc20Abi } from "@exnihilio/abis";
import { cpAmountOut } from "../lib/amm.ts";
import { useTx, type TxStatus } from "./useTx.ts";
import { useAppChain } from "./useAppChain.ts";

export interface Position {
  isLong: boolean;
  pool: `0x${string}`;
  lockedAmount: bigint;
  usdcIn: bigint;
  airUsdMinted: bigint;
  airTokenMinted: bigint;
  feesPaid: bigint;
  openedAt: bigint;
  deadline: bigint;
}

const CLOSE_FEE_BPS = 100n; // 1% of surplus on profitable close — must match pool

/** Parse a "12.50"-style USDC string into 6-dec units. Null if malformed. */
export function parseUsdcInput(s: string): bigint | null {
  const m = s.trim().match(/^(\d+)(?:\.(\d{0,6}))?$/);
  if (!m) return null;
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}

/** Format seconds remaining as "Xd Xh Xm Xs" */
export function fmtCountdown(seconds: number): string {
  if (seconds <= 0) return "EXPIRED";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

export interface PositionState {
  tokenSymbol: string;
  // Market state
  isMarketClosed: boolean;
  marketClosedAt: bigint | undefined;
  poolPositionDuration: bigint | undefined;
  // Renewal
  renewalFee: bigint;
  renewalFeeMax: bigint;
  needsRenewApproval: boolean;
  approveStatus: TxStatus;
  approveSuccess: boolean;
  approveRenewal: () => void;
  renewStatus: TxStatus;
  renew: () => void;
  // Auto-renew
  autoRenewOn: boolean;
  autoRenewCap: bigint;
  autoRenewStatus: TxStatus;
  autoRenewBusy: boolean;
  autoRenewSuccess: boolean;
  suggestedCap: bigint;
  armAutoRenew: (cap: bigint) => void;
  disarmAutoRenew: () => void;
  // Close
  canClose: boolean;
  closeStatus: TxStatus;
  close: () => void;
  // Timing
  secondsLeft: number;
  isExpired: boolean;
  isUrgent: boolean;
  openedDate: string;
  deadlineDate: string;
  // PnL
  hasPnl: boolean;
  pnlPositive: boolean;
  pnlNetAbs: bigint;
}

/**
 * All on-chain state and actions for one open position — shared by the
 * desktop table row and the mobile card so the two views can't drift.
 */
export function usePositionState(
  tokenId: bigint,
  position: Position,
  positionNFTAddress: `0x${string}`,
  underlyingUsdc: `0x${string}`,
): PositionState {
  const { address } = useAccount();
  const { chainId } = useAppChain();
  const queryClient = useQueryClient();
  const analytics = useFormo();

  const poolContract = { address: position.pool, abi: exnihiloPoolAbi, chainId } as const;

  const { data } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "backedAirToken" },
      { ...poolContract, functionName: "backedAirUsd" },
      { ...poolContract, functionName: "airTokenSupply" },
      { ...poolContract, functionName: "airUsdSupply" },
      { ...poolContract, functionName: "underlyingToken" },
      { ...poolContract, functionName: "swapFeeBps" },
      { ...poolContract, functionName: "closeDate" },
      { ...poolContract, functionName: "positionDuration" },
    ],
  });

  const backedAirToken     = data?.[0]?.result as bigint | undefined;
  const backedAirUsd      = data?.[1]?.result as bigint | undefined;
  const airTokenTotalSupply = data?.[2]?.result as bigint | undefined;
  const airUsdTotalSupply   = data?.[3]?.result as bigint | undefined;
  const underlyingToken    = data?.[4]?.result as `0x${string}` | undefined;
  const swapFeeBps         = data?.[5]?.result as bigint | undefined;
  const poolCloseDate      = data?.[6]?.result as bigint | undefined;
  const poolPositionDuration = data?.[7]?.result as bigint | undefined;
  const isMarketClosed     = poolCloseDate !== undefined && poolCloseDate > 0n;
  // Show the moment closePool was called, not the future wind-down date.
  const marketClosedAt =
    isMarketClosed && poolPositionDuration !== undefined
      ? poolCloseDate! - poolPositionDuration
      : undefined;

  const { data: tokenMeta } = useReadContracts({
    contracts: underlyingToken
      ? [{ address: underlyingToken, abi: erc20Abi, functionName: "symbol", chainId }]
      : [],
    query: { enabled: !!underlyingToken },
  });

  const tokenSymbol = (tokenMeta?.[0]?.result as string | undefined) ?? "...";

  // Renewal fee quoted from the pool (single source of truth for fee math).
  // Falls back to the client-side base-fee formula until the quote loads.
  const { data: renewQuote } = useReadContracts({
    contracts: [{
      address: position.pool,
      abi: exnihiloPoolAbi,
      functionName: "quoteRenewFee" as const,
      args: [tokenId] as const,
      chainId,
    }],
  });
  const notional = position.isLong ? position.airUsdMinted : position.usdcIn;
  const renewalFee = (renewQuote?.[0]?.result as bigint | undefined) ?? (() => {
    const fee = (notional * 500n) / 10_000n; // 5% base
    return fee < 50_000n ? 50_000n : fee; // min 0.05 USDC
  })();
  // The fee is dynamic (mark value + open interest), so it can move between
  // quote and execution — pass a 2% buffered maxFee and approve the same.
  const renewalFeeMax = (renewalFee * 102n) / 100n;

  // ── Auto-renew state (stored on the PositionNFT, cleared on transfer) ────
  const { data: autoRenewData } = useReadContracts({
    contracts: [{
      address: positionNFTAddress,
      abi: positionNFTAbi,
      functionName: "getAutoRenew" as const,
      args: [tokenId] as const,
      chainId,
    }],
  });
  const autoRenewResult = autoRenewData?.[0]?.result as readonly [boolean, bigint] | undefined;
  const autoRenewOn  = autoRenewResult?.[0] ?? false;
  const autoRenewCap = autoRenewResult?.[1] ?? 0n;

  // Suggested cap: 2× the current quote — headroom for profit growth and OI
  // crowding without authorizing a runaway fee.
  const suggestedCap = renewalFee * 2n;

  const {
    writeContract: writeAutoRenew,
    status: autoRenewStatus,
    isSuccess: autoRenewSuccess,
  } = useTx("AUTO-RENEW UPDATE");
  const autoRenewBusy = autoRenewStatus === "pending" || autoRenewStatus === "confirming";

  useEffect(() => {
    if (autoRenewSuccess) {
      queryClient.invalidateQueries();
      analytics?.track("Auto-Renew Set", {
        pool: position.pool,
        tokenId: tokenId.toString(),
        side: position.isLong ? "long" : "short",
      });
    }
  }, [autoRenewSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  const armAutoRenew = (cap: bigint) => {
    writeAutoRenew({
      address: positionNFTAddress,
      abi: positionNFTAbi,
      functionName: "setAutoRenew",
      args: [tokenId, true, cap],
      chainId,
    });
  };

  const disarmAutoRenew = () => {
    writeAutoRenew({
      address: positionNFTAddress,
      abi: positionNFTAbi,
      functionName: "setAutoRenew",
      args: [tokenId, false, 0n],
      chainId,
    });
  };

  // ── Pool USDC allowance (renew is holder-only, called directly on pool) ──
  const { data: allowanceData } = useReadContracts({
    contracts: address ? [{
      address: underlyingUsdc,
      abi: erc20Abi,
      functionName: "allowance" as const,
      args: [address, position.pool] as const,
      chainId,
    }] : [],
    query: { enabled: !!address },
  });
  const usdcAllowance = allowanceData?.[0]?.result as bigint | undefined;
  const needsRenewApproval = usdcAllowance !== undefined && renewalFeeMax > usdcAllowance;

  const {
    writeContract: writeApprove,
    status: approveStatus,
    isSuccess: approveSuccess,
  } = useTx("USDC APPROVAL");

  useEffect(() => {
    if (approveSuccess) queryClient.invalidateQueries();
  }, [approveSuccess, queryClient]);

  const approveRenewal = () => {
    writeApprove({
      address: underlyingUsdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [position.pool, renewalFeeMax],
      chainId,
    });
  };

  // ── Close tx state ──────────────────────────────────────────────────────
  const { writeContract, status: closeStatus, isSuccess } = useTx("CLOSE");
  const lastActionRef = useRef<"close" | null>(null);

  // ── Extend (renew) tx state ─────────────────────────────────────────────
  const {
    writeContract: writeRenew,
    status: renewStatus,
    isSuccess: renewSuccess,
  } = useTx("EXTEND");

  const poolDataReady =
    backedAirToken !== undefined &&
    backedAirUsd  !== undefined &&
    airTokenTotalSupply !== undefined &&
    airUsdTotalSupply  !== undefined &&
    swapFeeBps !== undefined;

  // Refetch position data once tx is actually mined (not just submitted)
  useEffect(() => {
    if (isSuccess) {
      queryClient.invalidateQueries();
      // Volume = notional minted at open, in USD (both airUsdMinted and lockedAmount for shorts are 6-dec USDC-scale)
      const notionalRaw = position.isLong ? position.airUsdMinted : position.lockedAmount;
      // Revenue = 1% of surplus on profitable close; 0 on losing close
      let protocolFeeRaw = 0n;
      if (lastActionRef.current === "close" && poolDataReady) {
        if (position.isLong && airTokenTotalSupply! > position.lockedAmount) {
          const airUsdOut = cpAmountOut(
            position.lockedAmount,
            airTokenTotalSupply! - position.lockedAmount,
            backedAirUsd!,
            swapFeeBps!,
          );
          if (airUsdOut > position.airUsdMinted) {
            const surplus = airUsdOut - position.airUsdMinted;
            protocolFeeRaw = (surplus * CLOSE_FEE_BPS) / 10_000n;
          }
        } else if (!position.isLong && airUsdTotalSupply! > position.lockedAmount) {
          const totalBuyable = cpAmountOut(
            position.lockedAmount,
            airUsdTotalSupply! - position.lockedAmount,
            backedAirToken!,
            swapFeeBps!,
          );
          if (totalBuyable > 0n && totalBuyable >= position.airTokenMinted) {
            const airUsdCost =
              (position.lockedAmount * position.airTokenMinted + totalBuyable - 1n) / totalBuyable;
            if (position.lockedAmount > airUsdCost) {
              const surplus = position.lockedAmount - airUsdCost;
              protocolFeeRaw = (surplus * CLOSE_FEE_BPS) / 10_000n;
            }
          }
        }
      }
      analytics?.track("Position Closed", {
        pool: position.pool,
        tokenId: tokenId.toString(),
        side: position.isLong ? "long" : "short",
        action: lastActionRef.current ?? "unknown",
        volume: Number(notionalRaw) / 1_000_000,
        revenue: Number(protocolFeeRaw) / 1_000_000,
      });
    }
  }, [isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (renewSuccess) {
      queryClient.invalidateQueries();
      analytics?.track("Position Renewed", {
        pool: position.pool,
        tokenId: tokenId.toString(),
        side: position.isLong ? "long" : "short",
      });
    }
  }, [renewSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  const renew = () => {
    writeRenew({
      address: position.pool,
      abi: exnihiloPoolAbi,
      functionName: "renewPosition",
      args: [tokenId, renewalFeeMax],
      chainId,
    });
  };

  const close = () => {
    lastActionRef.current = "close";
    if (position.isLong) {
      writeContract({ address: position.pool, abi: exnihiloPoolAbi, functionName: "closeLong", args: [tokenId, 0n], chainId });
    } else {
      writeContract({ address: position.pool, abi: exnihiloPoolAbi, functionName: "closeShort", args: [tokenId, 0n], chainId });
    }
  };

  // ── Countdown timer ─────────────────────────────────────────────────────
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(interval);
  }, []);

  const deadlineNum = Number(position.deadline);
  const secondsLeft = deadlineNum - now;
  const isExpired = secondsLeft <= 0;
  const isUrgent = secondsLeft > 0 && secondsLeft < 3600; // <1h

  // ── PnL & close-eligibility ─────────────────────────────────────────────
  // PnL is net of the 1% close fee on profit. Percent is PnL over usdcIn
  // (principal), so a total loss shows as -100% rather than a runaway ratio.
  let hasPnl = false;
  let pnlPositive = false;
  let pnlNetAbs = 0n;
  let canClose = false;

  if (poolDataReady) {
    if (position.isLong) {
      // Mirrors EXNIHILOPool.closeLong: SWAP-3 with (airTokenSupply - lockedAmount, backedAirUsd).
      if (airTokenTotalSupply! > position.lockedAmount) {
        const airUsdOut = cpAmountOut(
          position.lockedAmount,
          airTokenTotalSupply! - position.lockedAmount,
          backedAirUsd!,
          swapFeeBps!,
        );
        canClose    = airUsdOut >= position.airUsdMinted;
        pnlPositive = airUsdOut > position.airUsdMinted;
        hasPnl = true;
        if (pnlPositive) {
          const surplus = airUsdOut - position.airUsdMinted;
          pnlNetAbs = (surplus * (10_000n - CLOSE_FEE_BPS)) / 10_000n;
        } else {
          pnlNetAbs = position.airUsdMinted - airUsdOut;
        }
      }
    } else {
      // Mirrors EXNIHILOPool.closeShort: SWAP-2 with (airUsdSupply - lockedAmount, backedAirToken),
      // then proportional ceil-division to get airUsdCost for the debt. We also
      // display PnL when underwater (totalBuyable < airTokenMinted) so the user
      // still sees their unrealized loss — only canClose is gated on solvency.
      if (airUsdTotalSupply! > position.lockedAmount) {
        const totalBuyable = cpAmountOut(
          position.lockedAmount,
          airUsdTotalSupply! - position.lockedAmount,
          backedAirToken!,
          swapFeeBps!,
        );
        hasPnl = true;
        if (totalBuyable > 0n) {
          const airUsdCost =
            (position.lockedAmount * position.airTokenMinted + totalBuyable - 1n) / totalBuyable;
          canClose    = totalBuyable >= position.airTokenMinted && airUsdCost <= position.lockedAmount;
          pnlPositive = position.lockedAmount > airUsdCost;
          if (pnlPositive) {
            const surplus = position.lockedAmount - airUsdCost;
            pnlNetAbs = (surplus * (10_000n - CLOSE_FEE_BPS)) / 10_000n;
          } else {
            pnlNetAbs = airUsdCost - position.lockedAmount;
          }
        } else {
          // Pool cannot quote any buyback — treat as max loss (full collateral).
          pnlPositive = false;
          pnlNetAbs   = position.lockedAmount;
        }
      }
    }
  }

  const openedDate = new Date(Number(position.openedAt) * 1000).toLocaleDateString();
  const deadlineDate = new Date(deadlineNum * 1000).toLocaleDateString();

  return {
    tokenSymbol,
    isMarketClosed,
    marketClosedAt,
    poolPositionDuration,
    renewalFee,
    renewalFeeMax,
    needsRenewApproval,
    approveStatus,
    approveSuccess,
    approveRenewal,
    renewStatus,
    renew,
    autoRenewOn,
    autoRenewCap,
    autoRenewStatus,
    autoRenewBusy,
    autoRenewSuccess,
    suggestedCap,
    armAutoRenew,
    disarmAutoRenew,
    canClose,
    closeStatus,
    close,
    secondsLeft,
    isExpired,
    isUrgent,
    openedDate,
    deadlineDate,
    hasPnl,
    pnlPositive,
    pnlNetAbs,
  };
}
