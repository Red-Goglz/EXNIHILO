import { useState } from "react";
import { useWriteContract, useWaitForTransactionReceipt, useReadContracts } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { exnihiloPoolAbi, erc20Abi } from "@exnihilio/abis";
import { formatUsdc, formatToken } from "../../lib/format.ts";
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
}

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

export default function PositionCard({
  tokenId,
  position,
}: PositionCardProps) {
  const queryClient = useQueryClient();

  const poolContract = { address: position.pool, abi: exnihiloPoolAbi } as const;

  const { data } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "backedAirToken" },
      { ...poolContract, functionName: "backedAirUsd" },
      { ...poolContract, functionName: "airToken" },
      { ...poolContract, functionName: "airUsdToken" },
    ],
  });

  const backedAirToken   = data?.[0]?.result as bigint | undefined;
  const backedAirUsd    = data?.[1]?.result as bigint | undefined;
  const airTokenAddress  = data?.[2]?.result as `0x${string}` | undefined;
  const airUsdAddress   = data?.[3]?.result as `0x${string}` | undefined;

  const { data: supplyData } = useReadContracts({
    contracts: airTokenAddress && airUsdAddress ? [
      { address: airTokenAddress, abi: erc20Abi, functionName: "totalSupply" as const },
      { address: airUsdAddress,  abi: erc20Abi, functionName: "totalSupply" as const },
    ] : [],
    query: { enabled: !!airTokenAddress && !!airUsdAddress },
  });

  const airTokenTotalSupply = supplyData?.[0]?.result as bigint | undefined;
  const airUsdTotalSupply  = supplyData?.[1]?.result as bigint | undefined;

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  const txStatus = isPending
    ? "pending"
    : isConfirming
    ? "confirming"
    : isSuccess
    ? "success"
    : "idle";

  const handleSuccess = () => queryClient.invalidateQueries();

  // ── PnL & close-eligibility ─────────────────────────────────────────────
  // Uses the exact same formulas as the contract, not the SWAP-1 spot price.
  // PnL displayed is the net amount after the 1% close fee on profit.
  //
  // Close Long  (SWAP-3):
  //   airUsdOut  = lockedAmount * backedAirUsd / airToken.totalSupply()
  //   canClose   = airUsdOut >= airUsdMinted
  //   surplus    = airUsdOut - airUsdMinted
  //   netSurplus = surplus * 99%  (after 1% close fee)
  //
  // Close Short (SWAP-2 inverse / cpAmountIn):
  //   airUsdCost  = airUsd.totalSupply() * airTokenMinted / (backedAirToken - airTokenMinted)
  //   canClose    = airUsdCost <= lockedAmount
  //   surplus     = lockedAmount - airUsdCost
  //   netSurplus  = surplus * 99%  (after 1% close fee)

  const CLOSE_FEE_BPS = 100n; // 1%

  let pnlDisplay = "";
  let pnlPositive = false;
  let canClose = false;

  const poolDataReady =
    backedAirToken !== undefined &&
    backedAirUsd  !== undefined &&
    airTokenTotalSupply !== undefined &&
    airUsdTotalSupply  !== undefined;

  if (poolDataReady) {
    if (position.isLong) {
      if (airTokenTotalSupply > 0n) {
        const airUsdOut = (position.lockedAmount * backedAirUsd!) / airTokenTotalSupply!;
        canClose    = airUsdOut >= position.airUsdMinted;
        pnlPositive = airUsdOut > position.airUsdMinted;
        if (pnlPositive) {
          const surplus    = airUsdOut - position.airUsdMinted;
          const netSurplus = (surplus * (10_000n - CLOSE_FEE_BPS)) / 10_000n;
          pnlDisplay = `+$${formatUsdc(netSurplus)}`;
        } else {
          pnlDisplay = `-$${formatUsdc(position.airUsdMinted - airUsdOut)}`;
        }
      }
    } else {
      // Denominator of cpAmountIn: backedAirToken - airTokenMinted
      // If denominator <= 0 the pool can't satisfy the swap (extremely depleted).
      const denom = backedAirToken! - position.airTokenMinted;
      if (denom > 0n) {
        // Ceiling division matches contract rounding (rounds cost up, conservative).
        const airUsdCost =
          (airUsdTotalSupply! * position.airTokenMinted + denom - 1n) / denom;
        canClose    = airUsdCost <= position.lockedAmount;
        pnlPositive = position.lockedAmount > airUsdCost;
        if (pnlPositive) {
          const surplus    = position.lockedAmount - airUsdCost;
          const netSurplus = (surplus * (10_000n - CLOSE_FEE_BPS)) / 10_000n;
          pnlDisplay = `+$${formatUsdc(netSurplus)}`;
        } else {
          pnlDisplay = `-$${formatUsdc(airUsdCost - position.lockedAmount)}`;
        }
      }
    }
  }

  const openedDate = new Date(Number(position.openedAt) * 1000).toLocaleDateString();

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
          <span style={{ fontSize: "0.68rem", color: "var(--muted)" }}>
            #{tokenId.toString()}
          </span>
        </div>
        <span style={{ fontSize: "0.6rem", color: "var(--muted)", letterSpacing: "0.05em" }}>
          {openedDate}
        </span>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: "var(--border)" }} />

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

        {/* PnL — shown for both long and short once spot price is available */}
        {pnlDisplay && (
          <div>
            <div className="stat-label">EST. P&L</div>
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
        Pool: {position.pool.slice(0, 10)}…{position.pool.slice(-6)}
      </p>

      {/* Actions */}
      <div className="flex gap-2">
        <WithTooltip tip="Close your position and receive USDC back.">
          <TxButton
            idleLabel={position.isLong ? "Close Long" : "Close Short"}
            status={txStatus}
            variant={position.isLong ? "red" : "green"}
            onClick={() => {
              if (position.isLong) {
                writeContract(
                  { address: position.pool, abi: exnihiloPoolAbi, functionName: "closeLong", args: [tokenId, 0n] },
                  { onSuccess: handleSuccess }
                );
              } else {
                writeContract(
                  { address: position.pool, abi: exnihiloPoolAbi, functionName: "closeShort", args: [tokenId, 0n] },
                  { onSuccess: handleSuccess }
                );
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
              if (position.isLong) {
                writeContract(
                  { address: position.pool, abi: exnihiloPoolAbi, functionName: "realizeLong", args: [tokenId] },
                  { onSuccess: handleSuccess }
                );
              } else {
                writeContract(
                  { address: position.pool, abi: exnihiloPoolAbi, functionName: "realizeShort", args: [tokenId] },
                  { onSuccess: handleSuccess }
                );
              }
            }}
            style={{ width: "100%", justifyContent: "center", fontSize: "0.62rem" }}
          />
        </WithTooltip>
      </div>

      {/* Close unavailable hint */}
      {!canClose && poolDataReady && (
        <p style={{ fontSize: "0.58rem", color: "var(--red)", letterSpacing: "0.04em", marginTop: -6 }}>
          ✕ Position is underwater — close unavailable until PnL turns positive
        </p>
      )}
    </div>
  );
}
