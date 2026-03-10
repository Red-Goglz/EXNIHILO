import { useState } from "react";
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { exnihiloPoolAbi, lpNFTAbi, erc20Abi } from "@exnihilio/abis";
import { parseUnits, formatUsdc, formatToken } from "../../lib/format.ts";
import TokenInput from "../shared/TokenInput.tsx";
import TxButton from "../shared/TxButton.tsx";

interface LpPanelProps {
  poolAddress: `0x${string}`;
  lpNftAddress: `0x${string}`;
  underlyingToken: `0x${string}`;
  underlyingUsdc: `0x${string}`;
  tokenSymbol: string;
  tokenDecimals: number;
}

export default function LpPanel({
  poolAddress,
  lpNftAddress,
  underlyingToken,
  underlyingUsdc,
  tokenSymbol,
  tokenDecimals,
}: LpPanelProps) {
  const { address } = useAccount();
  const queryClient = useQueryClient();

  const [tokenInput, setTokenInput] = useState("");
  const [usdcInput, setUsdcInput] = useState("");
  const [capsUsdInput, setCapsUsdInput] = useState("");
  const [capsBpsInput, setCapsBpsInput] = useState("");

  const poolContract = { address: poolAddress, abi: exnihiloPoolAbi } as const;

  const { data } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "lpNftId" },
      { ...poolContract, functionName: "backedAirToken" },
      { ...poolContract, functionName: "backedAirUsd" },
      { ...poolContract, functionName: "lpFeesAccumulated" },
      { ...poolContract, functionName: "openPositionCount" },
      { ...poolContract, functionName: "maxPositionUsd" },
      { ...poolContract, functionName: "maxPositionBps" },
    ],
  });

  const lpNftId = data?.[0]?.result as bigint | undefined;
  const backedAirToken = data?.[1]?.result as bigint | undefined;
  const backedAirUsd = data?.[2]?.result as bigint | undefined;
  const lpFees = data?.[3]?.result as bigint | undefined;
  const openPositionCount = data?.[4]?.result as bigint | undefined;
  const currentMaxUsd = data?.[5]?.result as bigint | undefined;
  const currentMaxBps = data?.[6]?.result as bigint | undefined;

  const { data: lpOwner } = useReadContracts({
    contracts:
      lpNftId !== undefined
        ? [{ address: lpNftAddress, abi: lpNFTAbi, functionName: "ownerOf", args: [lpNftId] }]
        : [],
    query: { enabled: lpNftId !== undefined },
  });

  const owner = lpOwner?.[0]?.result as `0x${string}` | undefined;
  const isLpHolder = owner?.toLowerCase() === address?.toLowerCase();

  const tokenRaw = parseUnits(tokenInput, tokenDecimals);
  const usdcRaw = parseUnits(usdcInput, 6);

  const { data: allowances } = useReadContracts({
    contracts: address
      ? [
          {
            address: underlyingToken,
            abi: erc20Abi,
            functionName: "allowance",
            args: [address, poolAddress],
          },
          {
            address: underlyingUsdc,
            abi: erc20Abi,
            functionName: "allowance",
            args: [address, poolAddress],
          },
        ]
      : [],
    query: { enabled: !!address },
  });

  const tokenAllowance = allowances?.[0]?.result as bigint | undefined;
  const usdcAllowance = allowances?.[1]?.result as bigint | undefined;
  const needsTokenApproval = tokenAllowance !== undefined && tokenRaw > tokenAllowance;
  const needsUsdcApproval = usdcAllowance !== undefined && usdcRaw > usdcAllowance;

  const hasOpenPositions = openPositionCount !== undefined && openPositionCount > 0n;

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  const { writeContract: writeCaps, data: capsHash, isPending: capsPending } = useWriteContract();
  const { isLoading: capsConfirming, isSuccess: capsSuccess } = useWaitForTransactionReceipt({ hash: capsHash });

  const txStatus = isPending
    ? "pending"
    : isConfirming
    ? "confirming"
    : isSuccess
    ? "success"
    : "idle";

  const capsStatus = capsPending ? "pending" : capsConfirming ? "confirming" : capsSuccess ? "success" : "idle";

  // Parse cap inputs: usd is raw USDC (6 dec), bps is integer
  const newCapsUsd = (() => {
    const n = parseFloat(capsUsdInput);
    if (!capsUsdInput || isNaN(n) || n < 0) return 0n;
    return BigInt(Math.round(n * 1_000_000));
  })();
  const newCapsBps = (() => {
    const n = parseInt(capsBpsInput, 10);
    if (!capsBpsInput || isNaN(n) || n < 0) return 0n;
    return BigInt(n);
  })();

  const capsChanged =
    (currentMaxUsd !== undefined && newCapsUsd !== currentMaxUsd) ||
    (currentMaxBps !== undefined && newCapsBps !== currentMaxBps);

  const capsValid =
    (newCapsBps === 0n || (newCapsBps >= 10n && newCapsBps <= 9900n));

  const handleSuccess = () => {
    queryClient.invalidateQueries();
    setTokenInput("");
    setUsdcInput("");
  };

  if (!isLpHolder) {
    return (
      <div
        style={{
          padding: "32px 0",
          textAlign: "center",
          fontFamily: "var(--font-mono)",
          fontSize: "0.65rem",
          color: "var(--muted)",
          letterSpacing: "0.1em",
        }}
      >
        — LP NFT NOT IN THIS WALLET —
        <br />
        <span style={{ fontSize: "0.6rem", color: "var(--dim)" }}>
          Only the LP NFT holder can manage liquidity
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Pool stats */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <div style={{ background: "var(--surface-2)", border: "1px solid var(--border)", padding: "10px 12px" }}>
          <div className="stat-label">BACKED TOKEN</div>
          <div style={{ fontSize: "0.75rem", color: "var(--body)" }}>
            {backedAirToken !== undefined ? formatToken(backedAirToken, tokenDecimals) : "—"}
            <span style={{ color: "var(--muted)", marginLeft: 4, fontSize: "0.65rem" }}>
              {tokenSymbol}
            </span>
          </div>
        </div>
        <div style={{ background: "var(--surface-2)", border: "1px solid var(--border)", padding: "10px 12px" }}>
          <div className="stat-label">BACKED USDC</div>
          <div style={{ fontSize: "0.75rem", color: "var(--body)" }}>
            ${backedAirUsd !== undefined ? formatUsdc(backedAirUsd) : "—"}
          </div>
        </div>
        <div style={{ background: "var(--surface-2)", border: "1px solid var(--border)", padding: "10px 12px" }}>
          <div className="stat-label">LP FEES</div>
          <div style={{ fontSize: "0.75rem", color: "var(--green)", fontWeight: 600 }}>
            ${lpFees !== undefined ? formatUsdc(lpFees) : "—"}
          </div>
        </div>
      </div>

      {/* Open positions warning */}
      {hasOpenPositions && (
        <div
          style={{
            background: "rgba(255,59,48,0.06)",
            border: "1px solid rgba(255,59,48,0.25)",
            padding: "10px 14px",
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            color: "var(--red)",
            letterSpacing: "0.06em",
          }}
        >
          ◉ {openPositionCount?.toString()} open position(s) — cannot remove liquidity
        </div>
      )}

      {/* Add Liquidity section */}
      <div
        style={{
          border: "1px solid var(--border)",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.6rem",
            letterSpacing: "0.18em",
            color: "var(--muted)",
          }}
        >
          ADD LIQUIDITY
        </div>
        <TokenInput
          label={tokenSymbol}
          value={tokenInput}
          onChange={setTokenInput}
          tokenAddress={underlyingToken}
          decimals={tokenDecimals}
          symbol={tokenSymbol}
        />
        <TokenInput
          label="USDC"
          value={usdcInput}
          onChange={setUsdcInput}
          tokenAddress={underlyingUsdc}
          decimals={6}
          symbol="USDC"
        />

        {(needsTokenApproval || needsUsdcApproval) && (
          <TxButton
            idleLabel={`Approve ${needsTokenApproval ? tokenSymbol : "USDC"}`}
            status={txStatus}
            onClick={() => {
              if (needsTokenApproval) {
                writeContract({
                  address: underlyingToken,
                  abi: erc20Abi,
                  functionName: "approve",
                  args: [poolAddress, tokenRaw],
                });
              } else {
                writeContract({
                  address: underlyingUsdc,
                  abi: erc20Abi,
                  functionName: "approve",
                  args: [poolAddress, usdcRaw],
                });
              }
            }}
            disabled={tokenRaw === 0n || usdcRaw === 0n}
            style={{ width: "100%", justifyContent: "center" }}
          />
        )}

        {!needsTokenApproval && !needsUsdcApproval && (
          <TxButton
            idleLabel="Add Liquidity"
            status={txStatus}
            variant="green"
            onClick={() =>
              writeContract(
                {
                  address: poolAddress,
                  abi: exnihiloPoolAbi,
                  functionName: "addLiquidity",
                  args: [tokenRaw, usdcRaw],
                },
                { onSuccess: handleSuccess }
              )
            }
            disabled={tokenRaw === 0n || usdcRaw === 0n}
            style={{ width: "100%", justifyContent: "center" }}
          />
        )}
      </div>

      {/* Remove Liquidity section */}
      <div
        style={{
          border: "1px solid var(--border)",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.6rem",
            letterSpacing: "0.18em",
            color: "var(--muted)",
          }}
        >
          REMOVE LIQUIDITY
        </div>
        <TokenInput
          label={tokenSymbol}
          value={tokenInput}
          onChange={setTokenInput}
          decimals={tokenDecimals}
          symbol={tokenSymbol}
        />
        <TokenInput
          label="USDC"
          value={usdcInput}
          onChange={setUsdcInput}
          decimals={6}
          symbol="USDC"
        />
        <TxButton
          idleLabel="Remove Liquidity"
          status={txStatus}
          variant="red"
          onClick={() =>
            writeContract(
              {
                address: poolAddress,
                abi: exnihiloPoolAbi,
                functionName: "removeLiquidity",
              },
              { onSuccess: handleSuccess }
            )
          }
          disabled={hasOpenPositions}
          style={{ width: "100%", justifyContent: "center" }}
        />
      </div>

      {/* Claim fees */}
      <TxButton
        idleLabel={`Claim Fees${lpFees ? ` ($${formatUsdc(lpFees)})` : ""}`}
        status={txStatus}
        variant="default"
        onClick={() =>
          writeContract(
            {
              address: poolAddress,
              abi: exnihiloPoolAbi,
              functionName: "claimFees",
            },
            { onSuccess: handleSuccess }
          )
        }
        disabled={!lpFees || lpFees === 0n}
        style={{ width: "100%", justifyContent: "center" }}
      />

      {/* Position caps */}
      <div
        style={{
          border: "1px solid var(--border)",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.6rem",
            letterSpacing: "0.18em",
            color: "var(--muted)",
          }}
        >
          POSITION CAPS
        </div>

        {/* Current values row */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div style={{ background: "var(--surface-2)", border: "1px solid var(--border)", padding: "8px 10px" }}>
            <div className="stat-label">CURRENT USD CAP</div>
            <div style={{ fontSize: "0.75rem", color: "var(--body)" }}>
              {currentMaxUsd === undefined
                ? "—"
                : currentMaxUsd === 0n
                ? <span style={{ color: "var(--muted)" }}>UNLIMITED</span>
                : `$${formatUsdc(currentMaxUsd)}`}
            </div>
          </div>
          <div style={{ background: "var(--surface-2)", border: "1px solid var(--border)", padding: "8px 10px" }}>
            <div className="stat-label">CURRENT BPS CAP</div>
            <div style={{ fontSize: "0.75rem", color: "var(--body)" }}>
              {currentMaxBps === undefined
                ? "—"
                : currentMaxBps === 0n
                ? <span style={{ color: "var(--muted)" }}>UNLIMITED</span>
                : `${currentMaxBps.toString()} bps (${(Number(currentMaxBps) / 100).toFixed(2)}%)`}
            </div>
          </div>
        </div>

        {/* Inputs */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", letterSpacing: "0.1em", color: "var(--muted)", minWidth: 80 }}>
              USD CAP
            </span>
            <input
              className="input-terminal"
              type="number"
              min="0"
              step="1"
              placeholder={currentMaxUsd !== undefined && currentMaxUsd > 0n ? formatUsdc(currentMaxUsd) : "0 = unlimited"}
              value={capsUsdInput}
              onChange={(e) => setCapsUsdInput(e.target.value)}
              style={{ flex: 1, padding: "6px 8px", fontSize: "0.75rem" }}
            />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--muted)" }}>USDC</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", letterSpacing: "0.1em", color: "var(--muted)", minWidth: 80 }}>
              BPS CAP
            </span>
            <input
              className="input-terminal"
              type="number"
              min="0"
              max="9900"
              step="10"
              placeholder={currentMaxBps !== undefined && currentMaxBps > 0n ? currentMaxBps.toString() : "0 = unlimited"}
              value={capsBpsInput}
              onChange={(e) => setCapsBpsInput(e.target.value)}
              style={{ flex: 1, padding: "6px 8px", fontSize: "0.75rem" }}
            />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--muted)" }}>
              bps {newCapsBps > 0n ? `(${(Number(newCapsBps) / 100).toFixed(2)}%)` : ""}
            </span>
          </div>
          {!capsValid && (
            <p style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--red)", letterSpacing: "0.05em" }}>
              BPS must be 10–9900 or 0 to disable
            </p>
          )}
        </div>

        <TxButton
          idleLabel="Set Position Caps"
          status={capsStatus}
          variant="default"
          onClick={() =>
            writeCaps(
              {
                address: poolAddress,
                abi: exnihiloPoolAbi,
                functionName: "setPositionCaps",
                args: [newCapsUsd, newCapsBps],
              },
              {
                onSuccess: () => {
                  queryClient.invalidateQueries();
                  setCapsUsdInput("");
                  setCapsBpsInput("");
                },
              }
            )
          }
          disabled={!capsChanged || !capsValid}
          style={{ width: "100%", justifyContent: "center" }}
        />
      </div>

    </div>
  );
}
