import { useState, useEffect, useRef } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContracts } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { useFormo } from "@formo/analytics";
import { exnihiloPoolAbi, exnihiloRouterAbi, erc20Abi } from "@exnihilio/abis";
import { formatUsdc, formatToken } from "../../lib/format.ts";
import { cpAmountOut } from "../../lib/amm.ts";
import { useRouterApproval } from "../../hooks/useRouterApproval.ts";
import TxButton from "../shared/TxButton.tsx";

interface Position {
  isLong: boolean;
  pool: `0x${string}`;
  lockedToken: `0x${string}`;
  lockedAmount: bigint;
  usdcIn: bigint;
  airUsdMinted: bigint;
  airTokenMinted: bigint;
  feesPaid: bigint;
  openedAt: bigint;
  deadline: bigint;
}

const CLOSE_FEE_BPS = 100n; // 1% of surplus on profitable close — must match pool

interface PositionCardProps {
  tokenId: bigint;
  position: Position;
  positionNFTAddress: `0x${string}`;
  underlyingUsdc: `0x${string}`;
}

function WithTooltip({ tip, children }: { tip: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  return (
    <div
      style={{ position: "relative", flex: 1 }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            padding: "8px 12px",
            zIndex: 50,
            whiteSpace: "nowrap",
            fontFamily: "var(--font-mono)",
            fontSize: "0.6rem",
            color: "var(--muted)",
            letterSpacing: "0.04em",
            boxShadow: "0 4px 24px rgba(0,0,0,0.6)",
            pointerEvents: "none",
          }}
        >
          <span style={{ position: "absolute", top: -1, left: -1, width: 6, height: 6, borderTop: "1px solid var(--cyan)", borderLeft: "1px solid var(--cyan)" }} />
          <span style={{ position: "absolute", bottom: -1, right: -1, width: 6, height: 6, borderBottom: "1px solid var(--cyan)", borderRight: "1px solid var(--cyan)" }} />
          {tip}
        </div>
      )}
    </div>
  );
}

