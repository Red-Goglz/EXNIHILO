import { useState, useEffect, useRef } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { useFormo } from "@formo/analytics";
import { exnihiloPoolAbi, lpNFTAbi, erc20Abi } from "@exnihilio/abis";
import { parseUnits, formatUsdc, formatToken, formatExact } from "../../lib/format.ts";
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
  const [claimAddrInput, setClaimAddrInput] = useState("");

  const poolContract = { address: poolAddress, abi: exnihiloPoolAbi, chainId } as const;

  const { data } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "lpNftId" },
      { ...poolContract, functionName: "backedAirToken" },
      { ...poolContract, functionName: "backedAirUsd" },
      { ...poolContract, functionName: "lpFeesAccumulated" },
      { ...poolContract, functionName: "openPositionCount" },
      { ...poolContract, functionName: "currentMaxPositionBps" },
      { ...poolContract, functionName: "effectiveLeverageCap" },
      { ...poolContract, functionName: "createdAt" },
      { ...poolContract, functionName: "closeDate" },
      { ...poolContract, functionName: "lpFeesPaidTotal" },
    ],
  });

  const lpNftId = data?.[0]?.result as bigint | undefined;
  const backedAirToken = data?.[1]?.result as bigint | undefined;
  const backedAirUsd = data?.[2]?.result as bigint | undefined;
  const lpFeesClaimable = data?.[3]?.result as bigint | undefined;
  const openPositionCount = data?.[4]?.result as bigint | undefined;
  const CAP_MAX_BPS = 2000n;
  const currentCapBps = data?.[5]?.result as bigint | undefined;
  const capIsRamping = currentCapBps !== undefined && currentCapBps < CAP_MAX_BPS;
  const effectiveCap = data?.[6]?.result as bigint | undefined;
  const capCreatedAt = data?.[7]?.result as bigint | undefined;
  // Same lazy-init + interval pattern as usePositionState's countdown: reading
  // Date.now() during render is impure and lints as such.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(id);
  }, []);

  const capHoursLeft =
    capCreatedAt === undefined
      ? 0
      : Math.max(0, Math.ceil((Number(capCreatedAt) + 24 * 3600 - nowSec) / 3600));
  const closeDate = data?.[8]?.result as bigint | undefined;
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

  // One useTx per action, never one shared instance. `status` stays "success"
  // until the underlying mutation is reset, and TxButton renders "DONE" for
  // success regardless of its idleLabel — so a shared hook makes every later
  // button in the flow inherit the previous step's success and show "DONE"
  // instead of its own label.
  const {
    writeContract: writeApprove,
    status: approveStatus,
    isSuccess: approveSuccess,
    reset: resetApprove,
  } = useTx("APPROVAL");

  const {
    writeContract: writeAdd,
    status: addStatus,
    isSuccess: addSuccess,
  } = useTx("ADD LIQUIDITY");

  const {
    writeContract: writeRemove,
    status: removeStatus,
    isSuccess: removeSuccess,
  } = useTx("REMOVE LIQUIDITY");

  const {
    writeContract: writeClaim,
    status: claimStatus,
    isSuccess: claimSuccess,
  } = useTx("CLAIM FEES");

  const {
    writeContract: writeClose,
    status: closeStatus,
    isSuccess: closeSuccess,
  } = useTx("MARKET CLOSE");

  useEffect(() => {
    if (
      approveSuccess ||
      addSuccess ||
      removeSuccess ||
      claimSuccess ||
      closeSuccess
    )
      queryClient.invalidateQueries();
  }, [
    approveSuccess,
    addSuccess,
    removeSuccess,
    claimSuccess,
    closeSuccess,
    queryClient,
  ]);

  // Both approvals share one button, so clear the previous approval's success
  // when the flow advances from token → USDC. Without this the second step
  // renders "DONE" before it has been signed.
  const approvalStep = needsTokenApproval ? "token" : needsUsdcApproval ? "usdc" : "none";
  const prevApprovalStep = useRef(approvalStep);
  useEffect(() => {
    if (prevApprovalStep.current !== approvalStep) {
      prevApprovalStep.current = approvalStep;
      resetApprove();
    }
  }, [approvalStep, resetApprove]);

  const isPoolClosing = closeDate !== undefined && closeDate > 0n;

  // Parse cap inputs: usd is raw USDC (6 dec), bps is integer
  const handleSuccess = () => {
    queryClient.invalidateQueries();
    setTokenInput("");
    setUsdcInput("");
  };

  // ── Ratio pairing ────────────────────────────────────────────────────────
  // addLiquidity() rejects any deposit that would move the price: it
  // cross-multiplies against the current reserves and reverts with
  // RatioMismatch outside a 0.01 % tolerance. Deriving the paired amount is
  // therefore not a convenience — hand-entered pairs revert almost every time.
  //
  // An empty pool has no ratio to match (the contract skips the check), so the
  // first depositor sets the opening price and both fields stay free.
  const hasRatio =
    backedAirToken !== undefined &&
    backedAirUsd !== undefined &&
    backedAirToken > 0n &&
    backedAirUsd > 0n;

  // Derived from the counterpart's raw value, then rendered with formatExact —
  // a lossy formatter here would feed a rounded string back into parseUnits and
  // submit exactly the off-ratio deposit this is meant to prevent.
  const handleTokenInput = (v: string) => {
    setTokenInput(v);
    if (!hasRatio) return;
    const raw = parseUnits(v, tokenDecimals);
    setUsdcInput(raw === 0n ? "" : formatExact((raw * backedAirUsd) / backedAirToken, 6));
  };

  const handleUsdcInput = (v: string) => {
    setUsdcInput(v);
    if (!hasRatio) return;
    const raw = parseUnits(v, 6);
    setTokenInput(
      raw === 0n ? "" : formatExact((raw * backedAirToken) / backedAirUsd, tokenDecimals)
    );
  };

  // Mirrors the contract's own check so a mismatch is caught before it costs
  // a reverted transaction. Only reachable by editing one side after pairing.
  const ratioMismatch = (() => {
    if (!hasRatio || tokenRaw === 0n || usdcRaw === 0n) return false;
    const lhs = tokenRaw * backedAirUsd;
    const rhs = usdcRaw * backedAirToken;
    const tolerance = (lhs > rhs ? lhs : rhs) / 10_000n + 1n;
    return lhs > rhs + tolerance || rhs > lhs + tolerance;
  })();

  /** Pool price as USDC (6 dec) per whole token — the pairing rate shown to the LP. */
  const pricePerToken = hasRatio
    ? (backedAirUsd * 10n ** BigInt(tokenDecimals)) / backedAirToken
    : 0n;

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
              ? `◉ MARKET CLOSING — ${openPositionCount?.toString()} position(s) must close or decay before withdrawal`
              : `◉ ${openPositionCount?.toString()} open position(s) — cannot remove liquidity`}
          </div>
          {!isPoolClosing && (
            <div style={{ color: "var(--muted)", fontSize: "var(--fs-micro)", lineHeight: 1.5 }}>
              Close the market to block new positions and start the wind-down.
              After a 7-day grace period the funding rate doubles every day, so
              positions nobody closes decay into sweep range within about 11 more
              days. Once every position is closed or swept you can withdraw all
              liquidity.
            </div>
          )}
          {isPoolClosing && (
            <div style={{ color: "var(--muted)", fontSize: "var(--fs-micro)" }}>
              Wind-down begins {new Date(Number(closeDate!) * 1000).toLocaleString()} — from then the funding rate doubles every day until every position is closed or decayed away.
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

        {/* Pairing rate — deposits must match the pool ratio exactly. */}
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-label)",
            color: "var(--muted)",
            letterSpacing: "0.05em",
            lineHeight: 1.5,
          }}
        >
          {hasRatio ? (
            <>
              POOL RATIO · 1 {tokenSymbol} = {formatExact(pricePerToken, 6)} USDC
              <br />
              <span style={{ color: "var(--dim)" }}>
                Enter either amount — the other is paired automatically.
              </span>
            </>
          ) : (
            <>
              POOL EMPTY
              <br />
              <span style={{ color: "var(--dim)" }}>
                Your deposit sets the opening price.
              </span>
            </>
          )}
        </div>

        <TokenInput
          label={tokenSymbol}
          value={tokenInput}
          onChange={handleTokenInput}
          tokenAddress={underlyingToken}
          decimals={tokenDecimals}
          symbol={tokenSymbol}
        />
        <TokenInput
          label="USDC"
          value={usdcInput}
          onChange={handleUsdcInput}
          tokenAddress={underlyingUsdc}
          decimals={6}
          symbol="USDC"
        />

        {ratioMismatch && (
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-label)",
              color: "var(--red)",
              letterSpacing: "0.05em",
              lineHeight: 1.5,
            }}
          >
            OFF-RATIO — would revert. For {tokenInput || "0"} {tokenSymbol} deposit{" "}
            {formatExact((tokenRaw * backedAirUsd!) / backedAirToken!, 6)} USDC.
          </p>
        )}

        {(needsTokenApproval || needsUsdcApproval) && (
          <TxButton
            idleLabel={`Approve ${needsTokenApproval ? tokenSymbol : "USDC"}`}
            status={approveStatus}
            onClick={() => {
              if (needsTokenApproval) {
                writeApprove({
                  address: underlyingToken,
                  abi: erc20Abi,
                  functionName: "approve",
                  args: [poolAddress, tokenRaw],
                  chainId,
                });
              } else {
                writeApprove({
                  address: underlyingUsdc,
                  abi: erc20Abi,
                  functionName: "approve",
                  args: [poolAddress, usdcRaw],
                  chainId,
                });
              }
            }}
            disabled={tokenRaw === 0n || usdcRaw === 0n || ratioMismatch}
            style={{ width: "100%", justifyContent: "center" }}
          />
        )}

        {!needsTokenApproval && !needsUsdcApproval && (
          <TxButton
            idleLabel="Add Liquidity"
            status={addStatus}
            variant="green"
            onClick={() =>
              writeAdd(
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
            disabled={tokenRaw === 0n || usdcRaw === 0n || ratioMismatch}
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
          status={removeStatus}
          variant="red"
          onClick={() =>
            writeRemove(
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

      {/* Earned fees — fees accrue on every position open (pull
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
            . Funding is not here: it lands straight in the pool\'s reserves
            rather than becoming claimable, so it deepens the market instead of
            paying out. Claim the fees below — optionally to a different address if
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
            status={claimStatus}
            variant="default"
            onClick={() => {
              const recipient = (claimAddrInput !== ""
                ? claimAddrInput
                : address) as `0x${string}`;
              writeClaim(
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

      {/* Position cap — automatic, not configurable */}
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
          POSITION CAP
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div style={{ background: "var(--surface-2)", padding: "10px 12px" }}>
            <div className="stat-label">CURRENT</div>
            <div style={{ fontSize: "0.82rem", color: "var(--body)" }}>
              {currentCapBps === undefined
                ? "—"
                : `${(Number(currentCapBps) / 100).toFixed(2)}% of pool`}
            </div>
          </div>
          <div style={{ background: "var(--surface-2)", padding: "10px 12px" }}>
            <div className="stat-label">IN USDC</div>
            <div style={{ fontSize: "0.82rem", color: "var(--body)" }}>
              {effectiveCap === undefined ? "—" : `$${formatUsdc(effectiveCap)}`}
            </div>
          </div>
        </div>

        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-micro)",
            color: "var(--muted)",
            lineHeight: 1.5,
          }}
        >
          {capIsRamping
            ? `Widening automatically to 20% of pool depth, ~${capHoursLeft}h remaining.`
            : "At its 20% ceiling."}{" "}
          The cap starts at 1% when a market is created and widens over the first
          24 hours. It is fixed in the contract — no one, including the LP holder,
          can change it.
        </div>
      </div>

    </div>
  );
}
