import { useState, useMemo } from "react";

// ─── Fake data generators (fallback when indexer has no data) ────────────────

let chartIdCounter = 0;

function nextSeed(s: number): number {
  return ((s * 1664525) + 1013904223) | 0;
}

function generateFakeSpotPath(poolAddr: string, n: number): number[] {
  let seed = 5381;
  for (let i = 0; i < poolAddr.length; i++) {
    seed = (((seed << 5) + seed) + poolAddr.charCodeAt(i)) | 0;
  }
  seed = Math.abs(seed) || 1;
  const pts: number[] = [];
  let v = 0.4 + ((seed & 0xFF) / 255) * 0.2;
  for (let i = 0; i < n; i++) {
    seed = nextSeed(seed);
    const delta = (((seed >>> 0) & 0xFF) / 255 - 0.5) * 0.05;
    v = Math.max(0.15, Math.min(0.85, v + delta));
    pts.push(v);
  }
  return pts;
}

function deriveFakeLines(spotPts: number[], poolAddr: string) {
  let seed = 5381;
  const tag = poolAddr + "_spread";
  for (let i = 0; i < tag.length; i++) {
    seed = (((seed << 5) + seed) + tag.charCodeAt(i)) | 0;
  }
  seed = Math.abs(seed) || 1;
  const n = spotPts.length;
  const longPts: number[] = [];
  const shortPts: number[] = [];
  for (let i = 0; i < n; i++) {
    seed = nextSeed(seed);
    const t = i / (n - 1);
    const maxSpread = 0.05 + (((seed >>> 0) & 0xFF) / 255) * 0.07;
    const spread = i === 0 ? 0 : maxSpread * Math.log(1 + t * 9) / Math.log(10);
    longPts.push(Math.max(0.02, spotPts[i] - spread));
    shortPts.push(Math.min(0.98, spotPts[i] + spread));
  }
  return { longPts, shortPts };
}

// ─── Normalize real price data to 0–1 range ─────────────────────────────────

function normalizePrices(
  prices: { spot: bigint; long: bigint; short: bigint }[],
  n: number
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
      const lo = Math.floor(t);
      const hi = Math.min(lo + 1, vals.length - 1);
      const frac = t - lo;
      out.push(vals[lo] * (1 - frac) + vals[hi] * frac);
    }
    return out;
  };

  const spotRaw = prices.map((p) => normalize(p.spot));
  const longRaw = prices.map((p) => normalize(p.long));
  const shortRaw = prices.map((p) => normalize(p.short));

  return {
    spotPts: resample(spotRaw.map((v) => 1 - v)),
    longPts: resample(longRaw.map((v) => 1 - v)),
    shortPts: resample(shortRaw.map((v) => 1 - v)),
  };
}

// ─── Price Chart ─────────────────────────────────────────────────────────────

