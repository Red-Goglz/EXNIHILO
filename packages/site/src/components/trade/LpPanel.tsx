import { useState, useEffect } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { useFormo } from "@formo/analytics";
import { exnihiloPoolAbi, lpNFTAbi, erc20Abi } from "@exnihilio/abis";
import { parseUnits, formatUsdc, formatToken } from "../../lib/format.ts";
import { useTx } from "../../hooks/useTx.ts";
import { useAppChain } from "../../hooks/useAppChain.ts";
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
  const { chainId } = useAppChain();
  const queryClient = useQueryClient();
  const analytics = useFormo();

  const [tokenInput, setTokenInput] = useState("");
  const [usdcInput, setUsdcInput] = useState("");
  const [capsUsdInput, setCapsUsdInput] = useState("");
  const [capsBpsInput, setCapsBpsInput] = useState("");
  const [claimAddrInput, setClaimAddrInput] = useState("");

  const poolContract = { address: poolAddress, abi: exnihiloPoolAbi, chainId } as const;

  const { data } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "lpNftId" },
      { ...poolContract, functionName: "backedAirToken" },
      { ...poolContract, functionName: "backedAirUsd" },
      { ...poolContract, functionName: "lpFeesAccumulated" },
      { ...poolContract, functionName: "openPositionCount" },
      { ...poolContract, functionName: "maxPositionUsd" },
      { ...poolContract, functionName: "maxPositionBps" },
      { ...poolContract, functionName: "closeDate" },
      { ...poolContract, functionName: "positionDuration" },
      { ...poolContract, functionName: "lpFeesPaidTotal" },
    ],
  });

  const lpNftId = data?.[0]?.result as bigint | undefined;
  const backedAirToken = data?.[1]?.result as bigint | undefined;
  const backedAirUsd = data?.[2]?.result as bigint | undefined;
  const lpFeesClaimable = data?.[3]?.result as bigint | undefined;
  const openPositionCount = data?.[4]?.result as bigint | undefined;
  const currentMaxUsd = data?.[5]?.result as bigint | undefined;
  const currentMaxBps = data?.[6]?.result as bigint | undefined;
  const closeDate = data?.[7]?.result as bigint | undefined;
  const positionDuration = data?.[8]?.result as bigint | undefined;
  const lpFeesPaidTotal = data?.[9]?.result as bigint | undefined;

  const { data: lpOwner } = useReadContracts({
    contracts:
      lpNftId !== undefined
        ? [{ address: lpNftAddress, abi: lpNFTAbi, functionName: "ownerOf", args: [lpNftId], chainId }]
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
            chainId,
          },
          {
            address: underlyingUsdc,
            abi: erc20Abi,
            functionName: "allowance",
            args: [address, poolAddress],
            chainId,
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

  const { writeContract, status: txStatus, isSuccess } = useTx("LP TRANSACTION");

  const {
    writeContract: writeCaps,
    status: capsStatus,
    isSuccess: capsSuccess,
  } = useTx("CAPS UPDATE");

  const {
    writeContract: writeClose,
    status: closeStatus,
    isSuccess: closeSuccess,
  } = useTx("MARKET CLOSE");

  useEffect(() => {
    if (isSuccess || capsSuccess || closeSuccess) queryClient.invalidateQueries();
  }, [isSuccess, capsSuccess, closeSuccess, queryClient]);

  const isPoolClosing = closeDate !== undefined && closeDate > 0n;
  const positionDurationHours = positionDuration !== undefined ? Number(positionDuration) / 3600 : 168;
  const positionDurationDays = Math.round(positionDurationHours / 24);

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
          fontSize: "var(--fs-body-s)",
          color: "var(--muted)",
          letterSpacing: "0.1em",
        }}
      >
        — LP NFT NOT IN THIS WALLET —
        <br />
        <span style={{ fontSize: "var(--fs-label)", color: "var(--dim)" }}>
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
            <span style={{ color: "var(--muted)", marginLeft: 4, fontSize: "var(--fs-body-s)" }}>
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
          <div className="stat-label">FEES CLAIMED</div>
          <div style={{ fontSize: "0.75rem", color: "var(--green)", fontWeight: 600 }}>
            ${lpFeesPaidTotal !== undefined ? formatUsdc(lpFeesPaidTotal) : "—"}
          </div>
          <div style={{ fontSize: "var(--fs-micro)", color: "var(--muted)", fontFamily: "var(--font-mono)", letterSpacing: "0.05em" }}>
            lifetime total
          </div>
        </div>
      </div>

      {/* Open positions / close market info */}
      {hasOpenPositions && (
        <div
          style={{
            background: isPoolClosing ? "rgba(255,140,0,0.06)" : "rgba(255,59,48,0.06)",
            border: `1px solid ${isPoolClosing ? "rgba(255,140,0,0.25)" : "rgba(255,59,48,0.25)"}`,
            padding: "12px 14px",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-label)",
            color: isPoolClosing ? "var(--orange)" : "var(--red)",
            letterSpacing: "0.04em",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div>
            {isPoolClosing
              ? `◉ MARKET CLOSING — ${openPositionCount?.toString()} position(s) must expire before withdrawal`
              : `◉ ${openPositionCount?.toString()} open position(s) — cannot remove liquidity`}
          </div>
          {!isPoolClosing && (
            <div style={{ color: "var(--muted)", fontSize: "var(--fs-micro)", lineHeight: 1.5 }}>
              Close the market to block new positions and prevent renewals.
              All existing positions will expire within {positionDurationDays} day{positionDurationDays !== 1 ? "s" : ""} ({positionDurationHours}h).
              After that you can withdraw all liquidity.
            </div>
          )}
          {isPoolClosing && (
            <div style={{ color: "var(--muted)", fontSize: "var(--fs-micro)" }}>
              Closes {new Date(Number(closeDate!) * 1000).toLocaleString()} — positions cannot be renewed past this date.
            </div>
          )}
          {!isPoolClosing && (
            <TxButton
              idleLabel="Close Market"
              status={closeStatus}
              variant="red"
              onClick={() =>
                writeClose({
                  address: poolAddress,
                  abi: exnihiloPoolAbi,
                  functionName: "closePool",
                  chainId,
                })
              }
              style={{ width: "100%", justifyContent: "center", fontSize: "var(--fs-label)" }}
            />
          )}
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
            fontSize: "var(--fs-label)",
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
                  chainId,
                });
              } else {
                writeContract({
                  address: underlyingUsdc,
                  abi: erc20Abi,
                  functionName: "approve",
                  args: [poolAddress, usdcRaw],
                  chainId,
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
                  chainId,
                },
                { onSuccess: () => {
                  handleSuccess();
                  analytics?.track("Liquidity Added", { pool: poolAddress, tokenSymbol, usdcAmount: usdcRaw.toString() });
                }}
              )
            }
            disabled={tokenRaw === 0n || usdcRaw === 0n}
            style={{ width: "100%", justifyContent: "center" }}
          />
        )}
      </div>

      {/* Remove All Liquidity */}
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
            fontSize: "var(--fs-label)",
            letterSpacing: "0.18em",
            color: "var(--muted)",
          }}
        >
          REMOVE ALL LIQUIDITY
        </div>
        {backedAirToken !== undefined && backedAirUsd !== undefined && (backedAirToken > 0n || backedAirUsd > 0n) && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div style={{ background: "var(--surface-2)", border: "1px solid var(--border)", padding: "8px 10px" }}>
              <div className="stat-label">YOU RECEIVE</div>
              <div style={{ fontSize: "0.75rem", color: "var(--body)" }}>
                {formatToken(backedAirToken, tokenDecimals)} <span style={{ color: "var(--muted)", fontSize: "var(--fs-body-s)" }}>{tokenSymbol}</span>
              </div>
            </div>
            <div style={{ background: "var(--surface-2)", border: "1px solid var(--border)", padding: "8px 10px" }}>
              <div className="stat-label">YOU RECEIVE</div>
              <div style={{ fontSize: "0.75rem", color: "var(--body)" }}>
                ${formatUsdc(backedAirUsd)} <span style={{ color: "var(--muted)", fontSize: "var(--fs-body-s)" }}>USDC</span>
              </div>
            </div>
          </div>
        )}
        <TxButton
          idleLabel="Remove All Liquidity"
          status={txStatus}
          variant="red"
          onClick={() =>
            writeContract(
              {
                address: poolAddress,
                abi: exnihiloPoolAbi,
                functionName: "removeLiquidity",
                chainId,
              },
              { onSuccess: () => {
                handleSuccess();
                analytics?.track("Liquidity Removed", { pool: poolAddress, tokenSymbol });
              }}
            )
          }
          disabled={hasOpenPositions || (backedAirToken === 0n && backedAirUsd === 0n)}
          style={{ width: "100%", justifyContent: "center" }}
        />
      </div>

      {/* Earned fees — fees accrue on every position open/renewal (pull
          payment) and are withdrawn here. */}
      {lpFeesClaimable !== undefined && lpFeesClaimable > 0n && (
        <div
          style={{
            border: "1px solid rgba(0,255,136,0.25)",
            background: "rgba(0,255,136,0.05)",
            padding: "16px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-label)",
              letterSpacing: "0.18em",
              color: "var(--green)",
            }}
          >
            EARNED FEES — READY TO CLAIM
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-label)", color: "var(--muted)", lineHeight: 1.5 }}>
            ${formatUsdc(lpFeesClaimable)} USDC has accrued from position opens
            and renewals. Claim it below — optionally to a different address if
            this wallet cannot receive USDC.
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-label)", letterSpacing: "0.1em", color: "var(--muted)", minWidth: 80 }}>
              SEND TO
            </span>
            <input
              className="input-terminal"
              type="text"
              placeholder={address ?? "0x…"}
              value={claimAddrInput}
              onChange={(e) => setClaimAddrInput(e.target.value.trim())}
              style={{ flex: 1, padding: "6px 8px", fontSize: "0.7rem" }}
            />
          </div>
          {claimAddrInput !== "" && !/^0x[0-9a-fA-F]{40}$/.test(claimAddrInput) && (
            <p style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-label)", color: "var(--red)", letterSpacing: "0.05em" }}>
              Invalid address
            </p>
          )}
          <TxButton
            idleLabel={`Claim $${formatUsdc(lpFeesClaimable)}`}
            status={txStatus}
            variant="default"
            onClick={() => {
              const recipient = (claimAddrInput !== ""
                ? claimAddrInput
                : address) as `0x${string}`;
              writeContract(
                {
                  address: poolAddress,
                  abi: exnihiloPoolAbi,
                  functionName: "claimFees",
                  args: [recipient],
                  chainId,
                },
                { onSuccess: () => {
                  handleSuccess();
                  setClaimAddrInput("");
                  analytics?.track("Fees Claimed", { pool: poolAddress, amount: lpFeesClaimable?.toString(), recipient });
                }}
              );
            }}
            disabled={
              !address ||
              (claimAddrInput !== "" && !/^0x[0-9a-fA-F]{40}$/.test(claimAddrInput))
            }
            style={{ width: "100%", justifyContent: "center" }}
          />
        </div>
      )}

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
            fontSize: "var(--fs-label)",
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
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-label)", letterSpacing: "0.1em", color: "var(--muted)", minWidth: 80 }}>
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
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-body-s)", color: "var(--muted)" }}>USDC</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-label)", letterSpacing: "0.1em", color: "var(--muted)", minWidth: 80 }}>
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
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-body-s)", color: "var(--muted)" }}>
              bps {newCapsBps > 0n ? `(${(Number(newCapsBps) / 100).toFixed(2)}%)` : ""}
            </span>
          </div>
          {!capsValid && (
            <p style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-label)", color: "var(--red)", letterSpacing: "0.05em" }}>
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
                chainId,
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
