import { useState, useMemo } from "react";

/**
 * Horizontal price chart for the pool detail page.
 * X-axis = time (left→right), Y-axis = price (bottom→top).
 * Shows spot (grey), long (green), and short (red) lines with
 * animated draw-in, glowing dots, and filled regions.
 */

let chartIdCounter = 0;

// ─── Deterministic fake data (fallback when indexer has no data) ─────────────

function nextSeed(s: number): number {
  return ((s * 1664525) + 1013904223) | 0;
}

function generateFakePath(poolAddr: string, n: number): number[] {
  let seed = 5381;
  for (let i = 0; i < poolAddr.length; i++)
    seed = (((seed << 5) + seed) + poolAddr.charCodeAt(i)) | 0;
  seed = Math.abs(seed) || 1;
  const pts: number[] = [];
  let v = 0.4 + ((seed & 0xFF) / 255) * 0.2;
  for (let i = 0; i < n; i++) {
    seed = nextSeed(seed);
    v = Math.max(0.1, Math.min(0.9, v + (((seed >>> 0) & 0xFF) / 255 - 0.5) * 0.05));
    pts.push(v);
  }
  return pts;
}

function deriveFakeLines(spotPts: number[], poolAddr: string) {
  let seed = 5381;
  const tag = poolAddr + "_spread";
  for (let i = 0; i < tag.length; i++)
    seed = (((seed << 5) + seed) + tag.charCodeAt(i)) | 0;
  seed = Math.abs(seed) || 1;
  const n = spotPts.length;
  const longPts: number[] = [];
  const shortPts: number[] = [];
  for (let i = 0; i < n; i++) {
    seed = nextSeed(seed);
    const t = i / (n - 1);
    const maxSpread = 0.05 + (((seed >>> 0) & 0xFF) / 255) * 0.07;
    const spread = i === 0 ? 0 : maxSpread * Math.log(1 + t * 9) / Math.log(10);
    longPts.push(Math.min(0.98, spotPts[i] + spread));
    shortPts.push(Math.max(0.02, spotPts[i] - spread));
  }
  return { longPts, shortPts };
}

// ─── Normalize real price data to 0–1 ───────────────────────────────────────

