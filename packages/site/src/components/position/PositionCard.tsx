import { useState, useEffect } from "react";
import { formatUsdc, formatToken, formatDuration } from "../../lib/format.ts";
import {
  usePositionState,
  parseUsdcInput,
  fmtCountdown,
  type Position,
} from "../../hooks/usePositionState.ts";
import TxButton from "../shared/TxButton.tsx";
import PnlCardModal from "./PnlCardModal.tsx";

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
            fontSize: "var(--fs-label)",
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
  positionNFTAddress,
  underlyingUsdc,
}: PositionCardProps) {
  const st = usePositionState(tokenId, position, positionNFTAddress, underlyingUsdc);

  const [armPanelOpen, setArmPanelOpen] = useState(false);
  const [pnlCardOpen, setPnlCardOpen] = useState(false);

  // Extending pulls the fee via allowance, so an approval may be needed first.
  const needsApprovalFirst = st.needsRenewApproval && !st.approveSuccess;
  // Suggested cap: 2× the current quote — headroom for profit growth and OI
  // crowding without authorizing a runaway fee.
  const [capInput, setCapInput] = useState<string>("");
  const capValue = capInput === "" ? st.suggestedCap : parseUsdcInput(capInput);
  const capBelowFee = capValue !== null && capValue < st.renewalFee;

  useEffect(() => {
    if (st.autoRenewSuccess) {
      setArmPanelOpen(false);
      setCapInput("");
    }
  }, [st.autoRenewSuccess]);

  return (
    <div
      style={{
        background: "var(--surface)",
        border: `1px solid ${position.isLong ? "rgba(0,255,136,0.15)" : "rgba(255,45,157,0.15)"}`,
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
          borderTop: `1px solid ${position.isLong ? "var(--green)" : "var(--magenta)"}`,
          borderLeft: `1px solid ${position.isLong ? "var(--green)" : "var(--magenta)"}`,
          pointerEvents: "none",
        }}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={position.isLong ? "tag-long" : "tag-short"}>
            {position.isLong ? "LONG" : "SHORT"}
          </span>
          <span style={{ fontSize: "0.78rem", color: "#fff", fontWeight: 600, letterSpacing: "0.04em" }}>
            {st.tokenSymbol}
          </span>
          <span style={{ fontSize: "var(--fs-label)", color: "var(--dim)" }}>
            #{tokenId.toString()}
          </span>
        </div>
        <span style={{ fontSize: "var(--fs-label)", color: "var(--muted)", letterSpacing: "0.05em" }}>
          {st.openedDate}
        </span>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: "var(--border)" }} />

      {/* PnL hero — the number the trader came to see */}
      {st.hasPnl && (
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div>
            <div className="stat-label">EST. PnL</div>
            <div
              style={{
                fontSize: "1.2rem",
                fontWeight: 700,
                letterSpacing: "0.02em",
                color: st.pnlPositive ? "var(--green)" : "var(--red)",
                lineHeight: 1.2,
              }}
            >
              {st.pnlPositive ? "+" : "−"}{formatUsdc(st.pnlNetAbs)}
            </div>
          </div>
          {position.feesPaid > 0n && (
            <div style={{ textAlign: "right" }}>
              <div className="stat-label">RETURN ON FEES</div>
              <div
                style={{
                  fontSize: "0.82rem",
                  fontWeight: 600,
                  color: st.pnlPositive ? "var(--green)" : "var(--red)",
                }}
              >
                {st.pnlPositive ? "+" : "−"}
                {((Number(st.pnlNetAbs) / Number(position.feesPaid)) * 100).toFixed(0)}%
              </div>
            </div>
          )}
        </div>
      )}

      {/* Shareable card — surfaces the position's own on-chain NFT art */}
      <button
        onClick={() => setPnlCardOpen(true)}
        style={{
          alignSelf: "flex-start",
          background: "none",
          border: "none",
          padding: 0,
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-nano)",
          letterSpacing: "0.12em",
          color: "var(--cyan)",
          textDecoration: "underline",
          textUnderlineOffset: 3,
          cursor: "pointer",
        }}
      >
        SHOW PNL CARD ↗
      </button>

      {pnlCardOpen && (
        <PnlCardModal
          tokenId={tokenId}
          positionNFTAddress={positionNFTAddress}
          tokenSymbol={st.tokenSymbol}
          isLong={position.isLong}
          feesPaidRaw={position.feesPaid}
          hasPnl={st.hasPnl}
          pnlPositive={st.pnlPositive}
          pnlNetAbs={st.pnlNetAbs}
          onClose={() => setPnlCardOpen(false)}
        />
      )}

      {/* Deadline / Timer */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 10px",
          background: st.isExpired
            ? "rgba(255,59,48,0.08)"
            : st.isUrgent
            ? "rgba(255,140,0,0.08)"
            : "rgba(0,229,255,0.04)",
          border: `1px solid ${
            st.isExpired ? "rgba(255,59,48,0.25)" : st.isUrgent ? "rgba(255,140,0,0.25)" : "rgba(0,229,255,0.1)"
          }`,
        }}
      >
        <div>
          <div
            style={{
              fontSize: "var(--fs-nano)",
              letterSpacing: "0.15em",
              color: "var(--muted)",
              marginBottom: 2,
            }}
          >
            {st.isExpired ? "EXPIRED" : "EXPIRES"}
          </div>
          <div
            style={{
              fontSize: "0.72rem",
              fontWeight: 600,
              color: st.isExpired ? "var(--red)" : st.isUrgent ? "var(--orange)" : "var(--cyan)",
              letterSpacing: "0.06em",
            }}
          >
            {st.isExpired ? st.deadlineDate : fmtCountdown(st.secondsLeft)}
          </div>
        </div>

        {/* Renew button — hidden when market is closed (contract rejects renewals past closeDate) */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
          {st.isMarketClosed ? (
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: "var(--fs-nano)", letterSpacing: "0.15em", color: "var(--muted)" }}>
                MARKET CLOSED
              </div>
              {st.marketClosedAt !== undefined && (
                <div style={{ fontSize: "var(--fs-label)", color: "var(--red)", letterSpacing: "0.04em", fontWeight: 600 }}>
                  {new Date(Number(st.marketClosedAt) * 1000).toLocaleDateString()}
                </div>
              )}
              <div style={{ fontSize: "var(--fs-nano)", color: "var(--dim)", letterSpacing: "0.04em", marginTop: 1 }}>
                renew unavailable
              </div>
            </div>
          ) : (
            <>
              {/* The button always reads "Extend …" so its purpose is clear.
                  A bare "Approve USDC" gave no hint what it was for. Approval
                  is a step inside the extend flow, taken only on click. */}
              <TxButton
                idleLabel={`Extend +${formatDuration(st.poolPositionDuration)} ($${formatUsdc(st.renewalFee)})`}
                status={needsApprovalFirst ? st.approveStatus : st.renewStatus}
                variant="default"
                onClick={needsApprovalFirst ? st.approveRenewal : st.renew}
                style={{ fontSize: "var(--fs-label)", padding: "4px 10px" }}
              />
              <span style={{ fontSize: "var(--fs-nano)", color: "var(--dim)", letterSpacing: "0.1em" }}>
                {needsApprovalFirst
                  ? "APPROVES USDC FIRST · THEN EXTEND"
                  : "STACKS · DYNAMIC FEE · REPRICED LIVE"}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Auto-renew — keeper renews from position equity at expiry */}
      {!st.isMarketClosed && (
        <div
          style={{
            border: `1px solid ${st.autoRenewOn ? "rgba(0,229,255,0.2)" : "var(--border)"}`,
            background: st.autoRenewOn ? "rgba(0,229,255,0.03)" : "transparent",
            padding: "8px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            transition: "border-color 0.2s ease, background 0.2s ease",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: "var(--fs-nano)", letterSpacing: "0.15em", color: "var(--muted)", marginBottom: 2 }}>
                AUTO-RENEW
              </div>
              {st.autoRenewOn ? (
                <div style={{ fontSize: "var(--fs-label)", color: "var(--cyan)", letterSpacing: "0.05em", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="pulse-dot" style={{ background: "var(--cyan)" }} />
                  ARMED · CAP ${formatUsdc(st.autoRenewCap)}
                </div>
              ) : (
                <div style={{ fontSize: "var(--fs-label)", color: "var(--muted)", letterSpacing: "0.05em" }}>
                  OFF — settles at expiry
                </div>
              )}
            </div>

            {/* Terminal toggle */}
            <button
              onClick={() => {
                if (st.autoRenewBusy) return;
                if (st.autoRenewOn) st.disarmAutoRenew();
                else setArmPanelOpen((v) => !v);
              }}
              disabled={st.autoRenewBusy}
              aria-label={st.autoRenewOn ? "Disable auto-renew" : "Enable auto-renew"}
              style={{
                width: 36,
                height: 18,
                padding: 0,
                background: "var(--bg)",
                border: `1px solid ${st.autoRenewOn ? "var(--cyan)" : "var(--border-bright)"}`,
                cursor: st.autoRenewBusy ? "wait" : "pointer",
                position: "relative",
                flexShrink: 0,
                opacity: st.autoRenewBusy ? 0.6 : 1,
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 2,
                  left: 2,
                  width: 12,
                  height: 12,
                  background: st.autoRenewOn ? "var(--cyan)" : "var(--muted)",
                  boxShadow: st.autoRenewOn ? "0 0 8px rgba(0,229,255,0.6)" : "none",
                  transform: st.autoRenewOn ? "translateX(18px)" : "translateX(0)",
                  transition: "transform 0.18s ease, background 0.18s ease, box-shadow 0.18s ease",
                }}
              />
            </button>
          </div>

          {/* Arm panel */}
          {armPanelOpen && !st.autoRenewOn && (
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: "var(--fs-nano)", letterSpacing: "0.15em", color: "var(--muted)", marginBottom: 3 }}>
                    FEE CAP (USDC)
                  </div>
                  <input
                    value={capInput}
                    onChange={(e) => setCapInput(e.target.value)}
                    placeholder={formatUsdc(st.suggestedCap)}
                    inputMode="decimal"
                    style={{
                      width: "100%",
                      background: "var(--bg)",
                      border: `1px solid ${capValue === null ? "var(--red)" : capBelowFee ? "var(--orange)" : "var(--border-bright)"}`,
                      color: "var(--body)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--fs-body-s)",
                      padding: "5px 8px",
                      outline: "none",
                      letterSpacing: "0.04em",
                    }}
                  />
                </div>
                <TxButton
                  idleLabel="Arm"
                  status={st.autoRenewStatus}
                  variant="cyan"
                  disabled={capValue === null}
                  onClick={() => capValue !== null && st.armAutoRenew(capValue)}
                  style={{ fontSize: "var(--fs-label)", padding: "5px 14px" }}
                />
              </div>
              {capValue === null ? (
                <span style={{ fontSize: "var(--fs-label)", color: "var(--red)", letterSpacing: "0.04em" }}>
                  invalid amount
                </span>
              ) : capBelowFee ? (
                <span style={{ fontSize: "var(--fs-label)", color: "var(--orange)", letterSpacing: "0.04em" }}>
                  below the current fee (${formatUsdc(st.renewalFee)}) — the keeper would settle instead of renewing
                </span>
              ) : (
                <span style={{ fontSize: "var(--fs-label)", color: "var(--muted)", letterSpacing: "0.04em", lineHeight: 1.6 }}>
                  At expiry, anyone may renew this position for you. The fee + 0.05 keeper
                  bounty are paid from the position's own profit — nothing leaves your
                  wallet. If it can't pay, or the fee exceeds your cap, it settles instead.
                  Cleared if the NFT is transferred.
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Data grid — SIZE / LOCKED / FEES for both sides. The synthetic debt
          equals SIZE at open, so it only earns a row once auto-extends have
          grown it (the fees written against the position's equity). */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <div>
          <div className="stat-label">SIZE</div>
          <div style={{ fontSize: "0.82rem", color: "var(--body)" }}>
            {formatUsdc(position.usdcIn)}
          </div>
        </div>

        <div>
          <div className="stat-label">{position.isLong ? "LOCKED TOKEN" : "LOCKED USDC"}</div>
          <div style={{ fontSize: "0.82rem", color: "var(--body)" }}>
            {position.isLong
              ? formatToken(position.lockedAmount, 18)
              : formatUsdc(position.lockedAmount)}
          </div>
        </div>

        <div>
          <div className="stat-label">FEES PAID</div>
          <div style={{ fontSize: "0.82rem", color: "var(--body)" }}>
            {formatUsdc(position.feesPaid)}
          </div>
        </div>

        {position.isLong && position.airUsdMinted > position.usdcIn && (
          <div title="Auto-extend fees are written against the position as extra debt — your break-even rises by this difference.">
            <div className="stat-label">DEBT · AUTO-EXTENDS</div>
            <div style={{ fontSize: "0.82rem", color: "var(--orange)" }}>
              {formatUsdc(position.airUsdMinted)}
            </div>
          </div>
        )}
      </div>

      {/* Pool address */}
      <p style={{ fontSize: "var(--fs-micro)", color: "var(--muted)", letterSpacing: "0.03em" }}>
        Pool: {position.pool.slice(0, 10)}...{position.pool.slice(-6)}
      </p>

      {/* Actions */}
      <div className="flex gap-2">
        <WithTooltip tip="Close your position and receive USDC back.">
          <TxButton
            idleLabel={position.isLong ? "Close Long" : "Close Short"}
            status={st.closeStatus}
            variant={position.isLong ? "red" : "green"}
            onClick={st.close}
            disabled={!st.canClose}
            style={{ width: "100%", justifyContent: "center", fontSize: "var(--fs-label)" }}
          />
        </WithTooltip>
      </div>

      {/* Expired hint */}
      {st.isExpired && (
        <p
          style={{
            fontSize: "var(--fs-micro)",
            color: st.autoRenewOn ? "var(--cyan)" : "var(--red)",
            letterSpacing: "0.04em",
            marginTop: -6,
          }}
        >
          {st.autoRenewOn
            ? "EXPIRED -- auto-renew armed: a keeper renews it from position profit (or settles if it can't pay)"
            : "EXPIRED -- position can be settled by anyone"}
        </p>
      )}
    </div>
  );
}