export default function PriceChart({
  poolAddress,
  height = 380,
  highlightLine,
  priceData,
  spotLabel,
  longLabel,
  shortLabel,
}: {
  poolAddress: string;
  height?: number;
  highlightLine?: "long" | "short" | null;
  priceData?: { spot: bigint; long: bigint; short: bigint }[];
  spotLabel?: string;
  longLabel?: string;
  shortLabel?: string;
}) {
  const W = 400;
  const H = height;
  const N = 80;
  const TOP_PAD = 0.28;

  const [clipId] = useState(() => `chart-clip-${++chartIdCounter}`);

  const hasRealData = priceData && priceData.length >= 2;

  const { spotPts, longPts, shortPts } = useMemo(() => {
    if (hasRealData) {
      return normalizePrices(priceData!, N);
    }
    const fakeSpot = generateFakeSpotPath(poolAddress, N);
    const { longPts, shortPts } = deriveFakeLines(fakeSpot, poolAddress);
    return { spotPts: fakeSpot, longPts, shortPts };
  }, [hasRealData, priceData, poolAddress]);

  const toSvg = (pts: number[]) =>
    pts.map((x, i) => ({
      x: x * W,
      y: H - (i / (N - 1)) * H * (1 - TOP_PAD),
    }));

  const spotSvg  = useMemo(() => toSvg(spotPts),  [spotPts, W, H, N, TOP_PAD]);
  const longSvg  = useMemo(() => toSvg(longPts),  [longPts, W, H, N, TOP_PAD]);
  const shortSvg = useMemo(() => toSvg(shortPts), [shortPts, W, H, N, TOP_PAD]);

  const toPath = (pts: { x: number; y: number }[]) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("");

  const spotPath  = toPath(spotSvg);
  const longPath  = toPath(longSvg);
  const shortPath = toPath(shortSvg);

  const longFill =
    longSvg.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") +
    " " + [...spotSvg].reverse().map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") + " Z";
  const shortFill =
    spotSvg.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") +
    " " + [...shortSvg].reverse().map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") + " Z";

  const longEnd  = longSvg[longSvg.length - 1];
  const shortEnd = shortSvg[shortSvg.length - 1];

  const pathLen = useMemo(() => {
    let len = 0;
    for (let i = 1; i < spotSvg.length; i++) {
      const dx = spotSvg[i].x - spotSvg[i - 1].x;
      const dy = spotSvg[i].y - spotSvg[i - 1].y;
      len += Math.sqrt(dx * dx + dy * dy);
    }
    return Math.ceil(len);
  }, [spotSvg]);

  const DUR = "3.5s";
  const DOT_DUR = "3.5s";
  const LABEL_BEGIN = "1.5s";
  const DOT_END_BEGIN = "3.2s";

  const toMotionValues = (pts: { x: number; y: number }[]) => ({
    xValues: pts.map((p) => p.x.toFixed(1)).join(";"),
    yValues: pts.map((p) => p.y.toFixed(1)).join(";"),
    keyTimes: pts.map((_, i) => (i / (pts.length - 1)).toFixed(4)).join(";"),
  });

  const longMotion = useMemo(() => toMotionValues(longSvg), [longSvg]);
  const shortMotion = useMemo(() => toMotionValues(shortSvg), [shortSvg]);

  const glowId = clipId + "-glow";

  const longHighlight  = highlightLine === "long";
  const shortHighlight = highlightLine === "short";
  const longPulse  = !highlightLine || highlightLine === "long";
  const shortPulse = !highlightLine || highlightLine === "short";

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}
      preserveAspectRatio="none"
    >
      <defs>
        <clipPath id={clipId}>
          <rect x="0" y="0" width={W} height={H}>
            <animate attributeName="y" from={H} to="0" dur={DUR} fill="freeze"
              calcMode="spline" keySplines="0.22 0.1 0.25 1" keyTimes="0;1" />
            <animate attributeName="height" from="0" to={H} dur={DUR} fill="freeze"
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
        <filter id={`${glowId}-green-wide`} x="-150%" y="-150%" width="400%" height="400%">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feFlood floodColor="#00ff88" floodOpacity="0.6" />
          <feComposite in2="blur" operator="in" />
          <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id={`${glowId}-red-wide`} x="-150%" y="-150%" width="400%" height="400%">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feFlood floodColor="#ff3b30" floodOpacity="0.6" />
          <feComposite in2="blur" operator="in" />
          <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* Horizontal grid */}
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={0} y1={f * H} x2={W} y2={f * H}
          stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
      ))}

      {/* Background fills */}
      <path d={longFill}  fill={longHighlight ? "rgba(0,255,136,0.12)" : "rgba(0,255,136,0.06)"}
        style={{ transition: "fill 0.3s" }} />
      <path d={shortFill} fill={shortHighlight ? "rgba(255,59,48,0.12)" : "rgba(255,59,48,0.06)"}
        style={{ transition: "fill 0.3s" }} />

      {/* Animated lines — clipped to grow from bottom */}
      <g clipPath={`url(#${clipId})`}>
        <path d={longPath}
          stroke={longHighlight ? "rgba(0,255,136,0.85)" : "rgba(0,255,136,0.45)"}
          strokeWidth={longHighlight ? 2.5 : 1.5} fill="none"
          strokeLinejoin="round" strokeLinecap="round"
          filter={longHighlight ? `url(#${glowId}-green-wide)` : undefined}
          style={{ transition: "stroke 0.3s, stroke-width 0.3s" }}
          strokeDasharray={pathLen * 2} strokeDashoffset={pathLen * 2}>
          <animate attributeName="stroke-dashoffset" from={pathLen * 2} to="0"
            dur={DUR} fill="freeze" calcMode="spline"
            keySplines="0.22 0.1 0.25 1" keyTimes="0;1" />
        </path>

        <path d={shortPath}
          stroke={shortHighlight ? "rgba(255,59,48,0.85)" : "rgba(255,59,48,0.45)"}
          strokeWidth={shortHighlight ? 2.5 : 1.5} fill="none"
          strokeLinejoin="round" strokeLinecap="round"
          filter={shortHighlight ? `url(#${glowId}-red-wide)` : undefined}
          style={{ transition: "stroke 0.3s, stroke-width 0.3s" }}
          strokeDasharray={pathLen * 2} strokeDashoffset={pathLen * 2}>
          <animate attributeName="stroke-dashoffset" from={pathLen * 2} to="0"
            dur={DUR} fill="freeze" calcMode="spline"
            keySplines="0.22 0.1 0.25 1" keyTimes="0;1" />
        </path>

        <path d={spotPath}
          stroke="rgba(170,170,170,0.55)" strokeWidth="2" fill="none"
          strokeLinejoin="round" strokeLinecap="round"
          strokeDasharray={pathLen * 2} strokeDashoffset={pathLen * 2}>
          <animate attributeName="stroke-dashoffset" from={pathLen * 2} to="0"
            dur={DUR} fill="freeze" calcMode="spline"
            keySplines="0.22 0.1 0.25 1" keyTimes="0;1" />
        </path>
      </g>

      {/* Burning dots traveling along long & short paths */}
      <circle r={5} fill="#00ff88" filter={`url(#${glowId}-green)`} opacity="0">
        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.02;0.92;1" dur={DOT_DUR} fill="freeze" />
        <animate attributeName="cx" values={longMotion.xValues}
          keyTimes={longMotion.keyTimes} dur={DOT_DUR} fill="freeze" calcMode="linear" />
        <animate attributeName="cy" values={longMotion.yValues}
          keyTimes={longMotion.keyTimes} dur={DOT_DUR} fill="freeze" calcMode="linear" />
      </circle>
      <circle r={12} fill="#00ff88" opacity="0">
        <animate attributeName="opacity" values="0;0.15;0.15;0" keyTimes="0;0.02;0.92;1" dur={DOT_DUR} fill="freeze" />
        <animate attributeName="cx" values={longMotion.xValues}
          keyTimes={longMotion.keyTimes} dur={DOT_DUR} fill="freeze" calcMode="linear" />
        <animate attributeName="cy" values={longMotion.yValues}
          keyTimes={longMotion.keyTimes} dur={DOT_DUR} fill="freeze" calcMode="linear" />
      </circle>

      <circle r={5} fill="#ff3b30" filter={`url(#${glowId}-red)`} opacity="0">
        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.02;0.92;1" dur={DOT_DUR} fill="freeze" />
        <animate attributeName="cx" values={shortMotion.xValues}
          keyTimes={shortMotion.keyTimes} dur={DOT_DUR} fill="freeze" calcMode="linear" />
        <animate attributeName="cy" values={shortMotion.yValues}
          keyTimes={shortMotion.keyTimes} dur={DOT_DUR} fill="freeze" calcMode="linear" />
      </circle>
      <circle r={12} fill="#ff3b30" opacity="0">
        <animate attributeName="opacity" values="0;0.15;0.15;0" keyTimes="0;0.02;0.92;1" dur={DOT_DUR} fill="freeze" />
        <animate attributeName="cx" values={shortMotion.xValues}
          keyTimes={shortMotion.keyTimes} dur={DOT_DUR} fill="freeze" calcMode="linear" />
        <animate attributeName="cy" values={shortMotion.yValues}
          keyTimes={shortMotion.keyTimes} dur={DOT_DUR} fill="freeze" calcMode="linear" />
      </circle>

      {/* End dots */}
      {longPulse ? (
        <g key="long-pulse">
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
        <circle key="long-calm" cx={longEnd.x} cy={longEnd.y} r={4} fill="#00ff88" opacity="0">
          <animate attributeName="opacity" from="0" to="0.5" begin={DOT_END_BEGIN} dur="0.3s" fill="freeze" />
        </circle>
      )}

      {shortPulse ? (
        <g key="short-pulse">
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
        <circle key="short-calm" cx={shortEnd.x} cy={shortEnd.y} r={4} fill="#ff3b30" opacity="0">
          <animate attributeName="opacity" from="0" to="0.5" begin={DOT_END_BEGIN} dur="0.3s" fill="freeze" />
        </circle>
      )}

      {/* Fixed price labels — LONG left, SPOT center, SHORT right — just above chart */}
      {(() => {
        const labelY = H * TOP_PAD - 6;
        const nameY  = labelY - 12;
        return (
          <>
            <text x={W * 0.15} y={nameY} textAnchor="middle"
              fill="#00ff88" fontSize="8" fontFamily="var(--font-mono)" fontWeight="600" opacity="0">
              LONG
              <animate attributeName="opacity" from="0" to="0.6" begin={LABEL_BEGIN} dur="0.4s" fill="freeze" />
            </text>
            <text x={W * 0.15} y={labelY} textAnchor="middle"
              fill="#00ff88" fontSize="12" fontFamily="var(--font-mono)" fontWeight="700" opacity="0">
              {longLabel ?? "—"}
              <animate attributeName="opacity" from="0" to="1" begin={LABEL_BEGIN} dur="0.4s" fill="freeze" />
            </text>

            <text x={W * 0.5} y={nameY} textAnchor="middle"
              fill="#aaaaaa" fontSize="8" fontFamily="var(--font-mono)" fontWeight="600" opacity="0">
              SPOT
              <animate attributeName="opacity" from="0" to="0.6" begin={LABEL_BEGIN} dur="0.4s" fill="freeze" />
            </text>
            <text x={W * 0.5} y={labelY} textAnchor="middle"
              fill="#aaaaaa" fontSize="12" fontFamily="var(--font-mono)" fontWeight="700" opacity="0">
              {spotLabel ?? "—"}
              <animate attributeName="opacity" from="0" to="1" begin={LABEL_BEGIN} dur="0.4s" fill="freeze" />
            </text>

            <text x={W * 0.85} y={nameY} textAnchor="middle"
              fill="#ff3b30" fontSize="8" fontFamily="var(--font-mono)" fontWeight="600" opacity="0">
              SHORT
              <animate attributeName="opacity" from="0" to="0.6" begin={LABEL_BEGIN} dur="0.4s" fill="freeze" />
            </text>
            <text x={W * 0.85} y={labelY} textAnchor="middle"
              fill="#ff3b30" fontSize="12" fontFamily="var(--font-mono)" fontWeight="700" opacity="0">
              {shortLabel ?? "—"}
              <animate attributeName="opacity" from="0" to="1" begin={LABEL_BEGIN} dur="0.4s" fill="freeze" />
            </text>
          </>
        );
      })()}
    </svg>
  );
}