/** Format seconds remaining as "Xd Xh Xm Xs" */
function fmtCountdown(seconds: number): string {
  if (seconds <= 0) return "EXPIRED";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

export default function PositionCard({
  tokenId,
  position,
  underlyingUsdc,
}: PositionCardProps) {
  const { address } = useAccount();
  const queryClient = useQueryClient();
  const analytics = useFormo();

  const poolContract = { address: position.pool, abi: exnihiloPoolAbi } as const;

  const { data } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "backedAirToken" },
      { ...poolContract, functionName: "backedAirUsd" },
      { ...poolContract, functionName: "airToken" },
      { ...poolContract, functionName: "airUsdToken" },
      { ...poolContract, functionName: "underlyingToken" },
      { ...poolContract, functionName: "swapFeeBps" },
    ],
  });

  const backedAirToken     = data?.[0]?.result as bigint | undefined;
  const backedAirUsd      = data?.[1]?.result as bigint | undefined;
  const airTokenAddress    = data?.[2]?.result as `0x${string}` | undefined;
  const airUsdAddress     = data?.[3]?.result as `0x${string}` | undefined;
  const underlyingToken    = data?.[4]?.result as `0x${string}` | undefined;
  const swapFeeBps         = data?.[5]?.result as bigint | undefined;

  const { data: tokenMeta } = useReadContracts({
    contracts: underlyingToken
      ? [{ address: underlyingToken, abi: erc20Abi, functionName: "symbol" }]
      : [],
    query: { enabled: !!underlyingToken },
  });

  const tokenSymbol = (tokenMeta?.[0]?.result as string | undefined) ?? "...";

  const { data: supplyData } = useReadContracts({
    contracts: airTokenAddress && airUsdAddress ? [
      { address: airTokenAddress, abi: erc20Abi, functionName: "totalSupply" as const },
      { address: airUsdAddress,  abi: erc20Abi, functionName: "totalSupply" as const },
    ] : [],
    query: { enabled: !!airTokenAddress && !!airUsdAddress },
  });

  const airTokenTotalSupply = supplyData?.[0]?.result as bigint | undefined;
  const airUsdTotalSupply  = supplyData?.[1]?.result as bigint | undefined;

  // Compute renewal fee client-side (5% of notional)
  const notional = position.isLong ? position.airUsdMinted : position.usdcIn;
  const renewalFee = (() => {
    const fee = (notional * 500n) / 10_000n; // 5% base
    return fee < 50_000n ? 50_000n : fee; // min 0.05 USDC
  })();

  // ── Router approval for renew (reuse existing USDC→router approval) ─────
  const { routerAddress, routerAllowance } = useRouterApproval(underlyingUsdc);
  const useRouter = !!routerAddress && routerAllowance !== undefined && routerAllowance >= renewalFee;

  // ── Direct pool USDC allowance (fallback if no router approval) ────────
  const { data: allowanceData } = useReadContracts({
    contracts: address ? [{
      address: underlyingUsdc,
      abi: erc20Abi,
      functionName: "allowance" as const,
      args: [address, position.pool] as const,
    }] : [],
    query: { enabled: !!address && !useRouter },
  });
  const usdcAllowance = allowanceData?.[0]?.result as bigint | undefined;
  const needsRenewApproval = !useRouter && usdcAllowance !== undefined && renewalFee > usdcAllowance;

  const { writeContract: writeApprove, data: approveHash, isPending: approvePending } = useWriteContract();
  const { isLoading: approveConfirming, isSuccess: approveSuccess } = useWaitForTransactionReceipt({ hash: approveHash });

  const approveStatus = approvePending ? "pending" : approveConfirming ? "confirming" : approveSuccess ? "success" : "idle";

  useEffect(() => {
    if (approveSuccess) queryClient.invalidateQueries();
  }, [approveSuccess, queryClient]);

  // ── Close / Realize tx state ────────────────────────────────────────────
  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });
  const lastActionRef = useRef<"close" | "realize" | null>(null);

  const txStatus = isPending
    ? "pending"
    : isConfirming
    ? "confirming"
    : isSuccess
    ? "success"
    : "idle";

  // ── Renew tx state ──────────────────────────────────────────────────────
  const { writeContract: writeRenew, data: renewHash, isPending: renewPending } = useWriteContract();
  const { isLoading: renewConfirming, isSuccess: renewSuccess } = useWaitForTransactionReceipt({ hash: renewHash });

  const renewStatus = renewPending
    ? "pending"
    : renewConfirming
    ? "confirming"
    : renewSuccess
    ? "success"
    : "idle";

  // Refetch position data once tx is actually mined (not just submitted)
  useEffect(() => {
    if (isSuccess) {
      queryClient.invalidateQueries();
      // Volume = notional minted at open, in USD (both airUsdMinted and lockedAmount for shorts are 6-dec USDC-scale)
      const notionalRaw = position.isLong ? position.airUsdMinted : position.lockedAmount;
      // Revenue = 1% of surplus on profitable close; 0 on realize or losing close
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
      analytics?.track("Position Closed or Realized", {
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
  let pnlDisplay = "";
  let pnlPositive = false;
  let pnlNetAbs = 0n;
  let canClose = false;

  const poolDataReady =
    backedAirToken !== undefined &&
    backedAirUsd  !== undefined &&
    airTokenTotalSupply !== undefined &&
    airUsdTotalSupply  !== undefined &&
    swapFeeBps !== undefined;

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
        if (pnlPositive) {
          const surplus = airUsdOut - position.airUsdMinted;
          pnlNetAbs  = (surplus * (10_000n - CLOSE_FEE_BPS)) / 10_000n;
          pnlDisplay = `+$${formatUsdc(pnlNetAbs)}`;
        } else {
          pnlNetAbs  = position.airUsdMinted - airUsdOut;
          pnlDisplay = `-$${formatUsdc(pnlNetAbs)}`;
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
        if (totalBuyable > 0n) {
          const airUsdCost =
            (position.lockedAmount * position.airTokenMinted + totalBuyable - 1n) / totalBuyable;
          canClose    = totalBuyable >= position.airTokenMinted && airUsdCost <= position.lockedAmount;
          pnlPositive = position.lockedAmount > airUsdCost;
          if (pnlPositive) {
            const surplus = position.lockedAmount - airUsdCost;
            pnlNetAbs  = (surplus * (10_000n - CLOSE_FEE_BPS)) / 10_000n;
            pnlDisplay = `+$${formatUsdc(pnlNetAbs)}`;
          } else {
            pnlNetAbs  = airUsdCost - position.lockedAmount;
            pnlDisplay = `-$${formatUsdc(pnlNetAbs)}`;
          }
        } else {
          // Pool cannot quote any buyback — treat as max loss (full collateral).
          pnlPositive = false;
          pnlNetAbs   = position.lockedAmount;
          pnlDisplay  = `-$${formatUsdc(pnlNetAbs)}`;
        }
      }
    }
  }

  if (pnlDisplay && position.usdcIn > 0n) {
    // Percent over principal (usdcIn). Clamp loss at -100% since the true
    // max loss is the collateral — the proportional formula can overshoot
    // when the short is deeply underwater.
    let pct = Number((pnlNetAbs * 100n) / position.usdcIn);
    if (!pnlPositive && pct > 100) pct = 100;
    pnlDisplay = `${pnlDisplay} (${pnlPositive ? "+" : "-"}${pct}%)`;
  }

  const openedDate = new Date(Number(position.openedAt) * 1000).toLocaleDateString();
  const deadlineDate = new Date(deadlineNum * 1000).toLocaleDateString();

  return (
    <div
      style={{
        background: "var(--surface)",
        border: `1px solid ${position.isLong ? "rgba(0,255,136,0.15)" : "rgba(255,59,48,0.15)"}`,
        padding: "18px",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        fontFamily: "var(--font-mono)",
      }}
    >
      {/* Corner accent */}
      <span
        style={{
          position: "absolute",
          top: -1, left: -1,
          width: 8, height: 8,
          borderTop: `1px solid ${position.isLong ? "var(--green)" : "var(--red)"}`,
          borderLeft: `1px solid ${position.isLong ? "var(--green)" : "var(--red)"}`,
          pointerEvents: "none",
        }}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={position.isLong ? "tag-long" : "tag-short"}>
            {position.isLong ? "LONG" : "SHORT"}
          </span>
          <span style={{ fontSize: "0.78rem", color: "#fff", fontWeight: 600, letterSpacing: "0.04em" }}>
            {tokenSymbol}
          </span>
          <span style={{ fontSize: "0.6rem", color: "var(--dim)" }}>
            #{tokenId.toString()}
          </span>
        </div>
        <span style={{ fontSize: "0.6rem", color: "var(--muted)", letterSpacing: "0.05em" }}>
          {openedDate}
        </span>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: "var(--border)" }} />

      {/* Deadline / Timer */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 10px",
          background: isExpired
            ? "rgba(255,59,48,0.08)"
            : isUrgent
            ? "rgba(255,140,0,0.08)"
            : "rgba(0,229,255,0.04)",
          border: `1px solid ${
            isExpired ? "rgba(255,59,48,0.25)" : isUrgent ? "rgba(255,140,0,0.25)" : "rgba(0,229,255,0.1)"
          }`,
        }}
      >
        <div>
          <div
            style={{
              fontSize: "0.5rem",
              letterSpacing: "0.15em",
              color: "var(--muted)",
              marginBottom: 2,
            }}
          >
            {isExpired ? "EXPIRED" : "EXPIRES"}
          </div>
          <div
            style={{
              fontSize: "0.72rem",
              fontWeight: 600,
              color: isExpired ? "var(--red)" : isUrgent ? "var(--orange)" : "var(--cyan)",
              letterSpacing: "0.06em",
            }}
          >
            {isExpired ? deadlineDate : fmtCountdown(secondsLeft)}
          </div>
        </div>

        {/* Renew button (with approval if needed) */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
          {needsRenewApproval && !approveSuccess ? (
            <TxButton
              idleLabel={`Approve USDC`}
              status={approveStatus}
              variant="default"
              onClick={() =>
                writeApprove({
                  address: underlyingUsdc,
                  abi: erc20Abi,
                  functionName: "approve",
                  args: [position.pool, renewalFee],
                })
              }
              style={{ fontSize: "0.56rem", padding: "4px 10px" }}
            />
          ) : (
            <TxButton
              idleLabel={`Renew ($${formatUsdc(renewalFee)})`}
              status={renewStatus}
              variant="default"
              onClick={() => {
                if (useRouter) {
                  writeRenew({
                    address: routerAddress!,
                    abi: exnihiloRouterAbi,
                    functionName: "renewPosition",
                    args: [position.pool, tokenId, renewalFee],
                  });
                } else {
                  writeRenew({
                    address: position.pool,
                    abi: exnihiloPoolAbi,
                    functionName: "renewPosition",
                    args: [tokenId],
                  });
                }
              }}
              style={{ fontSize: "0.56rem", padding: "4px 10px" }}
            />
          )}
        </div>
      </div>

      {/* Data grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        {position.isLong && (
          <>
            <div>
              <div className="stat-label">USDC IN</div>
              <div style={{ fontSize: "0.82rem", color: "var(--body)" }}>
                {formatUsdc(position.usdcIn)}
              </div>
            </div>
            <div>
              <div className="stat-label">LOCKED TOKEN</div>
              <div style={{ fontSize: "0.82rem", color: "var(--body)" }}>
                {formatToken(position.lockedAmount, 18)}
              </div>
            </div>
            <div>
              <div className="stat-label">DEBT (airUSD)</div>
              <div style={{ fontSize: "0.82rem", color: "var(--body)" }}>
                {formatUsdc(position.airUsdMinted)}
              </div>
            </div>
          </>
        )}

        {!position.isLong && (
          <>
            <div>
              <div className="stat-label">LOCKED USDC</div>
              <div style={{ fontSize: "0.82rem", color: "var(--body)" }}>
                {formatUsdc(position.lockedAmount)}
              </div>
            </div>
            <div>
              <div className="stat-label">DEBT (airTOKEN)</div>
              <div style={{ fontSize: "0.82rem", color: "var(--body)" }}>
                {formatToken(position.airTokenMinted, 18)}
              </div>
            </div>
          </>
        )}

        {/* PnL */}
        {pnlDisplay && (
          <div>
            <div className="stat-label">EST. PnL</div>
            <div
              style={{
                fontSize: "0.82rem",
                fontWeight: 600,
                color: pnlPositive ? "var(--green)" : "var(--red)",
              }}
            >
              {pnlDisplay}
            </div>
          </div>
        )}

        <div>
          <div className="stat-label">FEES PAID</div>
          <div style={{ fontSize: "0.82rem", color: "var(--body)" }}>
            {formatUsdc(position.feesPaid)}
          </div>
        </div>
      </div>

      {/* Pool address */}
      <p style={{ fontSize: "0.58rem", color: "var(--muted)", letterSpacing: "0.03em" }}>
        Pool: {position.pool.slice(0, 10)}...{position.pool.slice(-6)}
      </p>

      {/* Actions */}
      <div className="flex gap-2">
        <WithTooltip tip="Close your position and receive USDC back.">
          <TxButton
            idleLabel={position.isLong ? "Close Long" : "Close Short"}
            status={txStatus}
            variant={position.isLong ? "red" : "green"}
            onClick={() => {
              lastActionRef.current = "close";
              if (position.isLong) {
                writeContract({ address: position.pool, abi: exnihiloPoolAbi, functionName: "closeLong", args: [tokenId, 0n] });
              } else {
                writeContract({ address: position.pool, abi: exnihiloPoolAbi, functionName: "closeShort", args: [tokenId, 0n] });
              }
            }}
            disabled={!canClose}
            style={{ width: "100%", justifyContent: "center", fontSize: "0.62rem" }}
          />
        </WithTooltip>

        <WithTooltip tip="Pay the debt and receive the underlying locked tokens.">
          <TxButton
            idleLabel="Realize"
            status={txStatus}
            variant="default"
            onClick={() => {
              lastActionRef.current = "realize";
              if (position.isLong) {
                writeContract({ address: position.pool, abi: exnihiloPoolAbi, functionName: "realizeLong", args: [tokenId] });
              } else {
                writeContract({ address: position.pool, abi: exnihiloPoolAbi, functionName: "realizeShort", args: [tokenId] });
              }
            }}
            style={{ width: "100%", justifyContent: "center", fontSize: "0.62rem" }}
          />
        </WithTooltip>
      </div>

      {/* Close unavailable hint */}
      {!canClose && poolDataReady && (
        <p style={{ fontSize: "0.58rem", color: "var(--red)", letterSpacing: "0.04em", marginTop: -6 }}>
          {isExpired
            ? "EXPIRED -- position can be liquidated by anyone"
            : "Position is underwater -- close unavailable until PnL turns positive"}
        </p>
      )}
    </div>
  );
}
