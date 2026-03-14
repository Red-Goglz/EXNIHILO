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

const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

export default function RouterApprovalModal() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const queryClient = useQueryClient();

  // Dismissed only for this page visit — resets on every mount (navigating away and back)
  const [dismissed, setDismissed] = useState(false);

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
  const queryEnabled = isConnected && !!address && hasRouter && !!usdcAddress;

  const { data } = useReadContracts({
    contracts: queryEnabled
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
    query: { enabled: queryEnabled },
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
    }
  }, [isSuccess, queryClient]);

  // Show when: connected, router deployed, no allowance yet, has USDC, not dismissed
  const shouldShow =
    queryEnabled &&
    allowance !== undefined &&
    allowance === 0n &&
    balance !== undefined &&
    balance > 0n &&
    !dismissed;

  if (!shouldShow) return null;

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

        {/* Buttons */}
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={() => setDismissed(true)}
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
            disabled={isBusy}
            className="btn-terminal btn-cyan"
            style={{
              flex: 2,
              justifyContent: "center",
            }}
          >
            {isBusy ? (
              <>
                <span className="spinner">⟳</span>
                {isPending ? " SIGNING" : " CONFIRMING"}
                <span className="cursor-blink">_</span>
              </>
            ) : (
              `APPROVE ${formatUsdc(balance!)} USDC`
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
