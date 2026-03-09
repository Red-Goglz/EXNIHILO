import { useState, useEffect } from "react";
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { exnihiloPoolAbi, erc20Abi } from "@exnihilio/abis";
import { parseUnits, formatToken, formatUsdc } from "../../lib/format.ts";
import { quoteLong, quoteShort } from "../../lib/amm.ts";
import TokenInput from "../shared/TokenInput.tsx";
import TxButton from "../shared/TxButton.tsx";

const POSITION_FEE_BPS = 500n;
const MIN_POSITION_FEE = 50_000n; // 0.05 USDC (6 dec)

interface LongShortPanelProps {
  poolAddress: `0x${string}`;
  underlyingUsdc: `0x${string}`;
  memeSymbol: string;
  memeDecimals: number;
}

export default function LongShortPanel({
  poolAddress,
  underlyingUsdc,
  memeSymbol,
  memeDecimals,
}: LongShortPanelProps) {
  const { address } = useAccount();
  const queryClient = useQueryClient();

  const [isLong, setIsLong] = useState(true);
  const [usdcInput, setUsdcInput] = useState("");
  const [slippageMode, setSlippageMode] = useState<"auto" | "manual">("auto");
  const [manualSlippagePct, setManualSlippagePct] = useState("0.50");

  const usdcRaw = parseUnits(usdcInput, 6);

  const poolContract = { address: poolAddress, abi: exnihiloPoolAbi } as const;

  const { data } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "backedAirMeme" },
      { ...poolContract, functionName: "backedAirUsd" },
      { ...poolContract, functionName: "spotPrice" },
      { ...poolContract, functionName: "effectiveLeverageCap" },
      { ...poolContract, functionName: "swapFeeBps" },
      { ...poolContract, functionName: "airMemeToken" },
      { ...poolContract, functionName: "airUsdToken" },
      {
        address: underlyingUsdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address ?? "0x0000000000000000000000000000000000000000", poolAddress],
      },
    ],
  });

  const backedAirMeme = data?.[0]?.result as bigint | undefined;
  const backedAirUsd = data?.[1]?.result as bigint | undefined;
  const leverageCap = data?.[3]?.result as bigint | undefined;
  const swapFeeBps = data?.[4]?.result as bigint | undefined;
  const airMemeAddress = data?.[5]?.result as `0x${string}` | undefined;
  const airUsdAddress = data?.[6]?.result as `0x${string}` | undefined;
  const allowance = data?.[7]?.result as bigint | undefined;

  const { data: supplyData } = useReadContracts({
    contracts:
      airMemeAddress && airUsdAddress
        ? [
            { address: airMemeAddress, abi: erc20Abi, functionName: "totalSupply" as const },
            { address: airUsdAddress,  abi: erc20Abi, functionName: "totalSupply" as const },
          ]
        : [],
    query: { enabled: !!airMemeAddress && !!airUsdAddress },
  });

  const airMemeTotalSupply = supplyData?.[0]?.result as bigint | undefined;
  const airUsdTotalSupply = supplyData?.[1]?.result as bigint | undefined;

  let previewOut: bigint | undefined;
  if (
    usdcRaw > 0n &&
    backedAirMeme !== undefined &&
    backedAirUsd !== undefined &&
    airMemeTotalSupply !== undefined &&
    airUsdTotalSupply !== undefined &&
    swapFeeBps !== undefined
  ) {
    if (isLong) {
      previewOut = quoteLong(usdcRaw, airUsdTotalSupply, backedAirMeme, swapFeeBps);
    } else {
      previewOut = quoteShort(usdcRaw, airMemeTotalSupply, backedAirUsd, swapFeeBps);
    }
  }

  // Price impact: amountIn / (reserveIn + amountIn), in bps
  // Long: reserveIn = airUsd.totalSupply (SWAP-2 virtual reserve)
  // Short: reserveIn = airMeme.totalSupply (SWAP-3 virtual reserve)
  const priceImpactBps = (() => {
    if (usdcRaw === 0n) return 0n;
    if (isLong) {
      if (!airUsdTotalSupply || airUsdTotalSupply === 0n) return 0n;
      return (usdcRaw * 10_000n) / (airUsdTotalSupply + usdcRaw);
    } else {
      if (!airMemeTotalSupply || airMemeTotalSupply === 0n) return 0n;
      return (usdcRaw * 10_000n) / (airMemeTotalSupply + usdcRaw);
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

  const feePctRaw = (usdcRaw * POSITION_FEE_BPS) / 10_000n;
  const feePulled = feePctRaw < MIN_POSITION_FEE ? MIN_POSITION_FEE : feePctRaw;
  const { writeContract: writeApprove, data: approveHash, isPending: approvePending } = useWriteContract();
  const { isLoading: approveConfirming, isSuccess: approveSuccess } = useWaitForTransactionReceipt({ hash: approveHash });

  const needsApproval = !approveSuccess && allowance !== undefined && feePulled > allowance;

  useEffect(() => {
    if (approveSuccess) queryClient.invalidateQueries();
  }, [approveSuccess, queryClient]);

  const { writeContract: writeOpen, data: openHash, isPending: openPending } = useWriteContract();
  const { isLoading: openConfirming, isSuccess: openSuccess } = useWaitForTransactionReceipt({ hash: openHash });

  const handleOpenSuccess = () => {
    queryClient.invalidateQueries();
    setUsdcInput("");
  };

  const approveStatus = approvePending ? "pending" : approveConfirming ? "confirming" : approveSuccess ? "success" : "idle";
  const openStatus = openPending ? "pending" : openConfirming ? "confirming" : openSuccess ? "success" : "idle";

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
          ▲ LONG {memeSymbol}
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
          ▼ SHORT {memeSymbol}
        </button>
      </div>

      {/* Info bar */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div style={{ background: "var(--surface-2)", border: "1px solid var(--border)", padding: "10px 12px" }}>
          <div className="stat-label">LEVERAGE CAP</div>
          <div style={{ fontSize: "0.82rem", color: "var(--body)" }}>
            {leverageCap === undefined ? "—" : leverageCap === 2n ** 256n - 1n ? "UNLIMITED" : `${leverageCap}×`}
          </div>
        </div>
        <div style={{ background: "var(--surface-2)", border: "1px solid var(--border)", padding: "10px 12px" }}>
          <div className="stat-label">POSITION FEE</div>
          <div style={{ fontSize: "0.82rem", color: "var(--body)" }}>5.00%</div>
        </div>
      </div>

      <TokenInput
        label={isLong ? "USDC Notional (Long)" : "USDC Notional (Short)"}
        value={usdcInput}
        onChange={setUsdcInput}
        tokenAddress={underlyingUsdc}
        decimals={6}
        symbol="USDC"
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

      {/* Fee note */}
      {usdcRaw > 0n && (
        <p style={{ fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--muted)", letterSpacing: "0.05em" }}>
          Fee from wallet: {formatUsdc(feePulled)} {feePctRaw < MIN_POSITION_FEE ? "(min $0.05)" : "(5% of notional)"}
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
              {isLong ? `EST. ${memeSymbol} LOCKED` : "EST. USDC LOCKED"}
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: isLong ? "var(--green)" : "var(--red)" }}>
              {formatToken(previewOut, isLong ? memeDecimals : 6)} {isLong ? memeSymbol : "USDC"}
            </span>
          </div>
          <div className="flex justify-between">
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--muted)", letterSpacing: "0.1em" }}>
              MIN ({slippagePctDisplay} SLIP)
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "#f59e0b" }}>
              {formatToken(minOut, isLong ? memeDecimals : 6)} {isLong ? memeSymbol : "USDC"}
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
          idleLabel={isLong ? `Open Long ${memeSymbol}` : `Open Short ${memeSymbol}`}
          status={openStatus}
          variant={isLong ? "green" : "red"}
          onClick={() => {
            if (isLong) {
              writeOpen(
                {
                  address: poolAddress,
                  abi: exnihiloPoolAbi,
                  functionName: "openLong",
                  args: [usdcRaw, minOut],
                },
                { onSuccess: handleOpenSuccess }
              );
            } else {
              writeOpen(
                {
                  address: poolAddress,
                  abi: exnihiloPoolAbi,
                  functionName: "openShort",
                  args: [usdcRaw, minOut],
                },
                { onSuccess: handleOpenSuccess }
              );
            }
          }}
          disabled={usdcRaw === 0n || minOut === 0n}
          style={{ width: "100%", justifyContent: "center" }}
        />
      )}
    </div>
  );
}
