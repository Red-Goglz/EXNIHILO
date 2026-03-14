import { useState, useEffect } from "react";
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { exnihiloPoolAbi, erc20Abi } from "@exnihilio/abis";
import { parseUnits, formatToken } from "../../lib/format.ts";
import { cpAmountOut } from "../../lib/amm.ts";
import TokenInput from "../shared/TokenInput.tsx";
import TxButton from "../shared/TxButton.tsx";

interface SwapPanelProps {
  poolAddress: `0x${string}`;
  underlyingToken: `0x${string}`;
  underlyingUsdc: `0x${string}`;
  tokenSymbol: string;
  tokenDecimals: number;
}

export default function SwapPanel({
  poolAddress,
  underlyingToken,
  underlyingUsdc,
  tokenSymbol,
  tokenDecimals,
}: SwapPanelProps) {
  const { address } = useAccount();
  const queryClient = useQueryClient();

  const [tokenToUsdc, setTokenToUsdc] = useState(true);
  const [amountIn, setAmountIn] = useState("");
  const [slippageMode, setSlippageMode] = useState<"auto" | "manual">("auto");
  const [manualSlippagePct, setManualSlippagePct] = useState("0.50");

  const amountInRaw = parseUnits(amountIn, tokenToUsdc ? tokenDecimals : 6);
  const tokenIn = tokenToUsdc ? underlyingToken : underlyingUsdc;
  const tokenInDecimals = tokenToUsdc ? tokenDecimals : 6;
  const tokenInSymbol = tokenToUsdc ? tokenSymbol : "USDC";
  const tokenOutSymbol = tokenToUsdc ? "USDC" : tokenSymbol;

  const poolContract = { address: poolAddress, abi: exnihiloPoolAbi } as const;

  const { data: poolData } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "backedAirToken" },
      { ...poolContract, functionName: "backedAirUsd" },
      { ...poolContract, functionName: "swapFeeBps" },
    ],
  });

  const { data: allowanceData } = useReadContracts({
    contracts: address ? [
      {
        address: tokenIn,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, poolAddress],
      },
    ] : [],
    query: { enabled: !!address },
  });

  const backedAirToken = poolData?.[0]?.result as bigint | undefined;
  const backedAirUsd  = poolData?.[1]?.result as bigint | undefined;
  const swapFeeBps    = poolData?.[2]?.result as bigint | undefined;
  const allowance = allowanceData?.[0]?.result as bigint | undefined;

  // Client-side SWAP-1 quote — matches _cpAmountOut in the contract exactly.
  const quoted =
    amountInRaw > 0n && backedAirToken !== undefined && backedAirUsd !== undefined && swapFeeBps !== undefined
      ? tokenToUsdc
        ? cpAmountOut(amountInRaw, backedAirToken, backedAirUsd, swapFeeBps)
        : cpAmountOut(amountInRaw, backedAirUsd, backedAirToken, swapFeeBps)
      : undefined;

  // Price impact: amountIn / (reserveIn + amountIn) in bps
  const priceImpactBps = (() => {
    if (amountInRaw === 0n) return 0n;
    if (tokenToUsdc) {
      if (!backedAirToken || backedAirToken === 0n) return 0n;
      return (amountInRaw * 10_000n) / (backedAirToken + amountInRaw);
    } else {
      if (!backedAirUsd || backedAirUsd === 0n) return 0n;
      return (amountInRaw * 10_000n) / (backedAirUsd + amountInRaw);
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

  const minAmountOut =
    quoted !== undefined && quoted > 0n
      ? (quoted * (10_000n - slippageBps)) / 10_000n
      : 0n;

  const { writeContract: writeApprove, data: approveHash, isPending: approvePending } = useWriteContract();
  const { isLoading: approveConfirming, isSuccess: approveSuccess } = useWaitForTransactionReceipt({ hash: approveHash });

  useEffect(() => {
    if (approveSuccess) queryClient.invalidateQueries();
  }, [approveSuccess, queryClient]);

  const needsApproval = !approveSuccess && allowance !== undefined && amountInRaw > allowance;

  const { writeContract: writeSwap, data: swapHash, isPending: swapPending } = useWriteContract();
  const { isLoading: swapConfirming, isSuccess: swapSuccess } = useWaitForTransactionReceipt({ hash: swapHash });

  const handleSwapSuccess = () => {
    queryClient.invalidateQueries();
    setAmountIn("");
  };

  const approveStatus = approvePending ? "pending" : approveConfirming ? "confirming" : approveSuccess ? "success" : "idle";
  const swapStatus = swapPending ? "pending" : swapConfirming ? "confirming" : swapSuccess ? "success" : "idle";

  return (
    <div className="flex flex-col gap-4">
      {/* Direction toggle */}
      <div
        style={{
          display: "flex",
          gap: 0,
          border: "1px solid var(--border)",
        }}
      >
        <button
          onClick={() => { setTokenToUsdc(true); setAmountIn(""); }}
          style={{
            flex: 1,
            padding: "8px 12px",
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            letterSpacing: "0.08em",
            border: "none",
            background: tokenToUsdc ? "var(--cyan-glow)" : "transparent",
            color: tokenToUsdc ? "var(--cyan)" : "var(--muted)",
            cursor: "pointer",
            borderRight: "1px solid var(--border)",
            transition: "all 0.15s",
          }}
        >
          {tokenSymbol} → USDC
        </button>
        <button
          onClick={() => { setTokenToUsdc(false); setAmountIn(""); }}
          style={{
            flex: 1,
            padding: "8px 12px",
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            letterSpacing: "0.08em",
            border: "none",
            background: !tokenToUsdc ? "var(--cyan-glow)" : "transparent",
            color: !tokenToUsdc ? "var(--cyan)" : "var(--muted)",
            cursor: "pointer",
            transition: "all 0.15s",
          }}
        >
          USDC → {tokenSymbol}
        </button>
      </div>

      <TokenInput
        label="Amount In"
        value={amountIn}
        onChange={setAmountIn}
        tokenAddress={tokenIn}
        decimals={tokenInDecimals}
        symbol={tokenInSymbol}
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

      {/* Quote */}
      {quoted !== undefined && quoted > 0n && (
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
              EXPECTED OUT
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--body)" }}>
              {formatToken(quoted, tokenToUsdc ? 6 : tokenDecimals)} {tokenOutSymbol}
            </span>
          </div>
          <div className="flex justify-between">
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--muted)", letterSpacing: "0.1em" }}>
              MIN ({slippagePctDisplay} SLIP)
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "#f59e0b" }}>
              {formatToken(minAmountOut, tokenToUsdc ? 6 : tokenDecimals)} {tokenOutSymbol}
            </span>
          </div>
        </div>
      )}

      {/* Approve or Swap */}
      {needsApproval ? (
        <TxButton
          idleLabel={`Approve ${tokenInSymbol}`}
          status={approveStatus}
          onClick={() =>
            writeApprove({
              address: tokenIn,
              abi: erc20Abi,
              functionName: "approve",
              args: [poolAddress, amountInRaw],
            })
          }
          disabled={amountInRaw === 0n}
          style={{ width: "100%", justifyContent: "center" }}
        />
      ) : (
        <TxButton
          idleLabel="Swap"
          status={swapStatus}
          onClick={() =>
            writeSwap(
              {
                address: poolAddress,
                abi: exnihiloPoolAbi,
                functionName: "swap",
                args: [amountInRaw, minAmountOut, tokenToUsdc, address!],
              },
              { onSuccess: handleSwapSuccess }
            )
          }
          disabled={amountInRaw === 0n || minAmountOut === 0n}
          style={{ width: "100%", justifyContent: "center" }}
        />
      )}
    </div>
  );
}
