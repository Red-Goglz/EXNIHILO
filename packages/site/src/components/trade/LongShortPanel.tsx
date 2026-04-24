import { useState, useEffect, useCallback } from "react";
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { useFormo } from "@formo/analytics";
import { exnihiloPoolAbi, exnihiloRouterAbi, erc20Abi } from "@exnihilio/abis";
import { parseUnits, formatToken, formatUsdc } from "../../lib/format.ts";
import { quoteLong, quoteShort } from "../../lib/amm.ts";
import { useRouterApproval } from "../../hooks/useRouterApproval.ts";
import TokenInput from "../shared/TokenInput.tsx";
import TxButton from "../shared/TxButton.tsx";

const POSITION_FEE_BPS = 500n;
const PROTOCOL_FEE_BPS = 200n;
const IMPACT_FEE_BPS = 1500n;
const MIN_POSITION_FEE = 50_000n; // 0.05 USDC (6 dec)

interface LongShortPanelProps {
  poolAddress: `0x${string}`;
  underlyingUsdc: `0x${string}`;
  tokenSymbol: string;
  tokenDecimals: number;
}

export default function LongShortPanel({
  poolAddress,
  underlyingUsdc,
  tokenSymbol,
  tokenDecimals,
}: LongShortPanelProps) {
  const { address } = useAccount();
  const queryClient = useQueryClient();
  const analytics = useFormo();

  const [isLong, setIsLong] = useState(true);
  const [usdcInput, setUsdcInput] = useState("");
  const [slippageMode, setSlippageMode] = useState<"auto" | "manual">("auto");
  const [manualSlippagePct, setManualSlippagePct] = useState("0.50");

  const usdcRaw = parseUnits(usdcInput, 6);

  const poolContract = { address: poolAddress, abi: exnihiloPoolAbi } as const;

  const { data } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "backedAirToken" },
      { ...poolContract, functionName: "backedAirUsd" },
      { ...poolContract, functionName: "spotPrice" },
      { ...poolContract, functionName: "effectiveLeverageCap" },
      { ...poolContract, functionName: "swapFeeBps" },
      { ...poolContract, functionName: "airToken" },
      { ...poolContract, functionName: "airUsdToken" },
      { ...poolContract, functionName: "longOpenInterest" },
      { ...poolContract, functionName: "shortOpenInterest" },
      {
        address: underlyingUsdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address ?? "0x0000000000000000000000000000000000000000", poolAddress],
      },
      { ...poolContract, functionName: "maxPositionUsd" },
      { ...poolContract, functionName: "maxPositionBps" },
      { ...poolContract, functionName: "closeDate" },
      { ...poolContract, functionName: "positionDuration" },
    ],
  });

  const backedAirToken = data?.[0]?.result as bigint | undefined;
  const backedAirUsd = data?.[1]?.result as bigint | undefined;
  const leverageCap = data?.[3]?.result as bigint | undefined;
  const swapFeeBps = data?.[4]?.result as bigint | undefined;
  const airTokenAddress = data?.[5]?.result as `0x${string}` | undefined;
  const airUsdAddress = data?.[6]?.result as `0x${string}` | undefined;
  const longOI = data?.[7]?.result as bigint | undefined;
  const shortOI = data?.[8]?.result as bigint | undefined;
  const allowance = data?.[9]?.result as bigint | undefined;
  const maxPositionUsd = data?.[10]?.result as bigint | undefined;
  const maxPositionBps = data?.[11]?.result as bigint | undefined;
  const closeDate = data?.[12]?.result as bigint | undefined;
  const positionDuration = data?.[13]?.result as bigint | undefined;
  const isClosed = closeDate !== undefined && closeDate > 0n;
  const isInactive =
    !isClosed &&
    backedAirToken !== undefined &&
    backedAirUsd !== undefined &&
    (backedAirToken === 0n || backedAirUsd === 0n);
  const isMarketClosed = isClosed || isInactive;
  // closeDate in the contract is (close trigger time + positionDuration) —
  // the "full wind-down" moment. Show the trigger time (when the LP closed it).
  const closedAt =
    isClosed && closeDate !== undefined && positionDuration !== undefined
      ? closeDate - positionDuration
      : undefined;

  const { data: supplyData } = useReadContracts({
    contracts:
      airTokenAddress && airUsdAddress
        ? [
            { address: airTokenAddress, abi: erc20Abi, functionName: "totalSupply" as const },
            { address: airUsdAddress,  abi: erc20Abi, functionName: "totalSupply" as const },
          ]
        : [],
    query: { enabled: !!airTokenAddress && !!airUsdAddress },
  });

  const airTokenTotalSupply = supplyData?.[0]?.result as bigint | undefined;
  const airUsdTotalSupply = supplyData?.[1]?.result as bigint | undefined;

  let previewOut: bigint | undefined;
  if (
    usdcRaw > 0n &&
    backedAirToken !== undefined &&
    backedAirUsd !== undefined &&
    airTokenTotalSupply !== undefined &&
    airUsdTotalSupply !== undefined &&
    swapFeeBps !== undefined
  ) {
    if (isLong) {
      previewOut = quoteLong(usdcRaw, airUsdTotalSupply, backedAirToken, swapFeeBps);
    } else {
      previewOut = quoteShort(usdcRaw, airTokenTotalSupply, backedAirUsd, swapFeeBps);
    }
  }

  // Price impact: amountIn / (reserveIn + amountIn), in bps
  // Long: reserveIn = airUsd.totalSupply (SWAP-2 virtual reserve)
  // Short: reserveIn = airToken.totalSupply (SWAP-3 virtual reserve)
  const priceImpactBps = (() => {
    if (usdcRaw === 0n) return 0n;
    if (isLong) {
      if (!airUsdTotalSupply || airUsdTotalSupply === 0n) return 0n;
      return (usdcRaw * 10_000n) / (airUsdTotalSupply + usdcRaw);
    } else {
      if (!airTokenTotalSupply || airTokenTotalSupply === 0n) return 0n;
      return (usdcRaw * 10_000n) / (airTokenTotalSupply + usdcRaw);
    }
  })();

  // Auto slippage = price impact + 0.1% MEV buffer (minimum 0.1%)
  const autoSlippageBps = priceImpactBps + 10n;

  const manualSlippageBps = (() => {
    const pct = parseFloat(manualSlippagePct);
    if (isNaN(pct) || pct <= 0) return 10n;
    return BigInt(Math.round(pct * 100));
  })();

  const slippageBps = slippageMode === "auto" ? autoSlippageBps : manualSlippageBps;
  const slippagePctDisplay = `${(Number(slippageBps) / 100).toFixed(2)}%`;

  const isHighImpact = priceImpactBps > 200n; // >2%

  const minOut =
    previewOut !== undefined && previewOut > 0n
      ? (previewOut * (10_000n - slippageBps)) / 10_000n
      : 0n;

  const baseFeeRaw = (usdcRaw * POSITION_FEE_BPS) / 10_000n;
  const baseFee = baseFeeRaw < MIN_POSITION_FEE ? MIN_POSITION_FEE : baseFeeRaw;
  const oi = (isLong ? longOI : shortOI) ?? 0n;
  const impactFee = backedAirUsd && backedAirUsd > 0n
    ? (IMPACT_FEE_BPS * usdcRaw * (2n * oi + usdcRaw)) / (2n * backedAirUsd * 10_000n)
    : 0n;
  const feePulled = baseFee + impactFee;

  const MAX_UINT256 = 2n ** 256n - 1n;
  const hasLeverageCap = leverageCap !== undefined && leverageCap !== MAX_UINT256;
  const overCap = hasLeverageCap && usdcRaw > 0n && usdcRaw > leverageCap!;

  // Build cap description for display
  const capDescription = (() => {
    if (!hasLeverageCap) return null;
    const parts: string[] = [];
    if (maxPositionUsd !== undefined && maxPositionUsd > 0n)
      parts.push(`$${formatUsdc(maxPositionUsd)} hard`);
    if (maxPositionBps !== undefined && maxPositionBps > 0n)
      parts.push(`${Number(maxPositionBps) / 100}% of pool`);
    return parts.length > 0 ? parts.join(" / ") : null;
  })();

  // Router: skip per-trade approval when router has sufficient allowance
  const { routerAddress, routerAllowance } = useRouterApproval(underlyingUsdc);
  const useRouter = !!routerAddress && routerAllowance !== undefined && routerAllowance >= feePulled && usdcRaw > 0n;

  const { writeContract: writeApprove, data: approveHash, isPending: approvePending, isError: approveRejected } = useWriteContract();
  const { isLoading: approveConfirming, isSuccess: approveSuccess, isError: approveFailed } = useWaitForTransactionReceipt({ hash: approveHash });

  const needsApproval = !useRouter && !approveSuccess && allowance !== undefined && feePulled > allowance;

  useEffect(() => {
    if (approveSuccess) queryClient.invalidateQueries();
  }, [approveSuccess, queryClient]);

  const { writeContract: writeOpen, data: openHash, isPending: openPending, isError: openRejected, reset: resetOpen } = useWriteContract();
  const { isLoading: openConfirming, isSuccess: openSuccess, isError: openFailed } = useWaitForTransactionReceipt({ hash: openHash });

  // 8-second timeout for mining
  const [openTimedOut, setOpenTimedOut] = useState(false);
  useEffect(() => {
    if (!openHash || openSuccess || openFailed) { setOpenTimedOut(false); return; }
    const timer = setTimeout(() => setOpenTimedOut(true), 8_000);
    return () => clearTimeout(timer);
  }, [openHash, openSuccess, openFailed]);

  // Toast notifications (bottom-right)
  const [toast, setToast] = useState<{ message: string; key: number } | null>(null);
  const showToast = useCallback((message: string) => {
    setToast({ message, key: Date.now() });
  }, []);

  // Auto-dismiss toast after 5s
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5_000);
    return () => clearTimeout(t);
  }, [toast]);

  // Show toast on error/timeout
  useEffect(() => { if (openRejected) showToast("TRANSACTION REJECTED"); }, [openRejected, showToast]);
  useEffect(() => { if (openFailed) showToast("TRANSACTION FAILED"); }, [openFailed, showToast]);
  useEffect(() => { if (openTimedOut) showToast("CONFIRMATION TIMED OUT"); }, [openTimedOut, showToast]);
  useEffect(() => { if (approveRejected) showToast("APPROVAL REJECTED"); }, [approveRejected, showToast]);
  useEffect(() => { if (approveFailed) showToast("APPROVAL FAILED"); }, [approveFailed, showToast]);

  // Reset error state when user changes input so they can retry
  useEffect(() => {
    if (openRejected || openTimedOut) resetOpen();
  }, [usdcInput, isLong]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh all data once the tx is actually mined (not just submitted)
  useEffect(() => {
    if (openSuccess) {
      queryClient.invalidateQueries();
      const protocolFeeRaw = (usdcRaw * PROTOCOL_FEE_BPS) / 10_000n;
      analytics?.track(isLong ? "Position Opened Long" : "Position Opened Short", {
        pool: poolAddress,
        tokenSymbol,
        usdcNotional: usdcRaw.toString(),
        fee: feePulled.toString(),
        volume: Number(usdcRaw) / 1_000_000,
        revenue: Number(protocolFeeRaw) / 1_000_000,
        points: Number(feePulled) / 1_000_000,
      });
      setUsdcInput("");
    }
  }, [openSuccess, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  const approveStatus = approvePending ? "pending" : approveConfirming ? "confirming" : approveSuccess ? "success" : (approveRejected || approveFailed) ? "error" : "idle";
  const openStatus = openPending ? "pending" : openConfirming ? "confirming" : openSuccess ? "success" : (openRejected || openFailed || openTimedOut) ? "error" : "idle";
  const openErrorLabel = openTimedOut ? "TIMED OUT" : openRejected ? "REJECTED" : "FAILED";

  return (
    <div className="flex flex-col gap-4">
      {/* Long / Short toggle */}
      <div style={{ display: "flex", gap: 0, border: "1px solid var(--border)" }}>
        <button
          onClick={() => { setIsLong(true); setUsdcInput(""); }}
          style={{
            flex: 1,
            padding: "9px 12px",
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            letterSpacing: "0.1em",
            fontWeight: 600,
            border: "none",
            borderRight: "1px solid var(--border)",
            background: isLong ? "var(--green-glow)" : "transparent",
            color: isLong ? "var(--green)" : "var(--muted)",
            cursor: "pointer",
            transition: "all 0.15s",
          }}
        >
          ▲ LONG {tokenSymbol}
        </button>
        <button
          onClick={() => { setIsLong(false); setUsdcInput(""); }}
          style={{
            flex: 1,
            padding: "9px 12px",
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            letterSpacing: "0.1em",
            fontWeight: 600,
            border: "none",
            background: !isLong ? "var(--red-glow)" : "transparent",
            color: !isLong ? "var(--red)" : "var(--muted)",
            cursor: "pointer",
            transition: "all 0.15s",
          }}
        >
          ▼ SHORT {tokenSymbol}
        </button>
      </div>

      {/* Info bar */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div style={{ background: "var(--surface-2)", border: `1px solid ${overCap ? "var(--red)" : "var(--border)"}`, padding: "10px 12px", transition: "border-color 0.15s" }}>
          <div className="stat-label">POSITION CAP</div>
          <div style={{ fontSize: "0.82rem", color: overCap ? "var(--red)" : "var(--body)" }}>
            {leverageCap === undefined ? "—" : !hasLeverageCap ? "NONE" : `$${formatUsdc(leverageCap!)}`}
          </div>
          {capDescription && (
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", color: "var(--muted)", marginTop: 2 }}>
              {capDescription}
            </div>
          )}
        </div>
        <div style={{ background: "var(--surface-2)", border: "1px solid var(--border)", padding: "10px 12px" }}>
          <div className="stat-label">POSITION FEE</div>
          <div style={{ fontSize: "0.82rem", color: "var(--body)" }}>
            {usdcRaw > 0n && feePulled > 0n
              ? `${formatUsdc(feePulled)} ($${(Number(feePulled) * 100 / Number(usdcRaw)).toFixed(1)}%)`
              : "5% + impact"}
          </div>
        </div>
      </div>

      <TokenInput
        label={isLong ? "USDC Notional (Long)" : "USDC Notional (Short)"}
        value={usdcInput}
        onChange={setUsdcInput}
        tokenAddress={underlyingUsdc}
        decimals={6}
        symbol="USDC"
        capRaw={hasLeverageCap ? leverageCap : undefined}
        capLabel="POSITION CAP"
      />

      {/* Slippage control */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 10px",
          background: "var(--surface-2)",
          border: `1px solid ${isHighImpact ? "var(--orange)" : "var(--border)"}`,
          transition: "border-color 0.15s",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.6rem",
            letterSpacing: "0.1em",
            color: isHighImpact ? "var(--orange)" : "var(--muted)",
          }}
        >
          {isHighImpact ? "⚠ HIGH IMPACT · SLIPPAGE" : "SLIPPAGE"}
        </span>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {slippageMode === "auto" ? (
            <>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--cyan)" }}>
                AUTO {slippagePctDisplay}
              </span>
              <button
                onClick={() => {
                  setManualSlippagePct((Number(slippageBps) / 100).toFixed(2));
                  setSlippageMode("manual");
                }}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.58rem",
                  letterSpacing: "0.05em",
                  color: "var(--muted)",
                  background: "transparent",
                  border: "1px solid var(--border)",
                  padding: "2px 7px",
                  cursor: "pointer",
                  transition: "color 0.15s, border-color 0.15s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.color = "var(--body)";
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--muted)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.color = "var(--muted)";
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)";
                }}
              >
                EDIT
              </button>
            </>
          ) : (
            <>
              <input
                type="number"
                min="0.01"
                max="50"
                step="0.01"
                value={manualSlippagePct}
                onChange={(e) => setManualSlippagePct(e.target.value)}
                style={{
                  width: 58,
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.72rem",
                  color: "var(--body)",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  padding: "2px 6px",
                  textAlign: "right",
                  outline: "none",
                }}
              />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--muted)" }}>
                %
              </span>
              <button
                onClick={() => setSlippageMode("auto")}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.58rem",
                  letterSpacing: "0.05em",
                  color: "var(--cyan)",
                  background: "transparent",
                  border: "1px solid var(--cyan)",
                  padding: "2px 7px",
                  cursor: "pointer",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,229,255,0.08)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                }}
              >
                AUTO
              </button>
            </>
          )}
        </div>
      </div>

      {/* Market closed / inactive notice */}
      {isMarketClosed && (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.62rem",
            letterSpacing: "0.05em",
            color: "var(--red)",
            background: "rgba(239,68,68,0.08)",
            border: "1px solid var(--red)",
            padding: "8px 10px",
          }}
        >
          {isClosed
            ? `MARKET CLOSED — no new positions can be opened.${
                closedAt !== undefined
                  ? ` Closed ${new Date(Number(closedAt) * 1000).toLocaleString()}.`
                  : ""
              }`
            : "MARKET INACTIVE — all liquidity has been withdrawn. No new positions can be opened."}
        </div>
      )}

      {/* Over-cap warning */}
      {overCap && (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.62rem",
            letterSpacing: "0.05em",
            color: "var(--red)",
            background: "rgba(239,68,68,0.08)",
            border: "1px solid var(--red)",
            padding: "8px 10px",
          }}
        >
          EXCEEDS POSITION CAP — max ${formatUsdc(leverageCap!)} USDC
        </div>
      )}

      {/* Fee note */}
      {usdcRaw > 0n && !overCap && (
        <p style={{ fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--muted)", letterSpacing: "0.05em" }}>
          Fee from wallet: {formatUsdc(feePulled)} {baseFeeRaw < MIN_POSITION_FEE ? "(min $0.05 + impact)" : `(5% base${impactFee > 0n ? " + impact" : ""})`}
        </p>
      )}

      {/* Preview */}
      {previewOut !== undefined && previewOut > 0n && (
        <div
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div className="flex justify-between">
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--muted)", letterSpacing: "0.1em" }}>
              {isLong ? `EST. ${tokenSymbol} LOCKED` : "EST. USDC LOCKED"}
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: isLong ? "var(--green)" : "var(--red)" }}>
              {formatToken(previewOut, isLong ? tokenDecimals : 6)} {isLong ? tokenSymbol : "USDC"}
            </span>
          </div>
          <div className="flex justify-between">
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--muted)", letterSpacing: "0.1em" }}>
              MIN ({slippagePctDisplay} SLIP)
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "#f59e0b" }}>
              {formatToken(minOut, isLong ? tokenDecimals : 6)} {isLong ? tokenSymbol : "USDC"}
            </span>
          </div>
        </div>
      )}

      {needsApproval ? (
        <TxButton
          idleLabel="Approve USDC"
          status={approveStatus}
          onClick={() =>
            writeApprove({
              address: underlyingUsdc,
              abi: erc20Abi,
              functionName: "approve",
              args: [poolAddress, feePulled],
            })
          }
          disabled={usdcRaw === 0n}
          style={{ width: "100%", justifyContent: "center" }}
        />
      ) : (
        <TxButton
          idleLabel={isLong ? `Open Long ${tokenSymbol}` : `Open Short ${tokenSymbol}`}
          status={openStatus}
          errorLabel={openErrorLabel}
          variant={isLong ? "green" : "red"}
          onClick={() => {
            if (useRouter) {
              writeOpen({
                address: routerAddress!,
                abi: exnihiloRouterAbi,
                functionName: isLong ? "openLong" : "openShort",
                args: [poolAddress, usdcRaw, minOut],
              });
            } else if (isLong) {
              writeOpen({
                address: poolAddress,
                abi: exnihiloPoolAbi,
                functionName: "openLong",
                args: [usdcRaw, minOut, address!],
              });
            } else {
              writeOpen({
                address: poolAddress,
                abi: exnihiloPoolAbi,
                functionName: "openShort",
                args: [usdcRaw, minOut, address!],
              });
            }
          }}
          disabled={usdcRaw === 0n || minOut === 0n || overCap || isMarketClosed}
          style={{ width: "100%", justifyContent: "center" }}
        />
      )}

      {/* Error / timeout toast — bottom-right */}
      {toast && (
        <div
          key={toast.key}
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            zIndex: 9999,
            background: "var(--surface)",
            border: "1px solid var(--red)",
            padding: "12px 20px",
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            letterSpacing: "0.08em",
            color: "var(--red)",
            boxShadow: "0 4px 24px rgba(239,68,68,0.25)",
            animation: "toast-in 0.2s ease-out",
            cursor: "pointer",
          }}
          onClick={() => setToast(null)}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
