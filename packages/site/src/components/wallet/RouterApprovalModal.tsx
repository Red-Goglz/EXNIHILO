import { useState, useEffect } from "react";
import {
  useAccount,
  useChainId,
  useReadContracts,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { erc20Abi } from "@exnihilio/abis";
import { getAddresses } from "../../contracts/addresses.ts";
import { formatUsdc } from "../../lib/format.ts";

const DISMISS_KEY = "exnihilo_router_approval_dismissed";
const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

export default function RouterApprovalModal() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const queryClient = useQueryClient();

  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  let routerAddress: `0x${string}` | undefined;
  let usdcAddress: `0x${string}` | undefined;
  try {
    const addrs = getAddresses(chainId);
    routerAddress = addrs.router;
    usdcAddress = addrs.usdc;
  } catch {
    /* unsupported chain */
  }

  const hasRouter = !!routerAddress && routerAddress !== ZERO;
  const enabled = isConnected && !!address && hasRouter && !!usdcAddress && !dismissed;

  const { data } = useReadContracts({
    contracts: enabled
      ? [
          {
            address: usdcAddress!,
            abi: erc20Abi,
            functionName: "allowance" as const,
            args: [address!, routerAddress!] as const,
          },
          {
            address: usdcAddress!,
            abi: erc20Abi,
            functionName: "balanceOf" as const,
            args: [address!] as const,
          },
        ]
      : [],
    query: { enabled },
  });

  const allowance = data?.[0]?.result as bigint | undefined;
  const balance = data?.[1]?.result as bigint | undefined;

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  useEffect(() => {
    if (isSuccess) {
      queryClient.invalidateQueries();
      setDismissed(true);
      try {
        sessionStorage.setItem(DISMISS_KEY, "1");
      } catch {
        /* ignore */
      }
    }
  }, [isSuccess, queryClient]);

  const shouldShow =
    enabled &&
    allowance !== undefined &&
    allowance === 0n &&
    !dismissed;

  if (!shouldShow) return null;

  const hasBalance = balance !== undefined && balance > 0n;
  const isBusy = isPending || confirming;

  function handleApprove() {
    if (!usdcAddress || !routerAddress || balance === undefined) return;
    writeContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [routerAddress, balance],
    });
  }

  function handleDismiss() {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.82)",
        backdropFilter: "blur(6px)",
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 400,
          margin: "0 24px",
          background: "var(--surface)",
          border: "1px solid var(--cyan)",
          padding: "28px 24px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {/* Corner decorations */}
        <span
          style={{
            position: "absolute",
            top: -1,
            left: -1,
            width: 14,
            height: 14,
            borderTop: "1px solid var(--cyan)",
            borderLeft: "1px solid var(--cyan)",
          }}
        />
        <span
          style={{
            position: "absolute",
            bottom: -1,
            right: -1,
            width: 14,
            height: 14,
            borderBottom: "1px solid var(--cyan)",
            borderRight: "1px solid var(--cyan)",
          }}
        />

        {/* Title */}
        <h2
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "1.4rem",
            color: "#fff",
            letterSpacing: "0.05em",
            margin: 0,
            lineHeight: 1.2,
          }}
        >
          ACTIVATE IMPROVED
          <br />
          TRADING EXPERIENCE
        </h2>

        {/* Description */}
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.62rem",
            color: "var(--muted)",
            letterSpacing: "0.05em",
            lineHeight: 1.6,
            margin: 0,
          }}
        >
          Approve USDC to the EXNIHILO router once. After this, you can open
          long and short positions across all pools without per-trade approvals.
        </p>

        {/* Amount display */}
        {hasBalance && (
          <div
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              padding: "12px 14px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.6rem",
                letterSpacing: "0.1em",
                color: "var(--muted)",
              }}
            >
              APPROVE AMOUNT
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.82rem",
                color: "var(--cyan)",
                fontWeight: 600,
              }}
            >
              {formatUsdc(balance!)} USDC
            </span>
          </div>
        )}

        {!hasBalance && (
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.6rem",
              color: "var(--dim)",
              letterSpacing: "0.05em",
              lineHeight: 1.5,
              margin: 0,
            }}
          >
            You have no USDC yet. Use the faucet to get testnet USDC, then
            come back to approve.
          </p>
        )}

        {/* Buttons */}
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={handleDismiss}
            disabled={isBusy}
            style={{
              flex: 1,
              padding: "11px 0",
              fontFamily: "var(--font-mono)",
              fontSize: "0.62rem",
              letterSpacing: "0.1em",
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--muted)",
              cursor: isBusy ? "not-allowed" : "pointer",
              transition: "all 0.15s",
            }}
          >
            LATER
          </button>
          <button
            onClick={handleApprove}
            disabled={isBusy || !hasBalance}
            className="btn-terminal btn-cyan"
            style={{
              flex: 2,
              justifyContent: "center",
              opacity: hasBalance ? 1 : 0.4,
            }}
          >
            {isBusy ? (
              <>
                <span className="spinner">⟳</span>
                {isPending ? " SIGNING" : " CONFIRMING"}
                <span className="cursor-blink">_</span>
              </>
            ) : hasBalance ? (
              `APPROVE ${formatUsdc(balance!)} USDC`
            ) : (
              "APPROVE USDC"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
