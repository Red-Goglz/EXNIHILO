import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount, useReadContracts } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { useFormo } from "@formo/analytics";
import { decodeEventLog, isAddress } from "viem";
import { exnihiloFactoryAbi, erc20Abi } from "@exnihilio/abis";
import { HARDHAT_CHAIN_ID } from "../contracts/addresses.ts";
import { useAppChain } from "../hooks/useAppChain.ts";
import { parseUnits, formatUsdc } from "../lib/format.ts";
import { useTx } from "../hooks/useTx.ts";
import TokenInput from "../components/shared/TokenInput.tsx";
import TxButton from "../components/shared/TxButton.tsx";
import { useSeo } from "../lib/seo.ts";

export default function CreatePage() {
  const { slug } = useAppChain();
  useSeo({
    title: "Create a market",
    description:
      "Deploy a permissionless EXNIHILO market for any ERC-20 token on Avalanche. No governance vote, no listing process, no gatekeeping — the factory is immutable.",
    path: `/app/${slug}/create`,
  });

  return <CreateContent />;
}

function CreateContent() {
  const { address, isConnected } = useAccount();
  const { chainId, addresses: addrs, path } = useAppChain();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const analytics = useFormo();

  const [tokenAddress, setTokenAddress] = useState("");
  const [seedUsdc, setSeedUsdc] = useState("");
  const [seedToken, setSeedToken] = useState("");
  const [maxPositionUsd, setMaxPositionUsd] = useState("");
  // Default position cap: 1% of pool reserves — protects a fresh LP from
  // single whale positions. Creator can raise/clear it here or later on-chain.
  const [maxPositionBps, setMaxPositionBps] = useState("100");
  const [positionDurationDays, setPositionDurationDays] = useState("");

  const tokenAddr = (isAddress(tokenAddress) ? tokenAddress : undefined) as
    | `0x${string}`
    | undefined;

  const { data: tokenMeta } = useReadContracts({
    contracts: tokenAddr
      ? [
          { address: tokenAddr, abi: erc20Abi, functionName: "symbol", chainId },
          { address: tokenAddr, abi: erc20Abi, functionName: "decimals", chainId },
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
  const positionDurationRaw = BigInt(Math.floor(parseFloat(positionDurationDays || "0") * 86400));

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
              chainId,
            },
            {
              address: tokenAddr,
              abi: erc20Abi,
              functionName: "allowance",
              args: [address, factoryAddr],
              chainId,
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

  const {
    writeContract: writeUsdcApprove,
    status: usdcApproveStatus,
    isSuccess: usdcApproveSuccess,
  } = useTx("USDC APPROVAL");

  const {
    writeContract: writeTokenApprove,
    status: tokenApproveStatus,
    isSuccess: tokenApproveSuccess,
  } = useTx("TOKEN APPROVAL");

  useEffect(() => {
    if (usdcApproveSuccess) refetchAllowances();
  }, [usdcApproveSuccess]);

  useEffect(() => {
    if (tokenApproveSuccess) refetchAllowances();
  }, [tokenApproveSuccess]);

  const {
    writeContract: writeCreate,
    status: createStatus,
    isSuccess: createSuccess,
    receipt: createReceipt,
  } = useTx("MARKET CREATION");

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
          analytics?.track("Market Created", {
            pool: decoded.args.pool,
            tokenAddress,
            tokenSymbol,
            seedUsdc: seedUsdcRaw.toString(),
          });
          navigate(path(`markets/${decoded.args.pool}`));
          break;
        }
      } catch {
        // Not the MarketCreated log
      }
    }
  }, [createSuccess, createReceipt]); // eslint-disable-line react-hooks/exhaustive-deps

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
          fontSize: "var(--fs-body-s)",
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
              fontSize: "var(--fs-micro)",
              letterSpacing: "0.15em",
              color: "var(--red)",
              marginBottom: 6,
            }}
          >
            ◉ LOCAL DEV — TEST TOKEN (PEPE)
          </p>
          <p
            style={{
              fontSize: "var(--fs-body-s)",
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
              fontSize: "var(--fs-label)",
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
              fontSize: "var(--fs-label)",
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
                fontSize: "var(--fs-body-s)",
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
                fontSize: "var(--fs-body-s)",
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
                fontSize: "var(--fs-label)",
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
                style={{ color: "var(--muted)", fontSize: "var(--fs-body-s)" }}
              >
                per {tokenSymbol}
              </span>
            </span>
          </div>
        )}

        {/* Market parameters — always visible: these shape the market's risk profile */}
        <div style={{ fontFamily: "var(--font-mono)" }}>
          <div
            style={{
              fontSize: "var(--fs-label)",
              letterSpacing: "0.1em",
              color: "var(--cyan)",
              marginBottom: 4,
            }}
          >
            MARKET PARAMETERS
          </div>
          <p
            style={{
              fontSize: "var(--fs-micro)",
              color: "var(--muted)",
              letterSpacing: "0.04em",
              lineHeight: 1.6,
              marginBottom: 12,
            }}
          >
            These protect your liquidity and define the trading rhythm. Caps can
            be changed later by the LP NFT holder; the duration is permanent.
          </p>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label
                style={{
                  fontSize: "var(--fs-label)",
                  letterSpacing: "0.12em",
                  color: "var(--muted)",
                  textTransform: "uppercase",
                }}
              >
                Max Position — % of pool
              </label>
              <input
                type="text"
                value={maxPositionBps}
                onChange={(e) => setMaxPositionBps(e.target.value)}
                placeholder="100"
                className="input-terminal"
              />
              <p style={{ fontSize: "var(--fs-nano)", color: "var(--dim)", letterSpacing: "0.04em", lineHeight: 1.6 }}>
                In basis points of the pool's USDC reserves: 100 = each position
                capped at 1% of the pool. Allowed range 10–9900 (0.1%–99%);
                0 disables the cap. Default 100 keeps any single trader from
                dominating your liquidity.
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <label
                style={{
                  fontSize: "var(--fs-label)",
                  letterSpacing: "0.12em",
                  color: "var(--muted)",
                  textTransform: "uppercase",
                }}
              >
                Max Position — absolute USDC
              </label>
              <input
                type="text"
                value={maxPositionUsd}
                onChange={(e) => setMaxPositionUsd(e.target.value)}
                placeholder="0"
                className="input-terminal"
              />
              <p style={{ fontSize: "var(--fs-nano)", color: "var(--dim)", letterSpacing: "0.04em", lineHeight: 1.6 }}>
                Hard dollar ceiling per position, applied on top of the % cap
                (the stricter one wins). 0 = no absolute cap.
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <label
                style={{
                  fontSize: "var(--fs-label)",
                  letterSpacing: "0.12em",
                  color: "var(--muted)",
                  textTransform: "uppercase",
                }}
              >
                Position duration (days)
              </label>
              <input
                type="text"
                value={positionDurationDays}
                onChange={(e) => setPositionDurationDays(e.target.value)}
                placeholder="7"
                className="input-terminal"
              />
              <p style={{ fontSize: "var(--fs-nano)", color: "var(--dim)", letterSpacing: "0.04em", lineHeight: 1.6 }}>
                How long each position period lasts before it must be extended
                (paying the fee again) or it settles. Shorter = more frequent
                fee income for you as LP; longer = more convenient for traders.
                Range 1 hour – 365 days; 0 = default 7 days. Permanent.
              </p>
            </div>
          </div>
        </div>

        {/* Action buttons */}
        {!isConnected && (
          <button
            disabled
            className="btn-terminal"
            style={{ width: "100%", justifyContent: "center" }}
          >
            CONNECT WALLET TO CREATE
          </button>
        )}

        {isConnected && showFillIn && (
          <button
            disabled
            className="btn-terminal"
            style={{ width: "100%", justifyContent: "center" }}
          >
            FILL IN ALL FIELDS
          </button>
        )}

        {isConnected && showLoadingApproval && (
          <button
            disabled
            className="btn-terminal"
            style={{ width: "100%", justifyContent: "center" }}
          >
            <span className="spinner">⟳</span> CHECKING ALLOWANCES
            <span className="cursor-blink">_</span>
          </button>
        )}

        {isConnected && showUsdcApprove && (
          <TxButton
            idleLabel="Approve USDC"
            status={usdcApproveStatus}
            onClick={() =>
              writeUsdcApprove({
                address: addrs.usdc,
                abi: erc20Abi,
                functionName: "approve",
                args: [factoryAddr, seedUsdcRaw],
                chainId,
              })
            }
            style={{ width: "100%", justifyContent: "center" }}
          />
        )}

        {isConnected && showTokenApprove && (
          <TxButton
            idleLabel={`Approve ${tokenSymbol}`}
            status={tokenApproveStatus}
            onClick={() =>
              writeTokenApprove({
                address: tokenAddr!,
                abi: erc20Abi,
                functionName: "approve",
                args: [factoryAddr, seedTokenRaw],
                chainId,
              })
            }
            style={{ width: "100%", justifyContent: "center" }}
          />
        )}

        {isConnected && showCreate && (
          <TxButton
            idleLabel="Create Market"
            status={createStatus}
            variant="cyan"
            onClick={() =>
              writeCreate({
                address: factoryAddr,
                abi: exnihiloFactoryAbi,
                functionName: "createMarket",
                args: [tokenAddr!, seedUsdcRaw, seedTokenRaw, maxPosUsdRaw, maxPosBpsRaw, positionDurationRaw],
                chainId,
              })
            }
            style={{ width: "100%", justifyContent: "center" }}
          />
        )}
      </div>
    </div>
  );
}
