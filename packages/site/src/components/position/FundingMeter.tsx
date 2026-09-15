import { fmtDuration } from "../../hooks/usePositionState.ts";

interface FundingMeterProps {
  /** Position size left, as a fraction of what it opened with, in bps. */
  remainingBps: bigint;
  /** This side's funding rate as a percentage of the position per day. */
  pctPerDay: number;
  /** Seconds until funding halves what is left, at the current rate. */
  halfLifeSeconds: number | null;
  /** Times the wind-down has doubled the rate. 0 while the pool is open. */
  windDownShift: bigint;
  isMarketClosed: boolean;
  /** True once anyone may sweep the husk. */
  isDust: boolean;
  /** Row layout drops the caption and tightens the padding. */
  compact?: boolean;
}

/**
 * What holding a position costs, shown as the thing that is actually happening
 * to it.
 *
 * There is no countdown here because there is no deadline. A position is never
 * renewed and never expires; funding sells a sliver of it back to the pool every
 * second, and what the holder needs to see is how much is left and how fast the
 * rest is going. The depletion bar is the whole point — it is the position, and
 * it only ever moves one way.
 *
 * The half-life is the number that makes the rate legible. "0.34 % per day" is
 * technically complete and means nothing to anyone; "half gone in 29 weeks" is
 * the same fact in a form a person can act on. Both are shown, the readable one
 * larger.
 */
export default function FundingMeter({
  remainingBps,
  pctPerDay,
  halfLifeSeconds,
  windDownShift,
  isMarketClosed,
  isDust,
  compact = false,
}: FundingMeterProps) {
  const pct = Number(remainingBps) / 100;
  const winding = isMarketClosed && windDownShift > 0n;

  // Three states, and the colour is the only thing that says which: healthy
  // decay is the market working as intended, a wind-down is the LP pulling out
  // and the rate doubling under you, dust is over.
  const accent = isDust
    ? "var(--red)"
    : winding
    ? "var(--orange)"
    : "var(--cyan)";
  const tint = isDust
    ? "rgba(255,59,48,0.08)"
    : winding
    ? "rgba(255,140,0,0.08)"
    : "rgba(0,229,255,0.04)";
  const edge = isDust
    ? "rgba(255,59,48,0.25)"
    : winding
    ? "rgba(255,140,0,0.25)"
    : "rgba(0,229,255,0.1)";

  return (
    <div
      style={{
        padding: compact ? "6px 8px" : "8px 10px",
        background: tint,
        border: `1px solid ${edge}`,
        display: "flex",
        flexDirection: "column",
        gap: compact ? 5 : 7,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <div style={{ fontSize: "var(--fs-nano)", letterSpacing: "0.15em", color: "var(--muted)" }}>
          {isDust ? "DECAYED" : "SIZE LEFT"}
        </div>
        <div
          style={{
            fontSize: "var(--fs-nano)",
            letterSpacing: "0.1em",
            color: winding ? "var(--orange)" : "var(--dim)",
            whiteSpace: "nowrap",
          }}
        >
          {winding ? `WIND-DOWN ×${(2 ** Number(windDownShift)).toLocaleString()}` : "FUNDING"}
          {" · "}
          {pctPerDay < 0.01 ? "<0.01" : pctPerDay.toFixed(2)} %/DAY
        </div>
      </div>

      {/* The bar. Segmented rather than smooth, so it reads as a quantity being
          taken rather than a progress indicator being filled. */}
      <div
        style={{
          position: "relative",
          height: 8,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          overflow: "hidden",
        }}
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Position size remaining"
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            width: `${Math.max(0, Math.min(100, pct))}%`,
            background: accent,
            opacity: 0.55,
            boxShadow: `0 0 10px ${accent}`,
            transition: "width 0.6s cubic-bezier(0.2, 0, 0, 1)",
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "repeating-linear-gradient(90deg, transparent 0 5px, var(--bg) 5px 6px)",
            opacity: 0.8,
            pointerEvents: "none",
          }}
        />
      </div>

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <div
          style={{
            fontSize: compact ? "0.72rem" : "0.82rem",
            fontWeight: 600,
            letterSpacing: "0.06em",
            color: accent,
          }}
        >
          {pct >= 99.95 ? "100" : pct.toFixed(pct < 10 ? 2 : 1)}%
        </div>
        {!compact && halfLifeSeconds !== null && !isDust && (
          <div style={{ fontSize: "var(--fs-nano)", color: "var(--dim)", letterSpacing: "0.06em" }}>
            HALF GONE IN {fmtDuration(halfLifeSeconds).toUpperCase()}
          </div>
        )}
      </div>

      {!compact && isDust && (
        <p style={{ fontSize: "var(--fs-micro)", color: "var(--red)", letterSpacing: "0.04em", margin: 0 }}>
          Funding has taken all but a rounding error. Anyone can clear the husk
          now; there is nothing left to close for.
        </p>
      )}
    </div>
  );
}
