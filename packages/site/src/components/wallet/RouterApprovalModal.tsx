import { useEffect, useState } from "react";
import {
  useAccount,
  useReadContracts,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { useFormo } from "@formo/analytics";
import { erc20Abi } from "@exnihilio/abis";
import { useAppChain } from "../../hooks/useAppChain.ts";
import { formatUsdc } from "../../lib/format.ts";
import {
  usePendingPerTradeApprovals,
  isSnoozed,
  snoozeForThirtyDays,
  SNOOZE_DAYS,
} from "../../hooks/useRouterApprovalPrompt.ts";

const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

export default function RouterApprovalModal() {
  const { address, isConnected } = useAccount();
  const { chainId, addresses } = useAppChain();
  const queryClient = useQueryClient();
  const analytics = useFormo();

  const pendingCount = usePendingPerTradeApprovals();

  // The modal is mounted in Layout, so it no longer unmounts on navigation —
  // "LATER" therefore lasts the whole session, and the cookie survives reloads.
  const [dismissed, setDismissed] = useState(false);
  const [snoozed, setSnoozed] = useState(isSnoozed);

  const routerAddress: `0x${string}` | undefined = addresses.router;
  const usdcAddress: `0x${string}` | undefined = addresses.usdc;

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
            chainId,
          },
          {
            address: usdcAddress!,
            abi: erc20Abi,
            functionName: "balanceOf" as const,
            args: [address!] as const,
            chainId,
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
      analytics?.track("Router Approved", { router: routerAddress });
    }
  }, [isSuccess, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  // Triggered by a trade surface being about to show a per-trade "Approve USDC",
  // rather than by `allowance === 0n`. The router spends the allowance on every
  // trade, so it erodes and effectively never returns to exactly zero — keying
  // off zero meant the offer disappeared for good once it had been used, right
  // when the user has started paying per-trade approvals again.
  //
  // `!isSuccess` closes it as soon as the approval lands, without a setState in
  // an effect — the trade surfaces stop registering once their allowance check
  // passes, but that only happens after the refetch resolves.
  const shouldShow =
    queryEnabled &&
    pendingCount > 0 &&
    balance !== undefined &&
    balance > 0n &&
    !isSuccess &&
    !dismissed &&
    !snoozed;

  if (!shouldShow) return null;

  const isBusy = isPending || confirming;
  const hasSpentAllowance = allowance !== undefined && allowance > 0n;

  function handleApprove() {
    if (!usdcAddress || !routerAddress || balance === undefined) return;
    writeContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [routerAddress, balance],
      chainId,
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
          {hasSpentAllowance ? (
            <>TOP UP FOR<br />ONE-CLICK TRADING</>
          ) : (
            <>ACTIVATE IMPROVED<br />TRADING EXPERIENCE</>
          )}
        </h2>

        {/* Description */}
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-label)",
            color: "var(--muted)",
            letterSpacing: "0.05em",
            lineHeight: 1.6,
            margin: 0,
          }}
        >
          {hasSpentAllowance
            ? "Your router approval has been used up by previous trades, so this trade needs its own approval. Top it up to go back to one-click trading across all pools."
            : "Approve USDC to the EXNIHILO router once. After this, you can open long and short positions across all pools without per-trade approvals."}
        </p>

        {/* Remaining allowance — only meaningful on a top-up */}
        {hasSpentAllowance && (
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
                fontSize: "var(--fs-label)",
                letterSpacing: "0.1em",
                color: "var(--muted)",
              }}
            >
              REMAINING
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.82rem",
                color: "var(--muted)",
                fontWeight: 600,
              }}
            >
              {formatUsdc(allowance!)} USDC
            </span>
          </div>
        )}

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
              fontSize: "var(--fs-label)",
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
              fontSize: "var(--fs-label)",
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

        {/* Long-term opt-out — persisted in a cookie, so it survives reloads
            and expires on its own after the window. */}
        <button
          onClick={() => { snoozeForThirtyDays(); setSnoozed(true); }}
          disabled={isBusy}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            marginTop: -4,
            alignSelf: "center",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-micro)",
            letterSpacing: "0.1em",
            color: "var(--muted)",
            textDecoration: "underline",
            textUnderlineOffset: 3,
            cursor: isBusy ? "not-allowed" : "pointer",
          }}
        >
          DON'T ASK AGAIN FOR {SNOOZE_DAYS} DAYS
        </button>
      </div>
    </div>
  );
}
