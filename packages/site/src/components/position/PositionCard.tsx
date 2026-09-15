import { useState } from "react";
import { formatUsdc, formatToken } from "../../lib/format.ts";
import { usePositionState, type Position } from "../../hooks/usePositionState.ts";
import TxButton from "../shared/TxButton.tsx";
import PnlCardModal from "./PnlCardModal.tsx";
import FundingMeter from "./FundingMeter.tsx";

interface PositionCardProps {
  tokenId: bigint;
  position: Position;
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
}: PositionCardProps) {
  const st = usePositionState(tokenId, position);

  const [pnlCardOpen, setPnlCardOpen] = useState(false);

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
                // Return, not payout — see PositionRow for why.
                color: (st.returnPct !== null ? st.returnPct >= 0 : st.pnlPositive)
                  ? "var(--green)"
                  : "var(--red)",
                lineHeight: 1.2,
              }}
            >
              {st.pnlPositive ? "+" : "−"}{formatUsdc(st.pnlNetAbs)}
            </div>
          </div>
          {st.returnPct !== null && (
            <div style={{ textAlign: "right" }}>
              <div className="stat-label">RETURN ON PREMIUM</div>
              <div
                style={{
                  fontSize: "0.82rem",
                  fontWeight: 600,
                  color: st.returnPct >= 0 ? "var(--green)" : "var(--red)",
                }}
              >
                {st.returnPct >= 0 ? "+" : "−"}
                {Math.abs(st.returnPct).toFixed(0)}%
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
          tokenSymbol={st.tokenSymbol}
          isLong={position.isLong}
          usdcIn={st.notional}
          lockedAmount={st.lockedAmount}
          remainingBps={st.remainingBps}
          tokenDecimals={st.tokenDecimals}
          openedAt={position.openedAt}
          feesPaid={position.feesPaid}
          hasPnl={st.hasPnl}
          pnlPositive={st.pnlPositive}
          pnlNetAbs={st.pnlNetAbs}
          returnPct={st.returnPct}
          onClose={() => setPnlCardOpen(false)}
        />
      )}

      {/* Funding — what replaced the countdown.
          There is nothing to extend and no deadline to watch. The position is
          being sold back a sliver at a time, and the meter is that. */}
      <FundingMeter
        remainingBps={st.remainingBps}
        pctPerDay={st.fundingPctDay}
        halfLifeSeconds={st.halfLifeSeconds}
        windDownShift={st.windDownShift}
        isMarketClosed={st.isMarketClosed}
        isDust={st.isDust}
      />

      {st.isMarketClosed && (
        <div
          style={{
            padding: "8px 10px",
            border: "1px solid rgba(255,140,0,0.25)",
            background: "rgba(255,140,0,0.06)",
          }}
        >
          <div style={{ fontSize: "var(--fs-nano)", letterSpacing: "0.15em", color: "var(--muted)", marginBottom: 2 }}>
            MARKET CLOSING
          </div>
          <div style={{ fontSize: "var(--fs-label)", color: "var(--orange)", letterSpacing: "0.04em", fontWeight: 600 }}>
            {st.marketClosedAt !== undefined
              ? new Date(Number(st.marketClosedAt) * 1000).toLocaleDateString()
              : "—"}
          </div>
          <p style={{ fontSize: "var(--fs-micro)", color: "var(--dim)", letterSpacing: "0.04em", margin: "3px 0 0" }}>
            No new positions. Yours stays open and closeable at any price you
            like — but a week after closing, funding starts doubling every day,
            so holding gets expensive fast.
          </p>
        </div>
      )}

      {/* Data grid — SIZE / LOCKED / FEES / DEBT. LOCKED is live collateral,
          net of funding; the other three are fixed at open. */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <div>
          <div className="stat-label">SIZE</div>
          <div style={{ fontSize: "0.82rem", color: "var(--body)" }}>
            {formatUsdc(st.notional)}
          </div>
        </div>

        <div>
          <div className="stat-label">{position.isLong ? "LOCKED TOKEN" : "LOCKED USDC"}</div>
          <div style={{ fontSize: "0.82rem", color: "var(--body)" }}>
            {position.isLong
              ? formatToken(st.lockedAmount, st.tokenDecimals)
              : formatUsdc(st.lockedAmount)}
          </div>
        </div>

        <div>
          <div className="stat-label">FEES PAID</div>
          <div style={{ fontSize: "0.82rem", color: "var(--body)" }}>
            {formatUsdc(position.feesPaid)}
          </div>
        </div>

        <div title="Shrinks with funding in step with the collateral, so your break-even price stays where you opened it — there is just less position behind it.">
          <div className="stat-label">{position.isLong ? "DEBT" : "NOTIONAL"}</div>
          <div style={{ fontSize: "0.82rem", color: "var(--body)" }}>
            {formatUsdc(position.isLong ? st.debt : st.notional)}
          </div>
        </div>
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
            onClick={() => st.close()}
            disabled={!st.canClose}
            style={{ width: "100%", justifyContent: "center", fontSize: "var(--fs-label)" }}
          />
        </WithTooltip>
      </div>

    </div>
  );
}
