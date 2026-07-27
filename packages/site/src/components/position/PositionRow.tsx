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

interface PositionRowProps {
  tokenId: bigint;
  position: Position;
  positionNFTAddress: `0x${string}`;
  underlyingUsdc: `0x${string}`;
}

/**
 * One position as a table row (desktop portfolio view). Everything needed
 * day-to-day sits inline: PnL, countdown, extend, close, auto-renew toggle.
 * Secondary data and the auto-renew arm panel live in an expandable detail
 * row so the table stays one line per position.
 */
export default function PositionRow({
  tokenId,
  position,
  positionNFTAddress,
  underlyingUsdc,
}: PositionRowProps) {
  const st = usePositionState(tokenId, position, positionNFTAddress, underlyingUsdc);

  const [expanded, setExpanded] = useState(false);
  const [armPanelOpen, setArmPanelOpen] = useState(false);
  const [pnlCardOpen, setPnlCardOpen] = useState(false);

  // Extending pulls the fee via allowance, so an approval may be needed first.
  const needsApprovalFirst = st.needsRenewApproval && !st.approveSuccess;
  const [capInput, setCapInput] = useState<string>("");
  const capValue = capInput === "" ? st.suggestedCap : parseUsdcInput(capInput);
  const capBelowFee = capValue !== null && capValue < st.renewalFee;

  useEffect(() => {
    if (st.autoRenewSuccess) {
      setArmPanelOpen(false);
      setCapInput("");
    }
  }, [st.autoRenewSuccess]);

  const sideColor = position.isLong ? "var(--green)" : "var(--magenta)";
  const pnlColor = st.pnlPositive ? "var(--green)" : "var(--red)";
  const expiryColor = st.isExpired
    ? "var(--red)"
    : st.isUrgent
    ? "var(--orange)"
    : "var(--cyan)";

  const detailOpen = expanded || (armPanelOpen && !st.autoRenewOn);

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
        <td>${formatUsdc(position.usdcIn)}</td>

        {/* EST. PNL */}
        <td>
          {st.hasPnl ? (
            <span style={{ color: pnlColor, fontWeight: 600 }}>
              {st.pnlPositive ? "+" : "−"}${formatUsdc(st.pnlNetAbs)}
              {position.feesPaid > 0n && (
                <span style={{ fontWeight: 400, fontSize: "var(--fs-label)", opacity: 0.75 }}>
                  {" "}({st.pnlPositive ? "+" : "−"}
                  {((Number(st.pnlNetAbs) / Number(position.feesPaid)) * 100).toFixed(0)}% fees)
                </span>
              )}
            </span>
          ) : (
            <span style={{ color: "var(--dim)" }}>—</span>
          )}
        </td>

        {/* EXPIRES */}
        <td>
          {st.isMarketClosed ? (
            <span style={{ color: "var(--red)", fontSize: "var(--fs-label)", letterSpacing: "0.06em" }}>
              MARKET CLOSED
            </span>
          ) : (
            <span style={{ color: expiryColor, fontWeight: 600, fontSize: "0.72rem", letterSpacing: "0.06em" }}>
              {st.isExpired ? `EXPIRED ${st.deadlineDate}` : fmtCountdown(st.secondsLeft)}
            </span>
          )}
        </td>

        {/* AUTO-RENEW */}
        <td>
          {st.isMarketClosed ? (
            <span style={{ color: "var(--dim)" }}>—</span>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                onClick={() => {
                  if (st.autoRenewBusy) return;
                  if (st.autoRenewOn) {
                    st.disarmAutoRenew();
                  } else {
                    setArmPanelOpen((v) => !v);
                  }
                }}
                disabled={st.autoRenewBusy}
                aria-label={st.autoRenewOn ? "Disable auto-renew" : "Enable auto-renew"}
                title={st.autoRenewOn ? `Auto-renew armed · cap $${formatUsdc(st.autoRenewCap)}` : "Auto-renew off — settles at expiry"}
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
              {st.autoRenewOn && (
                <span style={{ fontSize: "var(--fs-label)", color: "var(--cyan)", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>
                  CAP ${formatUsdc(st.autoRenewCap)}
                </span>
              )}
            </div>
          )}
        </td>

        {/* ACTIONS */}
        <td>
          <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}>
            {/* Always reads "Extend …" so its purpose is clear; approving is a
                step inside that flow, taken only on click. A bare "Approve
                USDC" gave no hint what it was for. */}
            {!st.isMarketClosed && (
              <TxButton
                idleLabel={`Extend +${formatDuration(st.poolPositionDuration)} ($${formatUsdc(st.renewalFee)})`}
                status={needsApprovalFirst ? st.approveStatus : st.renewStatus}
                variant="default"
                onClick={needsApprovalFirst ? st.approveRenewal : st.renew}
                title={needsApprovalFirst
                  ? "Approves USDC first, then extend"
                  : "Stacks · dynamic fee · repriced live"}
                style={{ fontSize: "var(--fs-label)", padding: "4px 8px", whiteSpace: "nowrap" }}
              />
            )}
            {/* Same btn-terminal treatment as Extend/Close so the actions read
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
              onClick={st.close}
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
                      ? formatToken(position.lockedAmount, 18)
                      : formatUsdc(position.lockedAmount)}
                  </div>
                </div>
                <div>
                  <div className="stat-label">FEES PAID</div>
                  <div style={{ fontSize: "0.78rem", color: "var(--body)" }}>
                    {formatUsdc(position.feesPaid)}
                  </div>
                </div>
                {position.isLong && position.airUsdMinted > position.usdcIn && (
                  <div title="Auto-extend fees are written against the position as extra debt — your break-even rises by this difference.">
                    <div className="stat-label">DEBT · AUTO-EXTENDS</div>
                    <div style={{ fontSize: "0.78rem", color: "var(--orange)" }}>
                      {formatUsdc(position.airUsdMinted)}
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
                      {new Date(Number(st.marketClosedAt) * 1000).toLocaleDateString()} — renew unavailable
                    </div>
                  </div>
                )}
              </div>

              {/* Expired hint */}
              {st.isExpired && (
                <p style={{ fontSize: "var(--fs-micro)", color: st.autoRenewOn ? "var(--cyan)" : "var(--red)", letterSpacing: "0.04em" }}>
                  {st.autoRenewOn
                    ? "EXPIRED -- auto-renew armed: a keeper renews it from position profit (or settles if it can't pay)"
                    : "EXPIRED -- position can be settled by anyone"}
                </p>
              )}

              {/* Auto-renew arm panel */}
              {armPanelOpen && !st.autoRenewOn && !st.isMarketClosed && (
                <div
                  style={{
                    border: "1px solid rgba(0,229,255,0.2)",
                    background: "rgba(0,229,255,0.03)",
                    padding: "10px 12px",
                    maxWidth: 480,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div style={{ fontSize: "var(--fs-micro)", letterSpacing: "0.15em", color: "var(--muted)" }}>
                    ARM AUTO-RENEW — FEE CAP (USDC)
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                    <input
                      value={capInput}
                      onChange={(e) => setCapInput(e.target.value)}
                      placeholder={formatUsdc(st.suggestedCap)}
                      inputMode="decimal"
                      style={{
                        flex: 1,
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
                    <TxButton
                      idleLabel="Arm"
                      status={st.autoRenewStatus}
                      variant="cyan"
                      disabled={capValue === null}
                      onClick={() => capValue !== null && st.armAutoRenew(capValue)}
                      style={{ fontSize: "var(--fs-label)", padding: "5px 14px" }}
                    />
                    <button
                      onClick={() => setArmPanelOpen(false)}
                      style={{
                        background: "transparent",
                        border: "1px solid var(--border)",
                        color: "var(--muted)",
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--fs-label)",
                        padding: "5px 10px",
                        cursor: "pointer",
                      }}
                    >
                      Cancel
                    </button>
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
          </td>
        </tr>
      )}
    </>
  );
}
