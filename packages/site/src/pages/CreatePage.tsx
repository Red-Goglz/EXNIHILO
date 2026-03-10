import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount, useChainId, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { decodeEventLog, isAddress } from "viem";
import { exnihiloFactoryAbi, erc20Abi } from "@exnihilio/abis";
import { getAddresses, HARDHAT_CHAIN_ID } from "../contracts/addresses.ts";
import { parseUnits, formatUsdc } from "../lib/format.ts";
import TokenInput from "../components/shared/TokenInput.tsx";
import TxButton from "../components/shared/TxButton.tsx";
import ChainGuard from "../components/wallet/ChainGuard.tsx";

export default function CreatePage() {
  return (
    <ChainGuard>
      <CreateContent />
    </ChainGuard>
  );
}

function CreateContent() {
  const { address } = useAccount();
  const chainId = useChainId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const addrs = getAddresses(chainId);

  const [tokenAddress, setTokenAddress] = useState("");
  const [seedUsdc, setSeedUsdc] = useState("");
  const [seedToken, setSeedToken] = useState("");
  const [maxPositionUsd, setMaxPositionUsd] = useState("");
  const [maxPositionBps, setMaxPositionBps] = useState("");

  const tokenAddr = (isAddress(tokenAddress) ? tokenAddress : undefined) as
    | `0x${string}`
    | undefined;

  const { data: tokenMeta } = useReadContracts({
    contracts: tokenAddr
      ? [
          { address: tokenAddr, abi: erc20Abi, functionName: "symbol" },
          { address: tokenAddr, abi: erc20Abi, functionName: "decimals" },
        ]
      : [],
    query: { enabled: !!tokenAddr },
  });

  const tokenSymbol = (tokenMeta?.[0]?.result as string | undefined) ?? "???";
  const tokenDecimals = (tokenMeta?.[1]?.result as number | undefined) ?? 18;

  const seedUsdcRaw = parseUnits(seedUsdc, 6);
  const seedTokenRaw = parseUnits(seedToken, tokenDecimals);
  const maxPosUsdRaw = parseUnits(maxPositionUsd || "0", 6);
  const maxPosBpsRaw = BigInt(maxPositionBps || "0");

  const factoryAddr = addrs.factory;

  const { data: allowances, refetch: refetchAllowances } = useReadContracts({
    contracts:
      address && tokenAddr
        ? [
            {
              address: addrs.usdc,
              abi: erc20Abi,
              functionName: "allowance",
              args: [address, factoryAddr],
            },
            {
              address: tokenAddr,
              abi: erc20Abi,
              functionName: "allowance",
              args: [address, factoryAddr],
            },
          ]
        : [],
    query: { enabled: !!address && !!tokenAddr },
  });

  const usdcAllowance = allowances?.[0]?.result as bigint | undefined;
  const tokenAllowance = allowances?.[1]?.result as bigint | undefined;
  const allowancesLoaded = usdcAllowance !== undefined && tokenAllowance !== undefined;

  const needsUsdcApproval = allowancesLoaded && seedUsdcRaw > usdcAllowance!;
  const needsTokenApproval = allowancesLoaded && seedTokenRaw > tokenAllowance!;

  const { writeContract: writeUsdcApprove, data: usdcApproveHash, isPending: usdcApprovePending } = useWriteContract();
  const { isLoading: usdcApproveConfirming, isSuccess: usdcApproveSuccess } =
    useWaitForTransactionReceipt({ hash: usdcApproveHash });

  const { writeContract: writeTokenApprove, data: tokenApproveHash, isPending: tokenApprovePending } = useWriteContract();
  const { isLoading: tokenApproveConfirming, isSuccess: tokenApproveSuccess } =
    useWaitForTransactionReceipt({ hash: tokenApproveHash });

  useEffect(() => {
    if (usdcApproveSuccess) refetchAllowances();
  }, [usdcApproveSuccess]);

  useEffect(() => {
    if (tokenApproveSuccess) refetchAllowances();
  }, [tokenApproveSuccess]);

  const {
    writeContract: writeCreate,
    data: createHash,
    isPending: createPending,
  } = useWriteContract();
  const {
    isLoading: createConfirming,
    isSuccess: createSuccess,
    data: createReceipt,
  } = useWaitForTransactionReceipt({ hash: createHash });

  useEffect(() => {
    if (!createSuccess || !createReceipt) return;
    for (const log of createReceipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: exnihiloFactoryAbi,
          data: log.data,
          topics: log.topics,
          eventName: "MarketCreated",
        });
        if (decoded.args.pool) {
          queryClient.invalidateQueries();
          navigate(`/app/markets/${decoded.args.pool}`);
          break;
        }
      } catch {
        // Not the MarketCreated log
      }
    }
  }, [createSuccess, createReceipt]);

  const usdcApproveStatus = usdcApprovePending
    ? "pending"
    : usdcApproveConfirming
    ? "confirming"
    : usdcApproveSuccess
    ? "success"
    : "idle";

  const tokenApproveStatus = tokenApprovePending
    ? "pending"
    : tokenApproveConfirming
    ? "confirming"
    : tokenApproveSuccess
    ? "success"
    : "idle";

  const createStatus = createPending
    ? "pending"
    : createConfirming
    ? "confirming"
    : createSuccess
    ? "success"
    : "idle";

  const isValid = tokenAddr !== undefined && seedUsdcRaw > 0n && seedTokenRaw > 0n;

  const impliedPrice =
    seedUsdcRaw > 0n && seedTokenRaw > 0n
      ? formatUsdc((seedUsdcRaw * 10n ** BigInt(tokenDecimals)) / seedTokenRaw)
      : null;

  const showUsdcApprove = isValid && allowancesLoaded && needsUsdcApproval;
  const showTokenApprove =
    isValid && allowancesLoaded && !needsUsdcApproval && needsTokenApproval;
  const showCreate =
    isValid && allowancesLoaded && !needsUsdcApproval && !needsTokenApproval;
  const showFillIn = !isValid;
  const showLoadingApproval = isValid && !allowancesLoaded;

  const testTokenAddr =
    chainId === HARDHAT_CHAIN_ID
      ? (addrs as Record<string, string>).testToken ?? null
      : null;

  return (
    <div style={{ maxWidth: 520 }}>
      {/* Header */}
      <h1
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "2rem",
          color: "#fff",
          letterSpacing: "0.05em",
          lineHeight: 1,
          marginBottom: 6,
        }}
      >
        CREATE MARKET
      </h1>
      <p
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.65rem",
          color: "var(--muted)",
          letterSpacing: "0.06em",
          marginBottom: 24,
        }}
      >
        Launch a permissionless token/USDC trading pool. You set the initial
        price ratio with seed liquidity.
      </p>

      {/* Dev hint banner */}
      {testTokenAddr && (
        <div
          style={{
            background: "rgba(255,59,48,0.06)",
            border: "1px solid rgba(255,59,48,0.25)",
            padding: "12px 16px",
            marginBottom: 20,
            fontFamily: "var(--font-mono)",
          }}
        >
          <p
            style={{
              fontSize: "0.58rem",
              letterSpacing: "0.15em",
              color: "var(--red)",
              marginBottom: 6,
            }}
          >
            ◉ LOCAL DEV — TEST TOKEN (PEPE)
          </p>
          <p
            style={{
              fontSize: "0.68rem",
              color: "var(--body)",
              wordBreak: "break-all",
              marginBottom: 8,
            }}
          >
            {testTokenAddr}
          </p>
          <button
            onClick={() => setTokenAddress(testTokenAddr)}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.6rem",
              letterSpacing: "0.1em",
              color: "var(--cyan)",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
              textDecoration: "underline",
            }}
          >
            USE THIS ADDRESS ↑
          </button>
        </div>
      )}

      {/* Form panel */}
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          padding: "24px",
          position: "relative",
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        {/* Corner decorations */}
        <span
          style={{
            position: "absolute",
            top: -1,
            left: -1,
            width: 10,
            height: 10,
            borderTop: "1px solid var(--cyan)",
            borderLeft: "1px solid var(--cyan)",
            pointerEvents: "none",
          }}
        />
        <span
          style={{
            position: "absolute",
            bottom: -1,
            right: -1,
            width: 10,
            height: 10,
            borderBottom: "1px solid var(--cyan)",
            borderRight: "1px solid var(--cyan)",
            pointerEvents: "none",
          }}
        />

        {/* Token address */}
        <div className="flex flex-col gap-2">
          <label
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.6rem",
              letterSpacing: "0.15em",
              color: "var(--muted)",
              textTransform: "uppercase",
            }}
          >
            Token Address
          </label>
          <input
            type="text"
            value={tokenAddress}
            onChange={(e) => setTokenAddress(e.target.value)}
            placeholder="0x…"
            className="input-terminal"
            style={{ letterSpacing: "0.05em" }}
          />
          {tokenAddr && tokenSymbol !== "???" && (
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.65rem",
                color: "var(--green)",
                letterSpacing: "0.05em",
              }}
            >
              ✓ {tokenSymbol} ({tokenDecimals} decimals)
            </p>
          )}
          {tokenAddress && !tokenAddr && (
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.65rem",
                color: "var(--red)",
                letterSpacing: "0.05em",
              }}
            >
              ✗ Invalid address
            </p>
          )}
        </div>

        {/* Seed USDC */}
        <TokenInput
          label="Seed USDC"
          value={seedUsdc}
          onChange={setSeedUsdc}
          tokenAddress={addrs.usdc}
          decimals={6}
          symbol="USDC"
        />

        {/* Seed Token */}
        <TokenInput
          label={`Seed ${tokenSymbol}`}
          value={seedToken}
          onChange={setSeedToken}
          tokenAddress={tokenAddr}
          decimals={tokenDecimals}
          symbol={tokenSymbol}
        />

        {/* Implied price */}
        {impliedPrice && (
          <div
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              padding: "12px 16px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.62rem",
                letterSpacing: "0.1em",
                color: "var(--muted)",
              }}
            >
              INITIAL PRICE
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.82rem",
                color: "var(--cyan)",
                fontWeight: 600,
              }}
            >
              ${impliedPrice}{" "}
              <span
                style={{ color: "var(--muted)", fontSize: "0.65rem" }}
              >
                per {tokenSymbol}
              </span>
            </span>
          </div>
        )}

        {/* Advanced position caps */}
        <details style={{ fontFamily: "var(--font-mono)" }}>
          <summary
            style={{
              fontSize: "0.62rem",
              letterSpacing: "0.1em",
              color: "var(--muted)",
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            ▸ ADVANCED: POSITION CAPS (optional)
          </summary>
          <div
            className="flex flex-col gap-3"
            style={{ marginTop: 12 }}
          >
            <div className="flex flex-col gap-1">
              <label
                style={{
                  fontSize: "0.6rem",
                  letterSpacing: "0.12em",
                  color: "var(--muted)",
                  textTransform: "uppercase",
                }}
              >
                Max Position USDC (0 = disabled)
              </label>
              <input
                type="text"
                value={maxPositionUsd}
                onChange={(e) => setMaxPositionUsd(e.target.value)}
                placeholder="0"
                className="input-terminal"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label
                style={{
                  fontSize: "0.6rem",
                  letterSpacing: "0.12em",
                  color: "var(--muted)",
                  textTransform: "uppercase",
                }}
              >
                Max Position BPS (10–9900, 0 = disabled)
              </label>
              <input
                type="text"
                value={maxPositionBps}
                onChange={(e) => setMaxPositionBps(e.target.value)}
                placeholder="0"
                className="input-terminal"
              />
            </div>
          </div>
        </details>

        {/* Action buttons */}
        {showFillIn && (
          <button
            disabled
            className="btn-terminal"
            style={{ width: "100%", justifyContent: "center" }}
          >
            FILL IN ALL FIELDS
          </button>
        )}

        {showLoadingApproval && (
          <button
            disabled
            className="btn-terminal"
            style={{ width: "100%", justifyContent: "center" }}
          >
            <span className="spinner">⟳</span> CHECKING ALLOWANCES
            <span className="cursor-blink">_</span>
          </button>
        )}

        {showUsdcApprove && (
          <TxButton
            idleLabel="Approve USDC"
            status={usdcApproveStatus}
            onClick={() =>
              writeUsdcApprove({
                address: addrs.usdc,
                abi: erc20Abi,
                functionName: "approve",
                args: [factoryAddr, seedUsdcRaw],
              })
            }
            style={{ width: "100%", justifyContent: "center" }}
          />
        )}

        {showTokenApprove && (
          <TxButton
            idleLabel={`Approve ${tokenSymbol}`}
            status={tokenApproveStatus}
            onClick={() =>
              writeTokenApprove({
                address: tokenAddr!,
                abi: erc20Abi,
                functionName: "approve",
                args: [factoryAddr, seedTokenRaw],
              })
            }
            style={{ width: "100%", justifyContent: "center" }}
          />
        )}

        {showCreate && (
          <TxButton
            idleLabel="Create Market"
            status={createStatus}
            variant="cyan"
            onClick={() =>
              writeCreate({
                address: factoryAddr,
                abi: exnihiloFactoryAbi,
                functionName: "createMarket",
                args: [tokenAddr!, seedUsdcRaw, seedTokenRaw, maxPosUsdRaw, maxPosBpsRaw],
              })
            }
            style={{ width: "100%", justifyContent: "center" }}
          />
        )}
      </div>
    </div>
  );
}
