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
  underlyingMeme: `0x${string}`;
  underlyingUsdc: `0x${string}`;
  memeSymbol: string;
  memeDecimals: number;
}

export default function SwapPanel({
  poolAddress,
  underlyingMeme,
  underlyingUsdc,
  memeSymbol,
  memeDecimals,
}: SwapPanelProps) {
  const { address } = useAccount();
  const queryClient = useQueryClient();

  const [memeToUsdc, setMemeToUsdc] = useState(true);
  const [amountIn, setAmountIn] = useState("");
  const [slippageMode, setSlippageMode] = useState<"auto" | "manual">("auto");
  const [manualSlippagePct, setManualSlippagePct] = useState("0.50");

  const amountInRaw = parseUnits(amountIn, memeToUsdc ? memeDecimals : 6);
  const tokenIn = memeToUsdc ? underlyingMeme : underlyingUsdc;
  const tokenInDecimals = memeToUsdc ? memeDecimals : 6;
  const tokenInSymbol = memeToUsdc ? memeSymbol : "USDC";
  const tokenOutSymbol = memeToUsdc ? "USDC" : memeSymbol;

  const poolContract = { address: poolAddress, abi: exnihiloPoolAbi } as const;

  const { data: poolData } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "backedAirMeme" },
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

  const backedAirMeme = poolData?.[0]?.result as bigint | undefined;
  const backedAirUsd  = poolData?.[1]?.result as bigint | undefined;
  const swapFeeBps    = poolData?.[2]?.result as bigint | undefined;
  const allowance = allowanceData?.[0]?.result as bigint | undefined;

  // Client-side SWAP-1 quote — matches _cpAmountOut in the contract exactly.
  const quoted =
    amountInRaw > 0n && backedAirMeme !== undefined && backedAirUsd !== undefined && swapFeeBps !== undefined
      ? memeToUsdc
        ? cpAmountOut(amountInRaw, backedAirMeme, backedAirUsd, swapFeeBps)
        : cpAmountOut(amountInRaw, backedAirUsd, backedAirMeme, swapFeeBps)
      : undefined;

  // Price impact: amountIn / (reserveIn + amountIn) in bps
  const priceImpactBps = (() => {
    if (amountInRaw === 0n) return 0n;
    if (memeToUsdc) {
      if (!backedAirMeme || backedAirMeme === 0n) return 0n;
      return (amountInRaw * 10_000n) / (backedAirMeme + amountInRaw);
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
          onClick={() => { setMemeToUsdc(true); setAmountIn(""); }}
          style={{
            flex: 1,
            padding: "8px 12px",
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            letterSpacing: "0.08em",
            border: "none",
            background: memeToUsdc ? "var(--cyan-glow)" : "transparent",
            color: memeToUsdc ? "var(--cyan)" : "var(--muted)",
            cursor: "pointer",
            borderRight: "1px solid var(--border)",
            transition: "all 0.15s",
          }}
        >
          {memeSymbol} → USDC
        </button>
        <button
          onClick={() => { setMemeToUsdc(false); setAmountIn(""); }}
          style={{
            flex: 1,
            padding: "8px 12px",
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            letterSpacing: "0.08em",
            border: "none",
            background: !memeToUsdc ? "var(--cyan-glow)" : "transparent",
            color: !memeToUsdc ? "var(--cyan)" : "var(--muted)",
            cursor: "pointer",
            transition: "all 0.15s",
          }}
        >
          USDC → {memeSymbol}
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
              {formatToken(quoted, memeToUsdc ? 6 : memeDecimals)} {tokenOutSymbol}
            </span>
          </div>
          <div className="flex justify-between">
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--muted)", letterSpacing: "0.1em" }}>
              MIN ({slippagePctDisplay} SLIP)
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "#f59e0b" }}>
              {formatToken(minAmountOut, memeToUsdc ? 6 : memeDecimals)} {tokenOutSymbol}
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
                args: [amountInRaw, minAmountOut, memeToUsdc],
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
