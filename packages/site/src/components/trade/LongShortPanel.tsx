import { useState, useEffect } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { useFormo } from "@formo/analytics";
import { exnihiloPoolAbi, exnihiloRouterAbi, erc20Abi } from "@exnihilio/abis";
import { parseUnits, formatToken, formatUsdc, formatDuration } from "../../lib/format.ts";
import { quoteLong, quoteShort } from "../../lib/amm.ts";
import { useRouterApproval } from "../../hooks/useRouterApproval.ts";
import { useOpenFee } from "../../hooks/useOpenFee.ts";
import { useNeedsPerTradeApproval } from "../../hooks/useRouterApprovalPrompt.ts";
import { useTx } from "../../hooks/useTx.ts";
import { useAppChain } from "../../hooks/useAppChain.ts";
import TokenInput from "../shared/TokenInput.tsx";
import TxButton from "../shared/TxButton.tsx";

// Display-only fallbacks while quoteOpenFee is in flight. The authoritative
// fee (base + floor + OI-integral impact) comes from the pool via useOpenFee.
const POSITION_FEE_BPS = 500n;
const PROTOCOL_FEE_BPS = 200n;
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
  const { chainId } = useAppChain();
  const queryClient = useQueryClient();
  const analytics = useFormo();

  const [isLong, setIsLong] = useState(true);
  const [usdcInput, setUsdcInput] = useState("");
  const [slippageMode, setSlippageMode] = useState<"auto" | "manual">("auto");
  const [manualSlippagePct, setManualSlippagePct] = useState("0.50");

  const usdcRaw = parseUnits(usdcInput, 6);

  const poolContract = { address: poolAddress, abi: exnihiloPoolAbi, chainId } as const;

  const { data } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "backedAirToken" },
      { ...poolContract, functionName: "backedAirUsd" },
      { ...poolContract, functionName: "spotPrice" },
      { ...poolContract, functionName: "effectiveLeverageCap" },
      { ...poolContract, functionName: "swapFeeBps" },
      { ...poolContract, functionName: "airTokenSupply" },
      { ...poolContract, functionName: "airUsdSupply" },
      {
        address: underlyingUsdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address ?? "0x0000000000000000000000000000000000000000", poolAddress],
        chainId,
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
  const airTokenTotalSupply = data?.[5]?.result as bigint | undefined;
  const airUsdTotalSupply = data?.[6]?.result as bigint | undefined;
  const allowance = data?.[7]?.result as bigint | undefined;
  const maxPositionUsd = data?.[8]?.result as bigint | undefined;
  const maxPositionBps = data?.[9]?.result as bigint | undefined;
  const closeDate = data?.[10]?.result as bigint | undefined;
  const positionDuration = data?.[11]?.result as bigint | undefined;
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

  // Fee comes from the pool. quoteOpenFee is the contract's documented single
  // source of truth (base + MIN_POSITION_FEE floor + OI-integral impact); the
  // formula used to be replicated here, which drifts the moment the contract
  // changes and silently under-approves in the meantime.
  const { fee: quotedFee, feeMax: quotedFeeMax } =
    useOpenFee(poolAddress, chainId, usdcRaw, isLong);

  const baseFeeRaw = (usdcRaw * POSITION_FEE_BPS) / 10_000n;
  // Display only, while the quote is in flight.
  const feePulled = quotedFee ?? (baseFeeRaw < MIN_POSITION_FEE ? MIN_POSITION_FEE : baseFeeRaw);
  const hasImpactFee = quotedFee !== undefined && quotedFee > baseFeeRaw && baseFeeRaw >= MIN_POSITION_FEE;

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
  const useRouter = !!routerAddress && routerAllowance !== undefined
    && quotedFeeMax !== undefined && routerAllowance >= quotedFeeMax && usdcRaw > 0n;

  const {
    writeContract: writeApprove,
    status: approveStatus,
    isSuccess: approveSuccess,
  } = useTx("APPROVAL");

  useEffect(() => {
    if (approveSuccess) queryClient.invalidateQueries();
  }, [approveSuccess, queryClient]);

  const {
    writeContract: writeOpen,
    status: openStatus,
    isSuccess: openSuccess,
    errorLabel: openErrorLabel,
    reset: resetOpen,
  } = useTx("TRANSACTION");

  // Compared against the live allowance rather than latching on `approveSuccess`:
  // latching meant that raising the amount after approving skipped straight to
  // an open that reverts.
  //
  // `!openSuccess` is what keeps the success state terminal — opening spends the
  // approval, so the refetched allowance would otherwise drop back below the fee
  // and swap this component back to the "Approve USDC" button on success.
  const needsApproval = !openSuccess && !useRouter && allowance !== undefined
    && quotedFeeMax !== undefined && quotedFeeMax > allowance;

  // Offer the router pre-approval instead of making the user sign per trade.
  useNeedsPerTradeApproval(needsApproval && !!address);

  // Reset error state when user changes input so they can retry
  useEffect(() => {
    if (openStatus === "error") resetOpen();
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
            fontSize: "var(--fs-body-s)",
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
            fontSize: "var(--fs-body-s)",
            letterSpacing: "0.1em",
            fontWeight: 600,
            border: "none",
            background: !isLong ? "var(--magenta-glow)" : "transparent",
            color: !isLong ? "var(--magenta)" : "var(--muted)",
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
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)", color: "var(--muted)", marginTop: 2 }}>
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
            fontSize: "var(--fs-label)",
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
                  fontSize: "var(--fs-micro)",
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
                  fontSize: "var(--fs-micro)",
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
            fontSize: "var(--fs-label)",
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
            fontSize: "var(--fs-label)",
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

      {/* The deal — max loss + lifetime. This is the product's core promise. */}
      {usdcRaw > 0n && !overCap && !isMarketClosed && (
        <div
          style={{
            border: "1px solid rgba(0,229,255,0.15)",
            background: "rgba(0,229,255,0.03)",
            padding: "10px 12px",
            fontFamily: "var(--font-mono)",
            fontSize: "0.72rem",
            color: "var(--body)",
            letterSpacing: "0.04em",
            lineHeight: 1.8,
          }}
        >
          <div>
            MAX LOSS{" "}
            <span style={{ color: "var(--cyan)", fontWeight: 600 }}>{formatUsdc(feePulled)}</span>
            <span style={{ color: "var(--muted)" }}>
              {" "}— your fee{baseFeeRaw < MIN_POSITION_FEE ? " (min $0.05 + impact)" : ` (5% base${hasImpactFee ? " + impact" : ""})`}. No margin, no liquidation.
            </span>
          </div>
          <div>
            LIVES{" "}
            <span style={{ color: "var(--cyan)", fontWeight: 600 }}>{formatDuration(positionDuration)}</span>
            <span style={{ color: "var(--muted)" }}> — then extend it (dynamic fee) or it settles at market.</span>
          </div>
        </div>
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
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-label)", color: "var(--muted)", letterSpacing: "0.1em" }}>
              {isLong ? `EST. ${tokenSymbol} LOCKED` : "EST. USDC LOCKED"}
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: isLong ? "var(--green)" : "var(--magenta)" }}>
              {formatToken(previewOut, isLong ? tokenDecimals : 6)} {isLong ? tokenSymbol : "USDC"}
            </span>
          </div>
          <div className="flex justify-between">
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-label)", color: "var(--muted)", letterSpacing: "0.1em" }}>
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
              args: [poolAddress, quotedFeeMax!],
              chainId,
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
          variant={isLong ? "green" : "magenta"}
          onClick={() => {
            if (useRouter) {
              writeOpen({
                address: routerAddress!,
                abi: exnihiloRouterAbi,
                functionName: isLong ? "openLong" : "openShort",
                args: [poolAddress, usdcRaw, minOut],
                chainId,
              });
            } else if (isLong) {
              writeOpen({
                address: poolAddress,
                abi: exnihiloPoolAbi,
                functionName: "openLong",
                args: [usdcRaw, minOut, address!],
                chainId,
              });
            } else {
              writeOpen({
                address: poolAddress,
                abi: exnihiloPoolAbi,
                functionName: "openShort",
                args: [usdcRaw, minOut, address!],
                chainId,
              });
            }
          }}
          disabled={usdcRaw === 0n || minOut === 0n || overCap || isMarketClosed}
          style={{ width: "100%", justifyContent: "center" }}
        />
      )}

    </div>
  );
}
