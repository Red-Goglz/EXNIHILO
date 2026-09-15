import { useState } from "react";
import { formatUsdc, formatToken } from "../../lib/format.ts";
import { usePositionState, fmtDuration, type Position } from "../../hooks/usePositionState.ts";
import TxButton from "../shared/TxButton.tsx";
import PnlCardModal from "./PnlCardModal.tsx";
import FundingMeter from "./FundingMeter.tsx";

interface PositionRowProps {
  tokenId: bigint;
  position: Position;
}

/**
 * One position as a table row (desktop portfolio view). Everything needed
 * day-to-day sits inline: PnL, what funding has left of the position, and
 * close. Secondary data lives in an expandable detail row so the table stays
 * one line per position.
 *
 * There is no countdown and no extend button because there is nothing to
 * extend: positions do not expire, they are charged continuously and shrink.
 * The meter in the FUNDING column is the position.
 */
export default function PositionRow({
  tokenId,
  position,
}: PositionRowProps) {
  const st = usePositionState(tokenId, position);

  const [expanded, setExpanded] = useState(false);
  const [pnlCardOpen, setPnlCardOpen] = useState(false);

  const sideColor = position.isLong ? "var(--green)" : "var(--magenta)";
  // Colour by return, not by payout: a position can pay out a positive number
  // and still be below the premium that bought it.
  const inProfit = st.returnPct !== null ? st.returnPct >= 0 : st.pnlPositive;
  const pnlColor = inProfit ? "var(--green)" : "var(--red)";

  const detailOpen = expanded;

  return (
    <>
      <tr style={{ borderLeft: `2px solid ${sideColor}` }}>
        {/* SIDE */}
        <td>
          <span className={position.isLong ? "tag-long" : "tag-short"}>
            {position.isLong ? "LONG" : "SHORT"}
          </span>
        </td>

        {/* MARKET */}
        <td>
          <span style={{ color: "#fff", fontWeight: 600, letterSpacing: "0.04em" }}>
            {st.tokenSymbol}
          </span>{" "}
          <span style={{ color: "var(--dim)", fontSize: "var(--fs-label)" }}>
            #{tokenId.toString()}
          </span>
        </td>

        {/* SIZE */}
        <td>${formatUsdc(st.notional)}</td>

        {/* EST. PNL */}
        <td>
          {st.hasPnl ? (
            <span style={{ color: pnlColor, fontWeight: 600 }}>
              {st.pnlPositive ? "+" : "−"}{formatUsdc(st.pnlNetAbs)}
              {st.returnPct !== null && (
                <span style={{ fontWeight: 400, fontSize: "var(--fs-label)", opacity: 0.75 }}>
                  {" "}({st.returnPct >= 0 ? "+" : "−"}
                  {Math.abs(st.returnPct).toFixed(0)}% on premium)
                </span>
              )}
            </span>
          ) : (
            <span style={{ color: "var(--dim)" }}>—</span>
          )}
        </td>

        {/* FUNDING — what replaced EXPIRES and AUTO-RENEW.
            Two columns collapse into one because the two things they showed
            were the same thing: what holding costs, and what happens if you do
            nothing. Now doing nothing has exactly one outcome, and the meter
            shows how far along it is. */}
        <td colSpan={2} style={{ minWidth: 190 }}>
          <FundingMeter
            compact
            remainingBps={st.remainingBps}
            pctPerDay={st.fundingPctDay}
            halfLifeSeconds={st.halfLifeSeconds}
            windDownShift={st.windDownShift}
            isMarketClosed={st.isMarketClosed}
            isDust={st.isDust}
          />
        </td>

        {/* ACTIONS */}
        <td>
          <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}>
            {/* Same btn-terminal treatment as Close so the actions read
                as one row of buttons rather than a stray icon. */}
            <button
              onClick={() => setPnlCardOpen(true)}
              title="Show shareable PnL card"
              className="btn-terminal"
              style={{ fontSize: "var(--fs-label)", padding: "4px 8px", whiteSpace: "nowrap" }}
            >
              PNL CARD
            </button>
            <TxButton
              idleLabel="Close"
              status={st.closeStatus}
              variant={position.isLong ? "red" : "green"}
              onClick={() => st.close()}
              disabled={!st.canClose}
              style={{ fontSize: "var(--fs-label)", padding: "4px 10px" }}
            />
            <button
              onClick={() => setExpanded((v) => !v)}
              aria-label={detailOpen ? "Collapse details" : "Expand details"}
              style={{
                background: "transparent",
                border: "1px solid var(--border)",
                color: detailOpen ? "var(--cyan)" : "var(--muted)",
                fontFamily: "var(--font-mono)",
                fontSize: "0.7rem",
                width: 24,
                height: 24,
                cursor: "pointer",
                flexShrink: 0,
                transition: "color 0.15s",
              }}
            >
              {detailOpen ? "▾" : "▸"}
            </button>
          </div>

          {/* Lives inside the cell for valid table markup; it is position:fixed
              so it still overlays the whole page. */}
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
        </td>
      </tr>

      {/* ── Detail row ── */}
      {detailOpen && (
        <tr className="position-detail">
          <td colSpan={7}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "4px 0 6px" }}>
              {/* Secondary data */}
              <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
                <div>
                  <div className="stat-label">{position.isLong ? "LOCKED TOKEN" : "LOCKED USDC"}</div>
                  <div style={{ fontSize: "0.78rem", color: "var(--body)" }}>
                    {position.isLong
                      ? formatToken(st.lockedAmount, st.tokenDecimals)
                      : formatUsdc(st.lockedAmount)}
                  </div>
                </div>
                <div>
                  <div className="stat-label">FEES PAID</div>
                  <div style={{ fontSize: "0.78rem", color: "var(--body)" }}>
                    {formatUsdc(position.feesPaid)}
                  </div>
                </div>
                <div title="Shrinks with funding in step with the collateral, so your break-even price stays where you opened it — there is just less position behind it.">
                  <div className="stat-label">{position.isLong ? "DEBT" : "NOTIONAL"}</div>
                  <div style={{ fontSize: "0.78rem", color: "var(--body)" }}>
                    {formatUsdc(position.isLong ? st.debt : st.notional)}
                  </div>
                </div>
                {st.halfLifeSeconds !== null && (
                  <div title="At the current rate. The rate itself moves with open interest, pool depth and market age, so this is a reading, not a schedule.">
                    <div className="stat-label">HALF GONE IN</div>
                    <div style={{ fontSize: "0.78rem", color: "var(--body)" }}>
                      {fmtDuration(st.halfLifeSeconds)}
                    </div>
                  </div>
                )}
                <div>
                  <div className="stat-label">OPENED</div>
                  <div style={{ fontSize: "0.78rem", color: "var(--body)" }}>{st.openedDate}</div>
                </div>
                <div>
                  <div className="stat-label">POOL</div>
                  <div style={{ fontSize: "0.78rem", color: "var(--muted)" }}>
                    {position.pool.slice(0, 10)}...{position.pool.slice(-6)}
                  </div>
                </div>
                {st.isMarketClosed && st.marketClosedAt !== undefined && (
                  <div>
                    <div className="stat-label">MARKET CLOSED</div>
                    <div style={{ fontSize: "0.78rem", color: "var(--red)" }}>
                      {new Date(Number(st.marketClosedAt) * 1000).toLocaleDateString()} — funding doubles daily after 7d
                    </div>
                  </div>
                )}
              </div>

            </div>
          </td>
        </tr>
      )}
    </>
  );
}