function normalizePrices(
  prices: { spot: bigint; long: bigint; short: bigint }[],
  n: number,
): { spotPts: number[]; longPts: number[]; shortPts: number[] } {
  if (prices.length === 0) return { spotPts: [], longPts: [], shortPts: [] };

  let min = prices[0].short;
  let max = prices[0].long;
  for (const p of prices) {
    if (p.short < min) min = p.short;
    if (p.long > max) max = p.long;
    if (p.spot < min) min = p.spot;
    if (p.spot > max) max = p.spot;
  }

  const range = max - min;
  const pad = range > 0n ? range / 10n : 1n;
  const lo = min - pad;
  const hi = max + pad;
  const span = hi - lo > 0n ? hi - lo : 1n;

  const normalize = (v: bigint) => Number((v - lo) * 10000n / span) / 10000;

  const resample = (vals: number[]): number[] => {
    if (vals.length === 0) return Array(n).fill(0.5);
    if (vals.length === 1) return Array(n).fill(vals[0]);
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * (vals.length - 1);
      const a = Math.floor(t);
      const b = Math.min(a + 1, vals.length - 1);
      out.push(vals[a] * (1 - (t - a)) + vals[b] * (t - a));
    }
    return out;
  };

  return {
    spotPts: resample(prices.map((p) => normalize(p.spot))),
    longPts: resample(prices.map((p) => normalize(p.long))),
    shortPts: resample(prices.map((p) => normalize(p.short))),
  };
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function PoolPriceChart({
  poolAddress,
  priceData,
  highlightLine,
  spotLabel,
  longLabel,
  shortLabel,
}: {
  poolAddress: string;
  priceData?: { spot: bigint; long: bigint; short: bigint }[];
  highlightLine?: "long" | "short" | null;
  spotLabel?: string;
  longLabel?: string;
  shortLabel?: string;
}) {
  const W = 600;
  const H = 300;
  const N = 80;
  const PAD_L = 8;
  const PAD_R = 110;  // room for right-side labels
  const PAD_T = 14;
  const PAD_B = 8;

  const [clipId] = useState(() => `hchart-${++chartIdCounter}`);
  const glowId = clipId + "-g";

  const hasReal = priceData && priceData.length >= 2;

  const { spotPts, longPts, shortPts } = useMemo(() => {
    if (hasReal) return normalizePrices(priceData!, N);
    const fakeSpot = generateFakePath(poolAddress, N);
    const { longPts, shortPts } = deriveFakeLines(fakeSpot, poolAddress);
    return { spotPts: fakeSpot, longPts, shortPts };
  }, [hasReal, priceData, poolAddress]);

  // Map normalized [0,1] to SVG coords: x = time (left→right), y = price (bottom→top)
  const toSvg = (pts: number[]) =>
    pts.map((y, i) => ({
      x: PAD_L + (i / (N - 1)) * (W - PAD_L - PAD_R),
      y: PAD_T + (1 - y) * (H - PAD_T - PAD_B),
    }));

  const spotSvg  = useMemo(() => toSvg(spotPts),  [spotPts]);
  const longSvg  = useMemo(() => toSvg(longPts),  [longPts]);
  const shortSvg = useMemo(() => toSvg(shortPts), [shortPts]);

  const toPath = (pts: { x: number; y: number }[]) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("");

  const spotPath  = toPath(spotSvg);
  const longPath  = toPath(longSvg);
  const shortPath = toPath(shortSvg);

  // Filled regions between lines
  const longFill =
    longSvg.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") +
    " " + [...spotSvg].reverse().map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") + " Z";
  const shortFill =
    spotSvg.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") +
    " " + [...shortSvg].reverse().map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") + " Z";

  const spotEnd  = spotSvg[spotSvg.length - 1];
  const longEnd  = longSvg[longSvg.length - 1];
  const shortEnd = shortSvg[shortSvg.length - 1];


  const DUR = "3s";
  const DOT_DUR = "3s";
  const LABEL_BEGIN = "2.6s";
  const DOT_END_BEGIN = "2.8s";

  const toMotion = (pts: { x: number; y: number }[]) => ({
    x: pts.map((p) => p.x.toFixed(1)).join(";"),
    y: pts.map((p) => p.y.toFixed(1)).join(";"),
    t: pts.map((_, i) => (i / (pts.length - 1)).toFixed(4)).join(";"),
  });

  const longM  = useMemo(() => toMotion(longSvg),  [longSvg]);
  const shortM = useMemo(() => toMotion(shortSvg), [shortSvg]);

  const longHi  = highlightLine === "long";
  const shortHi = highlightLine === "short";
  const longPulse  = !highlightLine || highlightLine === "long";
  const shortPulse = !highlightLine || highlightLine === "short";

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        {/* Clip that reveals from left to right */}
        <clipPath id={clipId}>
          <rect x="0" y="0" width={W} height={H}>
            <animate attributeName="width" from="0" to={W} dur={DUR} fill="freeze"
              calcMode="spline" keySplines="0.22 0.1 0.25 1" keyTimes="0;1" />
          </rect>
        </clipPath>

        <filter id={`${glowId}-green`} x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feFlood floodColor="#00ff88" floodOpacity="0.8" />
          <feComposite in2="blur" operator="in" />
          <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id={`${glowId}-red`} x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feFlood floodColor="#ff3b30" floodOpacity="0.8" />
          <feComposite in2="blur" operator="in" />
          <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id={`${glowId}-green-w`} x="-150%" y="-150%" width="400%" height="400%">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feFlood floodColor="#00ff88" floodOpacity="0.6" />
          <feComposite in2="blur" operator="in" />
          <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id={`${glowId}-red-w`} x="-150%" y="-150%" width="400%" height="400%">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feFlood floodColor="#ff3b30" floodOpacity="0.6" />
          <feComposite in2="blur" operator="in" />
          <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* Horizontal grid lines */}
      {[0.25, 0.5, 0.75].map((f) => {
        const y = PAD_T + (1 - f) * (H - PAD_T - PAD_B);
        return <line key={f} x1={PAD_L} y1={y} x2={W - PAD_R} y2={y}
          stroke="rgba(255,255,255,0.04)" strokeWidth="1" />;
      })}

      {/* Background fills */}
      <path d={longFill}  fill={longHi ? "rgba(0,255,136,0.12)" : "rgba(0,255,136,0.06)"}
        style={{ transition: "fill 0.3s" }} />
      <path d={shortFill} fill={shortHi ? "rgba(255,59,48,0.12)" : "rgba(255,59,48,0.06)"}
        style={{ transition: "fill 0.3s" }} />

      {/* Animated lines — clip reveals left to right */}
      <g clipPath={`url(#${clipId})`}>
        <path d={longPath}
          stroke={longHi ? "rgba(0,255,136,0.85)" : "rgba(0,255,136,0.45)"}
          strokeWidth={longHi ? 2.5 : 1.5} fill="none"
          strokeLinejoin="round" strokeLinecap="round"
          filter={longHi ? `url(#${glowId}-green-w)` : undefined}
          style={{ transition: "stroke 0.3s, stroke-width 0.3s" }} />

        <path d={shortPath}
          stroke={shortHi ? "rgba(255,59,48,0.85)" : "rgba(255,59,48,0.45)"}
          strokeWidth={shortHi ? 2.5 : 1.5} fill="none"
          strokeLinejoin="round" strokeLinecap="round"
          filter={shortHi ? `url(#${glowId}-red-w)` : undefined}
          style={{ transition: "stroke 0.3s, stroke-width 0.3s" }} />

        <path d={spotPath}
          stroke="rgba(170,170,170,0.55)" strokeWidth="2" fill="none"
          strokeLinejoin="round" strokeLinecap="round" />
      </g>

      {/* Traveling dots */}
      <circle r={5} fill="#00ff88" filter={`url(#${glowId}-green)`} opacity="0">
        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.02;0.92;1" dur={DOT_DUR} fill="freeze" />
        <animate attributeName="cx" values={longM.x} keyTimes={longM.t} dur={DOT_DUR} fill="freeze" calcMode="linear" />
        <animate attributeName="cy" values={longM.y} keyTimes={longM.t} dur={DOT_DUR} fill="freeze" calcMode="linear" />
      </circle>
      <circle r={12} fill="#00ff88" opacity="0">
        <animate attributeName="opacity" values="0;0.15;0.15;0" keyTimes="0;0.02;0.92;1" dur={DOT_DUR} fill="freeze" />
        <animate attributeName="cx" values={longM.x} keyTimes={longM.t} dur={DOT_DUR} fill="freeze" calcMode="linear" />
        <animate attributeName="cy" values={longM.y} keyTimes={longM.t} dur={DOT_DUR} fill="freeze" calcMode="linear" />
      </circle>

      <circle r={5} fill="#ff3b30" filter={`url(#${glowId}-red)`} opacity="0">
        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.02;0.92;1" dur={DOT_DUR} fill="freeze" />
        <animate attributeName="cx" values={shortM.x} keyTimes={shortM.t} dur={DOT_DUR} fill="freeze" calcMode="linear" />
        <animate attributeName="cy" values={shortM.y} keyTimes={shortM.t} dur={DOT_DUR} fill="freeze" calcMode="linear" />
      </circle>
      <circle r={12} fill="#ff3b30" opacity="0">
        <animate attributeName="opacity" values="0;0.15;0.15;0" keyTimes="0;0.02;0.92;1" dur={DOT_DUR} fill="freeze" />
        <animate attributeName="cx" values={shortM.x} keyTimes={shortM.t} dur={DOT_DUR} fill="freeze" calcMode="linear" />
        <animate attributeName="cy" values={shortM.y} keyTimes={shortM.t} dur={DOT_DUR} fill="freeze" calcMode="linear" />
      </circle>

      {/* End dots */}
      {longPulse ? (
        <g key="lp">
          <circle cx={longEnd.x} cy={longEnd.y} r={5} fill="#00ff88" filter={`url(#${glowId}-green)`} opacity="0">
            <animate attributeName="opacity" from="0" to="1" begin={DOT_END_BEGIN} dur="0.3s" fill="freeze" />
            <animate attributeName="r" values="4;6;4" begin={DOT_END_BEGIN} dur="1.5s" repeatCount="indefinite" />
          </circle>
          <circle cx={longEnd.x} cy={longEnd.y} r={14} fill="#00ff88" opacity="0">
            <animate attributeName="opacity" values="0;0.18;0" begin={DOT_END_BEGIN} dur="1.5s" repeatCount="indefinite" />
            <animate attributeName="r" values="10;18;10" begin={DOT_END_BEGIN} dur="1.5s" repeatCount="indefinite" />
          </circle>
        </g>
      ) : (
        <circle key="lc" cx={longEnd.x} cy={longEnd.y} r={4} fill="#00ff88" opacity="0">
          <animate attributeName="opacity" from="0" to="0.5" begin={DOT_END_BEGIN} dur="0.3s" fill="freeze" />
        </circle>
      )}

      {shortPulse ? (
        <g key="sp">
          <circle cx={shortEnd.x} cy={shortEnd.y} r={5} fill="#ff3b30" filter={`url(#${glowId}-red)`} opacity="0">
            <animate attributeName="opacity" from="0" to="1" begin={DOT_END_BEGIN} dur="0.3s" fill="freeze" />
            <animate attributeName="r" values="4;6;4" begin={DOT_END_BEGIN} dur="1.5s" repeatCount="indefinite" />
          </circle>
          <circle cx={shortEnd.x} cy={shortEnd.y} r={14} fill="#ff3b30" opacity="0">
            <animate attributeName="opacity" values="0;0.18;0" begin={DOT_END_BEGIN} dur="1.5s" repeatCount="indefinite" />
            <animate attributeName="r" values="10;18;10" begin={DOT_END_BEGIN} dur="1.5s" repeatCount="indefinite" />
          </circle>
        </g>
      ) : (
        <circle key="sc" cx={shortEnd.x} cy={shortEnd.y} r={4} fill="#ff3b30" opacity="0">
          <animate attributeName="opacity" from="0" to="0.5" begin={DOT_END_BEGIN} dur="0.3s" fill="freeze" />
        </circle>
      )}

      {/* Right-side labels + prices (spread to avoid overlap) */}
      {(() => {
        // Sort by y and push apart if too close
        const items = [
          { key: "long", y: longEnd.y, color: "#00ff88", label: "LONG", price: longLabel },
          { key: "spot", y: spotEnd.y, color: "#aaaaaa", label: "SPOT", price: spotLabel },
          { key: "short", y: shortEnd.y, color: "#ff3b30", label: "SHORT", price: shortLabel },
        ].sort((a, b) => a.y - b.y);
        const minGap = 28;
        for (let pass = 0; pass < 5; pass++) {
          for (let i = 1; i < items.length; i++) {
            const gap = items[i].y - items[i - 1].y;
            if (gap < minGap) {
              const shift = (minGap - gap) / 2;
              items[i - 1].y -= shift;
              items[i].y += shift;
            }
          }
        }
        const lx = W - PAD_R + 16;
        return items.map((it) => (
          <g key={it.key}>
            <text x={lx} y={it.y - 3} textAnchor="start"
              fill={it.color} fontSize="8" fontFamily="var(--font-mono)" fontWeight="600" opacity="0">
              {it.label}
              <animate attributeName="opacity" from="0" to="0.6" begin={LABEL_BEGIN} dur="0.4s" fill="freeze" />
            </text>
            <text x={lx} y={it.y + 9} textAnchor="start"
              fill={it.color} fontSize="11" fontFamily="var(--font-mono)" fontWeight="700" opacity="0">
              {it.price ?? "—"}
              <animate attributeName="opacity" from="0" to="1" begin={LABEL_BEGIN} dur="0.4s" fill="freeze" />
            </text>
          </g>
        ));
      })()}
    </svg>
  );
}
