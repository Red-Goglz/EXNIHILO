import { useState, useMemo, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import {
  useAccount,
  useChainId,
  useReadContract,
  useReadContracts,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import {
  exnihiloFactoryAbi,
  exnihiloPoolAbi,
  exnihiloRouterAbi,
  erc20Abi,
} from "@exnihilio/abis";
import { getAddresses } from "../contracts/addresses.ts";
import { formatUsdc, formatUsdcCompact, parseUnits, formatToken } from "../lib/format.ts";
import { quoteLong, quoteShort } from "../lib/amm.ts";
import { useRouterApproval } from "../hooks/useRouterApproval.ts";
import { usePositionAlerts } from "../hooks/usePositionAlerts.ts";
import RouterApprovalModal from "../components/wallet/RouterApprovalModal.tsx";

// ─── Constants ───────────────────────────────────────────────────────────────

const POSITION_FEE_BPS = 500n;

function starRating(tvlRaw: bigint | undefined): 1 | 2 | 3 | 4 | 5 {
  if (!tvlRaw) return 1;
  const tvl = Number(tvlRaw) / 1_000_000;
  if (tvl >= 1_000_000) return 5;
  if (tvl >= 100_000)   return 4;
  if (tvl >= 10_000)    return 3;
  if (tvl >= 1_000)     return 2;
  return 1;
}

function getPresets(rating: number): [number, number, number] {
  if (rating <= 1) return [1, 2, 5];
  if (rating === 2) return [5, 10, 25];
  return [10, 50, 200];
}

// ─── Animated 3-line price chart ─────────────────────────────────────────────

let chartIdCounter = 0;

function nextSeed(s: number): number {
  return ((s * 1664525) + 1013904223) | 0;
}

/** Generate N price points as 0–1 x-values, seeded by pool address. */
function generateSpotPath(poolAddr: string, n: number): number[] {
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

/**
 * Derive long/short from spot so the invariant always holds:
 *   long price >= spot price >= short price
 * The spread varies per-point using a seeded wobble (3–8% offset).
 */
function deriveLines(spotPts: number[], poolAddr: string) {
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
    const t = i / (n - 1); // 0 at start (bottom), 1 at end (top)
    const maxSpread = 0.05 + (((seed >>> 0) & 0xFF) / 255) * 0.07; // 5–12%
    // Logarithmic: big jump early, flattens out
    const spread = i === 0 ? 0 : maxSpread * Math.log(1 + t * 9) / Math.log(10);
    longPts.push(Math.max(0.02, spotPts[i] - spread));
    shortPts.push(Math.min(0.98, spotPts[i] + spread));
  }
  return { longPts, shortPts };
}

function PriceChart({
  poolAddress,
  height = 380,
  highlightLine,
}: {
  poolAddress: string;
  height?: number;
  highlightLine?: "long" | "short" | null;
}) {
  const W = 400;
  const H = height;
  const N = 80;
  const TOP_PAD = 0.28; // stop lines at 28% from top (room for token overlay)

  const [clipId] = useState(() => `chart-clip-${++chartIdCounter}`);

  const spotPts = useMemo(() => generateSpotPath(poolAddress, N), [poolAddress]);
  const { longPts, shortPts } = useMemo(() => deriveLines(spotPts, poolAddress), [spotPts, poolAddress]);

  // x-value maps to horizontal position; y = time (bottom=old, top=new)
  // Lines run from y=H (bottom) to y=H*TOP_PAD (below token overlay)
  const toSvg = (pts: number[]) =>
    pts.map((x, i) => ({
      x: x * W,
      y: H - (i / (N - 1)) * H * (1 - TOP_PAD),
    }));

  const spotSvg  = useMemo(() => toSvg(spotPts),  [spotPts]);
  const longSvg  = useMemo(() => toSvg(longPts),  [longPts]);
  const shortSvg = useMemo(() => toSvg(shortPts), [shortPts]);

  const toPath = (pts: { x: number; y: number }[]) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("");

  const spotPath  = toPath(spotSvg);
  const longPath  = toPath(longSvg);
  const shortPath = toPath(shortSvg);

  // Fill between long and spot (green), and between spot and short (red)
  const longFill =
    longSvg.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") +
    " " + [...spotSvg].reverse().map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") + " Z";
  const shortFill =
    spotSvg.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") +
    " " + [...shortSvg].reverse().map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") + " Z";

  const spotEnd  = spotSvg[spotSvg.length - 1];
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
  const LABEL_BEGIN = "3s";
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

        {/* Glow filters */}
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
        {/* Wider glow for hover highlight */}
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

      {/* Background fills — always visible */}
      <path d={longFill}  fill={longHighlight ? "rgba(0,255,136,0.12)" : "rgba(0,255,136,0.06)"}
        style={{ transition: "fill 0.3s" }} />
      <path d={shortFill} fill={shortHighlight ? "rgba(255,59,48,0.12)" : "rgba(255,59,48,0.06)"}
        style={{ transition: "fill 0.3s" }} />

      {/* Animated lines — clipped to grow from bottom */}
      <g clipPath={`url(#${clipId})`}>
        {/* Long price line */}
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

        {/* Short price line */}
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

        {/* Spot price line */}
        <path d={spotPath}
          stroke="rgba(170,170,170,0.55)" strokeWidth="2" fill="none"
          strokeLinejoin="round" strokeLinecap="round"
          strokeDasharray={pathLen * 2} strokeDashoffset={pathLen * 2}>
          <animate attributeName="stroke-dashoffset" from={pathLen * 2} to="0"
            dur={DUR} fill="freeze" calcMode="spline"
            keySplines="0.22 0.1 0.25 1" keyTimes="0;1" />
        </path>
      </g>

      {/* ── Burning dots traveling along long & short paths ── */}

      {/* Long burning dot */}
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

      {/* Short burning dot */}
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

      {/* ── End dots ── */}
      {/* Long: pulsing when no hover or hovering long; calm when hovering short */}
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

      {/* Short: pulsing when no hover or hovering short; calm when hovering long */}
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

      {/* ── Labels ── */}
      <text x={spotEnd.x} y={spotEnd.y - 12} textAnchor="middle"
        fill="#aaaaaa" fontSize="10" fontFamily="var(--font-mono)" fontWeight="600" opacity="0">
        SPOT
        <animate attributeName="opacity" from="0" to="0.9" begin={LABEL_BEGIN} dur="0.4s" fill="freeze" />
      </text>
      <text x={longEnd.x} y={longEnd.y - 10} textAnchor="middle"
        fill="#00ff88" fontSize="9" fontFamily="var(--font-mono)" fontWeight="600" opacity="0">
        LONG
        <animate attributeName="opacity" from="0" to="0.8" begin={LABEL_BEGIN} dur="0.4s" fill="freeze" />
      </text>
      <text x={shortEnd.x} y={shortEnd.y - 10} textAnchor="middle"
        fill="#ff3b30" fontSize="9" fontFamily="var(--font-mono)" fontWeight="600" opacity="0">
        SHORT
        <animate attributeName="opacity" from="0" to="0.8" begin={LABEL_BEGIN} dur="0.4s" fill="freeze" />
      </text>
    </svg>
  );
}

// ─── Sound effects (Web Audio API, no files) ────────────────────────────────

function playSubmittedSound() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(300, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(80, ctx.currentTime + 0.5);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  } catch { /* audio not available */ }
}

function playMinedSound() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    // Ascending whoosh (inverse of submitted)
    osc.frequency.setValueAtTime(80, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(400, ctx.currentTime + 0.5);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  } catch { /* audio not available */ }
}

// ─── Tron scene (rendered after chart tilts away) ────────────────────────────

function TronScene({
  phase,
  side,
  onComplete,
}: {
  phase: "submitted" | "mined";
  side: "long" | "short";
  onComplete?: () => void;
}) {
  const color = side === "long" ? "#00ff88" : "#ff3b30";
  const colorDim = side === "long" ? "rgba(0,255,136,0.15)" : "rgba(255,59,48,0.15)";

  // Play sounds
  useEffect(() => { playSubmittedSound(); }, []);
  useEffect(() => { if (phase === "mined") playMinedSound(); }, [phase]);

  // Staged reveal: text → grid → orb (each flag independent)
  const [showText, setShowText] = useState(false);
  const [showGrid, setShowGrid] = useState(false);
  const [showOrb, setShowOrb]   = useState(false);
  useEffect(() => {
    const t1 = setTimeout(() => setShowText(true), 1400);
    const t2 = setTimeout(() => setShowGrid(true), 1800);
    const t3 = setTimeout(() => setShowOrb(true),  2600);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);

  // Orb pulsing via state toggle
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (!showOrb || phase === "mined") return;
    const id = setInterval(() => setPulse((p) => !p), 750);
    return () => clearInterval(id);
  }, [showOrb, phase]);

  // Mined: grid rushes to horizon, orb fades
  const [launched, setLaunched] = useState(false);
  const [showMined, setShowMined] = useState(false);
  const [minedPulse, setMinedPulse] = useState(false);
  useEffect(() => {
    if (phase !== "mined") return;
    setLaunched(true);
    const t1 = setTimeout(() => setShowMined(true), 1000);
    // Auto-advance after 3s
    const t2 = setTimeout(() => onComplete?.(), 3000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [phase, onComplete]);
  // Pulse the "POSITION OPENED" text
  useEffect(() => {
    if (!showMined) return;
    const id = setInterval(() => setMinedPulse((p) => !p), 600);
    return () => clearInterval(id);
  }, [showMined]);

  return (
    <>
      {/* Grid floor — rushes to horizon on mined */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: "-50%",
          width: "200%",
          height: "300%",
          transformOrigin: "center bottom",
          transform: launched ? "rotateX(72deg) scaleY(3)" : "rotateX(72deg)",
          backgroundImage: `
            linear-gradient(${colorDim} 1px, transparent 1px),
            linear-gradient(90deg, ${colorDim} 1px, transparent 1px)
          `,
          backgroundSize: launched ? "40px 10px" : "40px 40px",
          opacity: launched ? 0 : showGrid ? 1 : 0,
          transition: launched
            ? "transform 1.4s cubic-bezier(0.3, 0, 0.9, 0.3), background-size 1.4s cubic-bezier(0.3, 0, 0.9, 0.3), opacity 0.4s 1.2s ease-in"
            : "opacity 0.5s ease-out",
        }}
      />


      {/* Glowing orb — stays in center, pulses, brightens on mined */}
      <div
        style={{
          position: "absolute",
          bottom: "24%",
          left: "50%",
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: `radial-gradient(circle at 40% 35%, #fff, ${color})`,
          boxShadow: `0 0 ${pulse ? 30 : 20}px ${color}, 0 0 ${pulse ? 60 : 40}px ${color}`,
          transform: `translateX(-50%) scale(${launched ? 1 : showOrb ? (pulse ? 1.12 : 1) : 0.05})`,
          opacity: launched ? 0 : showOrb ? 1 : 0,
          transition: launched
            ? "opacity 1.5s ease-out"
            : "transform 0.8s ease-out, opacity 0.4s ease-out, box-shadow 0.75s ease-in-out",
        }}
      />


      {/* Status text */}
      {/* Pending text */}
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 0,
          right: 0,
          textAlign: "center",
          fontFamily: "var(--font-mono)",
          fontSize: "0.62rem",
          letterSpacing: "0.2em",
          color,
          textShadow: `0 0 10px ${color}`,
          opacity: showText && !launched ? 1 : 0,
          transform: showText ? "translateY(0)" : "translateY(8px)",
          transition: launched ? "opacity 0.1s" : "opacity 0.4s ease-out, transform 0.4s ease-out",
        }}
      >
        TRANSACTION PENDING<span className="cursor-blink">_</span>
      </div>

      {/* Mined text — fades in with glow pulse */}
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 0,
          right: 0,
          textAlign: "center",
          fontFamily: "var(--font-mono)",
          fontSize: "0.72rem",
          letterSpacing: "0.25em",
          fontWeight: 700,
          color: "#fff",
          textShadow: minedPulse
            ? `0 0 20px ${color}, 0 0 40px ${color}, 0 0 60px ${color}`
            : `0 0 10px ${color}, 0 0 20px ${color}`,
          opacity: showMined ? 1 : 0,
          transform: showMined ? "translateY(0) scale(1)" : "translateY(4px) scale(0.95)",
          transition: "opacity 0.6s ease-out, transform 0.6s ease-out, text-shadow 0.6s ease-in-out",
        }}
      >
        POSITION OPENED
      </div>
    </>
  );
}

// ─── Feed Card ────────────────────────────────────────────────────────────────

const CHART_HEIGHT = 380;

interface FeedCardProps {
  poolAddress: `0x${string}`;
  symbol: string;
  tokenDecimals: number;
  underlyingUsdc: `0x${string}`;
  backedAirToken: bigint | undefined;
  backedAirUsd: bigint | undefined;
  rating: 1 | 2 | 3 | 4 | 5;
  onAdvance: () => void;
}

function FeedCard({
  poolAddress,
  symbol,
  tokenDecimals,
  underlyingUsdc,
  backedAirToken,
  backedAirUsd,
  rating,
  onAdvance,
}: FeedCardProps) {
  const { address } = useAccount();
  const queryClient = useQueryClient();
  const { addAlert } = usePositionAlerts();

  const [direction, setDirection] = useState<"long" | "short" | null>(null);
  const [txPhase, setTxPhase] = useState<"idle" | "submitted" | "mined">("idle");
  const [txSide, setTxSide]   = useState<"long" | "short">("long");
  const [preset, setPreset]       = useState<number | null>(null);
  const [customLong, setCustomLong] = useState("");
  const [customShort, setCustomShort] = useState("");

  const presets = getPresets(rating);

  const isCustomLong  = direction === "long"  && preset === null && customLong  !== "";
  const isCustomShort = direction === "short" && preset === null && customShort !== "";
  const amountStr = isCustomLong ? customLong : isCustomShort ? customShort : preset !== null ? String(preset) : "";
  const usdcRaw   = parseUnits(amountStr, 6);
  const feePulled = (usdcRaw * POSITION_FEE_BPS) / 10_000n;

  // Price / TVL
  const priceRaw =
    backedAirToken !== undefined && backedAirToken > 0n && backedAirUsd !== undefined
      ? (backedAirUsd * 10n ** BigInt(tokenDecimals)) / backedAirToken
      : undefined;
  const tokenValueRaw =
    backedAirToken !== undefined && priceRaw !== undefined
      ? (backedAirToken * priceRaw) / 10n ** BigInt(tokenDecimals)
      : undefined;
  const totalTvlRaw =
    tokenValueRaw !== undefined && backedAirUsd !== undefined
      ? tokenValueRaw + backedAirUsd
      : undefined;

  const priceDisplay = priceRaw !== undefined ? formatUsdc(priceRaw) : "—";
  const tvlDisplay   = totalTvlRaw !== undefined ? formatUsdcCompact(totalTvlRaw) : "—";

  // (chart data is self-contained in PriceChart)

  // Always load pool trading data for hover previews
  const poolContract = { address: poolAddress, abi: exnihiloPoolAbi } as const;

  const { data: poolData } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "swapFeeBps" },
      { ...poolContract, functionName: "airToken" },
      { ...poolContract, functionName: "airUsdToken" },
    ],
  });

  const swapFeeBps   = poolData?.[0]?.result as bigint | undefined;
  const airTokenAddr = poolData?.[1]?.result as `0x${string}` | undefined;
  const airUsdAddr   = poolData?.[2]?.result as `0x${string}` | undefined;

  // Allowance — only needed after direction is picked
  const { data: allowanceData } = useReadContracts({
    contracts: [
      {
        address: underlyingUsdc,
        abi: erc20Abi,
        functionName: "allowance" as const,
        args: [address ?? "0x0000000000000000000000000000000000000000", poolAddress] as const,
      },
    ],
    query: { enabled: !!direction && !!address },
  });
  const allowance = allowanceData?.[0]?.result as bigint | undefined;

  const { data: supplyData } = useReadContracts({
    contracts:
      airTokenAddr && airUsdAddr
        ? [
            { address: airTokenAddr, abi: erc20Abi, functionName: "totalSupply" as const },
            { address: airUsdAddr,  abi: erc20Abi, functionName: "totalSupply" as const },
          ]
        : [],
    query: { enabled: !!airTokenAddr && !!airUsdAddr },
  });

  const airTokenTotalSupply = supplyData?.[0]?.result as bigint | undefined;
  const airUsdTotalSupply  = supplyData?.[1]?.result as bigint | undefined;

  // Preview helper: compute estimated output for any direction + USDC amount
  const canPreview =
    backedAirToken !== undefined && backedAirUsd !== undefined &&
    airTokenTotalSupply !== undefined && airUsdTotalSupply !== undefined &&
    swapFeeBps !== undefined;

  function computePreview(dir: "long" | "short", rawUsdc: bigint) {
    if (!canPreview || rawUsdc === 0n) return undefined;
    return dir === "long"
      ? quoteLong(rawUsdc, airUsdTotalSupply!, backedAirToken!, swapFeeBps!)
      : quoteShort(rawUsdc, airTokenTotalSupply!, backedAirUsd!, swapFeeBps!);
  }

  // Hover state: which side is hovered (for chart highlight + preview)
  const [hoverSide, setHoverSide] = useState<"long" | "short" | null>(null);
  const [hoverPreview, setHoverPreview] = useState<{ dir: "long" | "short"; amount: number } | null>(null);

  // Display values: use hover data as preview, selected data as committed
  const showDir   = direction ?? hoverPreview?.dir ?? null;
  const showUsdc  = direction !== null && usdcRaw > 0n ? usdcRaw : hoverPreview ? parseUnits(String(hoverPreview.amount), 6) : 0n;
  const showFee   = (showUsdc * POSITION_FEE_BPS) / 10_000n;
  const showOut   = showDir && showUsdc > 0n ? computePreview(showDir, showUsdc) : undefined;
  const isHoverOnly = direction === null && hoverPreview !== null;
  const showConfirm = showDir !== null; // show section whenever a direction is known (selected or hovered)

  // Active selection values (for slippage/minOut used by tx)
  let previewOut: bigint | undefined;
  if (usdcRaw > 0n && direction !== null) {
    previewOut = computePreview(direction, usdcRaw);
  }

  const priceImpactBps = (() => {
    if (usdcRaw === 0n) return 0n;
    if (direction === "long") {
      if (!airUsdTotalSupply || airUsdTotalSupply === 0n) return 0n;
      return (usdcRaw * 10_000n) / (airUsdTotalSupply + usdcRaw);
    }
    if (!airTokenTotalSupply || airTokenTotalSupply === 0n) return 0n;
    return (usdcRaw * 10_000n) / (airTokenTotalSupply + usdcRaw);
  })();
  const slippageBps = priceImpactBps + 10n;
  const minOut =
    previewOut !== undefined && previewOut > 0n
      ? (previewOut * (10_000n - slippageBps)) / 10_000n
      : 0n;

  // Router: skip per-trade approval when router has sufficient allowance
  const { routerAddress, routerAllowance } = useRouterApproval(underlyingUsdc);
  const canUseRouter = !!routerAddress && routerAllowance !== undefined && routerAllowance >= feePulled && usdcRaw > 0n;

  const allowanceLoaded = canUseRouter || allowance !== undefined;
  const needsApproval   = !canUseRouter && allowance !== undefined && usdcRaw > 0n && feePulled > allowance!;

  const { writeContract: writeApprove, data: approveHash, isPending: approvePending } =
    useWriteContract();
  const { isLoading: approveConfirming, isSuccess: approveSuccess } =
    useWaitForTransactionReceipt({ hash: approveHash });

  useEffect(() => {
    if (approveSuccess) queryClient.invalidateQueries();
  }, [approveSuccess, queryClient]);

  const { writeContract: writeOpen, data: openHash, isPending: openPending } =
    useWriteContract();
  const { isLoading: openConfirming, isSuccess: openSuccess } =
    useWaitForTransactionReceipt({ hash: openHash });

  useEffect(() => {
    if (!openSuccess) return;
    queryClient.invalidateQueries();
    const t = setTimeout(onAdvance, 1400);
    return () => clearTimeout(t);
  }, [openSuccess, queryClient, onAdvance]);

  const approveBusy = approvePending || approveConfirming;
  const openBusy    = openPending    || openConfirming;
  const hasAmount   = usdcRaw > 0n;

  function selectTrade(dir: "long" | "short", amount: number) {
    setDirection(dir);
    setPreset(amount);
    if (dir === "long") setCustomLong("");
    if (dir === "short") setCustomShort("");
  }

  function handleCustomChange(dir: "long" | "short", value: string) {
    setDirection(dir);
    setPreset(null);
    if (dir === "long") {
      setCustomLong(value);
      setCustomShort("");
    } else {
      setCustomShort(value);
      setCustomLong("");
    }
  }

  function handleCustomFocus(dir: "long" | "short") {
    setDirection(dir);
    setPreset(null);
  }

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        maxWidth: 480,
        margin: "0 auto",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        overflow: "hidden",
      }}
    >
      {/* Corner decorations */}
      <span style={{ position: "absolute", top: -1, left: -1, width: 14, height: 14, borderTop: "1px solid var(--cyan)", borderLeft: "1px solid var(--cyan)", zIndex: 10, pointerEvents: "none" }} />
      <span style={{ position: "absolute", bottom: -1, right: -1, width: 14, height: 14, borderBottom: "1px solid var(--cyan)", borderRight: "1px solid var(--cyan)", zIndex: 10, pointerEvents: "none" }} />

      {/* ── Chart area with token info overlay ── */}
      <div style={{ position: "relative", height: CHART_HEIGHT, perspective: 800, overflow: "hidden", background: "#000" }}>
        {/* Chart + overlays — tilts backwards and zooms into dot on tx */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            transformOrigin: `${txSide === "short" ? "60%" : "40%"} 18%`,
            transform: txPhase !== "idle"
              ? `rotateX(80deg) scale(6) translateY(-10%) translateX(${txSide === "short" ? "-8%" : "8%"})`
              : "rotateX(0deg) scale(1) translateY(0) translateX(0)",
            opacity: txPhase !== "idle" ? 0 : 1,
            transition: "transform 2s cubic-bezier(0.4, 0, 0.9, 0.4), opacity 1.8s ease-in",
            transformStyle: "preserve-3d",
          }}
        >
          <PriceChart poolAddress={poolAddress} height={CHART_HEIGHT} highlightLine={hoverSide} />

          {/* Top gradient for readability */}
          <div
            style={{
              position: "absolute",
              top: 0, left: 0, right: 0, height: 90,
              background: "linear-gradient(to bottom, rgba(7,7,7,0.85), transparent)",
              pointerEvents: "none",
            }}
          />
          {/* Bottom gradient */}
          <div
            style={{
              position: "absolute",
              bottom: 0, left: 0, right: 0, height: 72,
              background: "linear-gradient(to top, rgba(7,7,7,0.88), transparent)",
              pointerEvents: "none",
            }}
          />

          {/* Token info overlay (top-left) */}
          <div
            style={{
              position: "absolute",
              top: 14, left: 18,
              zIndex: 5,
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                fontSize: "1.9rem",
                lineHeight: 1,
                textShadow: "0 2px 12px rgba(0,0,0,0.8)",
              }}
            >
              <span
                className="logo-glitch"
                data-text={symbol}
                style={{ fontSize: "inherit" }}
              >
                {symbol}
              </span>
              <span style={{ color: "var(--muted)", fontSize: "1rem", marginLeft: 8, fontFamily: "var(--font-display)", letterSpacing: "0.05em" }}>
                /USDC
              </span>
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.72rem",
                color: "var(--cyan)",
                fontWeight: 600,
                marginTop: 4,
                letterSpacing: "0.03em",
                textShadow: "0 1px 8px rgba(0,0,0,0.8)",
              }}
            >
              {priceDisplay}
            </div>
          </div>

          {/* TVL overlay (top-right) */}
          <div
            style={{
              position: "absolute",
              top: 18, right: 18,
              zIndex: 5,
              fontFamily: "var(--font-mono)",
              fontSize: "0.62rem",
              color: "var(--muted)",
              letterSpacing: "0.1em",
              textShadow: "0 1px 8px rgba(0,0,0,0.8)",
              pointerEvents: "none",
            }}
          >
            TVL {tvlDisplay}
          </div>
        </div>

        {/* Tron scene (behind the chart, revealed as chart tilts away) */}
        {txPhase !== "idle" && (
          <TronScene phase={txPhase} side={txSide} onComplete={() => {
            addAlert(txSide, symbol);
            setTxPhase("idle");
            onAdvance();
          }} />
        )}
      </div>

      {/* ── Trade grid: LONG (left) | SHORT (right) — 2 rows ── */}
      <div style={{ display: "flex", gap: 6, padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
        {/* LONG box */}
        <div
          onMouseEnter={() => setHoverSide("long")}
          onMouseLeave={() => setHoverSide(null)}
          style={{
            flex: 1,
            border: "1px solid rgba(0,255,136,0.25)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "5px 0",
              textAlign: "center",
              fontFamily: "var(--font-mono)",
              fontSize: "0.58rem",
              letterSpacing: "0.15em",
              fontWeight: 700,
              color: "var(--green)",
              background: "rgba(0,255,136,0.08)",
              borderBottom: "1px solid rgba(0,255,136,0.15)",
            }}
          >
            ▲ LONG
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
            {presets.map((amount, i) => {
              const active = direction === "long" && preset === amount;
              return (
                <button
                  key={amount}
                  onClick={() => selectTrade("long", amount)}
                  onMouseEnter={() => setHoverPreview({ dir: "long", amount })}
                  onMouseLeave={() => setHoverPreview(null)}
                  style={{
                    padding: "10px 4px",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.68rem",
                    letterSpacing: "0.04em",
                    fontWeight: 600,
                    background: active ? "rgba(0,255,136,0.22)" : "transparent",
                    border: "none",
                    borderRight: i % 2 === 0 ? "1px solid rgba(0,255,136,0.12)" : "none",
                    borderBottom: i < 2 ? "1px solid rgba(0,255,136,0.12)" : "none",
                    color: active ? "#fff" : "var(--green)",
                    cursor: "pointer",
                    transition: "all 0.1s",
                  }}
                >
                  ${amount}
                </button>
              );
            })}
            <input
              type="number"
              placeholder="$…"
              value={customLong}
              onChange={(e) => handleCustomChange("long", e.target.value)}
              onFocus={() => handleCustomFocus("long")}
              style={{
                padding: "10px 6px",
                fontFamily: "var(--font-mono)",
                fontSize: "0.68rem",
                letterSpacing: "0.04em",
                fontWeight: 600,
                background: isCustomLong ? "rgba(0,255,136,0.22)" : "transparent",
                border: "none",
                color: "var(--green)",
                outline: "none",
                width: "100%",
                boxSizing: "border-box",
              }}
            />
          </div>
        </div>

        {/* SHORT box */}
        <div
          onMouseEnter={() => setHoverSide("short")}
          onMouseLeave={() => setHoverSide(null)}
          style={{
            flex: 1,
            border: "1px solid rgba(255,59,48,0.25)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "5px 0",
              textAlign: "center",
              fontFamily: "var(--font-mono)",
              fontSize: "0.58rem",
              letterSpacing: "0.15em",
              fontWeight: 700,
              color: "var(--red)",
              background: "rgba(255,59,48,0.08)",
              borderBottom: "1px solid rgba(255,59,48,0.15)",
            }}
          >
            ▼ SHORT
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
            {presets.map((amount, i) => {
              const active = direction === "short" && preset === amount;
              return (
                <button
                  key={amount}
                  onClick={() => selectTrade("short", amount)}
                  onMouseEnter={() => setHoverPreview({ dir: "short", amount })}
                  onMouseLeave={() => setHoverPreview(null)}
                  style={{
                    padding: "10px 4px",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.68rem",
                    letterSpacing: "0.04em",
                    fontWeight: 600,
                    background: active ? "rgba(255,59,48,0.22)" : "transparent",
                    border: "none",
                    borderRight: i % 2 === 0 ? "1px solid rgba(255,59,48,0.12)" : "none",
                    borderBottom: i < 2 ? "1px solid rgba(255,59,48,0.12)" : "none",
                    color: active ? "#fff" : "var(--red)",
                    cursor: "pointer",
                    transition: "all 0.1s",
                  }}
                >
                  ${amount}
                </button>
              );
            })}
            <input
              type="number"
              placeholder="$…"
              value={customShort}
              onChange={(e) => handleCustomChange("short", e.target.value)}
              onFocus={() => handleCustomFocus("short")}
              style={{
                padding: "10px 6px",
                fontFamily: "var(--font-mono)",
                fontSize: "0.68rem",
                letterSpacing: "0.04em",
                fontWeight: 600,
                background: isCustomShort ? "rgba(255,59,48,0.22)" : "transparent",
                border: "none",
                color: "var(--red)",
                outline: "none",
                width: "100%",
                boxSizing: "border-box",
              }}
            />
          </div>
        </div>
      </div>

      {/* ── Confirm section (shows on hover preview OR selected trade) ── */}
      {showConfirm && (
        <div
          style={{
            padding: "12px 18px 16px",
            borderTop: `1px solid ${showDir === "long" ? "rgba(0,255,136,0.18)" : "rgba(255,59,48,0.18)"}`,
            background: "rgba(0,0,0,0.2)",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            opacity: isHoverOnly ? 0.7 : 1,
            transition: "opacity 0.15s",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontFamily: "var(--font-mono)",
              fontSize: "0.6rem",
              color: "var(--muted)",
              letterSpacing: "0.04em",
            }}
          >
            <span>5% POSITION FEE</span>
            <span>{showUsdc > 0n ? formatUsdc(showFee) : "—"}</span>
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontFamily: "var(--font-mono)",
              fontSize: "0.6rem",
              color: "var(--muted)",
              letterSpacing: "0.04em",
            }}
          >
            <span>EST. {showDir === "long" ? symbol : "USDC"} LOCKED</span>
            <span style={{ color: "var(--body)" }}>
              {showOut !== undefined && showOut > 0n
                ? `${formatToken(showOut, showDir === "long" ? tokenDecimals : 6)} ${showDir === "long" ? symbol : "USDC"}`
                : "—"}
            </span>
          </div>

          {/* Action buttons only when a trade is committed (not hover-only) */}
          {!isHoverOnly && (
            <>
              {!address && hasAmount && (
                <p style={{ fontFamily: "var(--font-mono)", fontSize: "0.63rem", color: "var(--muted)", letterSpacing: "0.08em", textAlign: "center" }}>
                  Connect wallet to open a position
                </p>
              )}

              {address && hasAmount && !allowanceLoaded && (
                <button disabled className="btn-terminal" style={{ width: "100%", justifyContent: "center" }}>
                  <span className="spinner">⟳</span> CHECKING ALLOWANCE<span className="cursor-blink">_</span>
                </button>
              )}

              {address && hasAmount && allowanceLoaded && needsApproval && (
                <button
                  onClick={() =>
                    writeApprove({
                      address: underlyingUsdc,
                      abi: erc20Abi,
                      functionName: "approve",
                      args: [poolAddress, feePulled],
                    })
                  }
                  disabled={approveBusy}
                  className="btn-terminal btn-cyan"
                  style={{ width: "100%", justifyContent: "center" }}
                >
                  {approveBusy ? (
                    <><span className="spinner">⟳</span> {approvePending ? "SIGNING" : "CONFIRMING"}<span className="cursor-blink">_</span></>
                  ) : approveSuccess ? "APPROVED ✓" : "APPROVE USDC"}
                </button>
              )}

              {address && hasAmount && allowanceLoaded && !needsApproval && (
                <button
                  onClick={() => {
                    if (canUseRouter) {
                      writeOpen({
                        address: routerAddress!,
                        abi: exnihiloRouterAbi,
                        functionName: direction === "long" ? "openLong" : "openShort",
                        args: [poolAddress, usdcRaw, minOut],
                      });
                    } else {
                      const args = [usdcRaw, minOut, address!] as const;
                      if (direction === "long") {
                        writeOpen({ address: poolAddress, abi: exnihiloPoolAbi, functionName: "openLong", args });
                      } else {
                        writeOpen({ address: poolAddress, abi: exnihiloPoolAbi, functionName: "openShort", args });
                      }
                    }
                  }}
                  disabled={openBusy || minOut === 0n || openSuccess}
                  className={`btn-terminal ${direction === "long" ? "btn-green" : "btn-red"}`}
                  style={{ width: "100%", justifyContent: "center" }}
                >
                  {openSuccess ? "✓ POSITION OPENED" : openBusy ? (
                    <><span className="spinner">⟳</span> {openPending ? "SIGNING" : "CONFIRMING"}<span className="cursor-blink">_</span></>
                  ) : `OPEN ${direction === "long" ? "LONG" : "SHORT"}`}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Footer ── */}
      <div
        style={{
          padding: "10px 18px",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          borderTop: "1px solid var(--border)",
        }}
      >
        <Link
          to={`/app/markets/${poolAddress}`}
          style={{ fontFamily: "var(--font-mono)", fontSize: "0.58rem", letterSpacing: "0.1em", color: "var(--muted)", textDecoration: "none" }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "var(--body)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "var(--muted)")}
        >
          VIEW FULL MARKET →
        </Link>
      </div>

      {/* ── Mock TX buttons (dev) ── */}
      <div
        style={{
          padding: "8px 18px 10px",
          display: "flex",
          gap: 6,
          borderTop: "1px dashed var(--border)",
        }}
      >
        <button
          onClick={() => {
            setTxSide(direction === "short" ? "short" : "long");
            setTxPhase("submitted");
          }}
          className="btn-terminal"
          style={{ flex: 1, fontSize: "0.55rem", padding: "6px 4px", justifyContent: "center" }}
        >
          MOCK TX SUBMITTED
        </button>
        <button
          onClick={() => setTxPhase("mined")}
          disabled={txPhase !== "submitted"}
          className="btn-terminal btn-cyan"
          style={{ flex: 1, fontSize: "0.55rem", padding: "6px 4px", justifyContent: "center" }}
        >
          MOCK TX MINED
        </button>
        <button
          onClick={() => setTxPhase("idle")}
          disabled={txPhase === "idle"}
          className="btn-terminal"
          style={{ flex: 1, fontSize: "0.55rem", padding: "6px 4px", justifyContent: "center" }}
        >
          RESET
        </button>
      </div>
    </div>
  );
}

// ─── Feed Page ────────────────────────────────────────────────────────────────

export default function FeedPage() {
  const chainId = useChainId();
  const addrs   = getAddresses(chainId);

  const [currentIndex, setCurrentIndex] = useState(0);

  const factoryContract = { address: addrs.factory, abi: exnihiloFactoryAbi } as const;

  const { data: poolLength, isLoading: lengthLoading } = useReadContract({
    ...factoryContract,
    functionName: "allPoolsLength",
  });
  const poolCount = Number(poolLength ?? 0n);

  const { data: poolResults, isLoading: poolsLoading } = useReadContracts({
    contracts: Array.from({ length: poolCount }, (_, i) => ({
      ...factoryContract,
      functionName: "allPools" as const,
      args: [BigInt(i)] as const,
    })),
    query: { enabled: poolCount > 0 },
  });

  const allPoolAddresses = useMemo(
    () =>
      (poolResults ?? [])
        .map((r) => r.result as `0x${string}` | undefined)
        .filter((r): r is `0x${string}` => Boolean(r)),
    [poolResults]
  );

  const { data: poolMetaResults, isLoading: metaLoading } = useReadContracts({
    contracts: allPoolAddresses.flatMap((addr) => [
      { address: addr, abi: exnihiloPoolAbi, functionName: "backedAirToken" as const },
      { address: addr, abi: exnihiloPoolAbi, functionName: "backedAirUsd"  as const },
      { address: addr, abi: exnihiloPoolAbi, functionName: "underlyingToken" as const },
    ]),
    query: { enabled: allPoolAddresses.length > 0 },
  });

  const poolMeta = useMemo(() => {
    if (!poolMetaResults) return [];
    return allPoolAddresses.map((addr, i) => {
      const base = i * 3;
      return {
        addr,
        backedAirToken:  poolMetaResults[base]?.result     as bigint | undefined,
        backedAirUsd:   poolMetaResults[base + 1]?.result as bigint | undefined,
        underlyingToken: poolMetaResults[base + 2]?.result as `0x${string}` | undefined,
      };
    });
  }, [poolMetaResults, allPoolAddresses]);

  const uniqueTokenAddrs = useMemo(() => {
    const seen = new Set<string>();
    return poolMeta
      .map((p) => p.underlyingToken)
      .filter((a): a is `0x${string}` => {
        if (!a) return false;
        const key = a.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [poolMeta]);

  const { data: tokenMetaResults } = useReadContracts({
    contracts: uniqueTokenAddrs.flatMap((addr) => [
      { address: addr, abi: erc20Abi, functionName: "symbol"   as const },
      { address: addr, abi: erc20Abi, functionName: "decimals" as const },
    ]),
    query: { enabled: uniqueTokenAddrs.length > 0 },
  });

  const tokenMetaMap = useMemo(() => {
    const map: Record<string, { symbol: string; decimals: number }> = {};
    uniqueTokenAddrs.forEach((addr, i) => {
      const base = i * 2;
      const sym = tokenMetaResults?.[base]?.result     as string | undefined;
      const dec = tokenMetaResults?.[base + 1]?.result as number | undefined;
      if (sym !== undefined && dec !== undefined) {
        map[addr.toLowerCase()] = { symbol: sym, decimals: dec };
      }
    });
    return map;
  }, [tokenMetaResults, uniqueTokenAddrs]);

  const enrichedPools = useMemo(() => {
    return poolMeta
      .map((p) => {
        const tokenMeta = p.underlyingToken ? tokenMetaMap[p.underlyingToken.toLowerCase()] : undefined;
        const decimals = tokenMeta?.decimals ?? 18;
        const symbol   = tokenMeta?.symbol   ?? "???";

        const priceRaw =
          p.backedAirToken !== undefined && p.backedAirToken > 0n && p.backedAirUsd !== undefined
            ? (p.backedAirUsd * 10n ** BigInt(decimals)) / p.backedAirToken
            : undefined;

        const tokenValueRaw =
          p.backedAirToken !== undefined && priceRaw !== undefined
            ? (p.backedAirToken * priceRaw) / 10n ** BigInt(decimals)
            : undefined;

        const totalTvlRaw =
          tokenValueRaw !== undefined && p.backedAirUsd !== undefined
            ? tokenValueRaw + p.backedAirUsd
            : undefined;

        return {
          addr: p.addr,
          symbol,
          decimals,
          backedAirToken: p.backedAirToken,
          backedAirUsd:  p.backedAirUsd,
          rating:        starRating(totalTvlRaw),
        };
      })
      .sort((a, b) => b.rating - a.rating);
  }, [poolMeta, tokenMetaMap]);

  const total = enrichedPools.length;

  const handleNext = useCallback(() => {
    setCurrentIndex((i) => (i + 1) % (total || 1));
  }, [total]);

  const handleBack = useCallback(() => {
    setCurrentIndex((i) => (i - 1 + (total || 1)) % (total || 1));
  }, [total]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") handleNext();
      else if (e.key === "ArrowLeft") handleBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleNext, handleBack]);

  const currentPool = total > 0 ? enrichedPools[currentIndex % total] : undefined;

  const isLoading = lengthLoading || poolsLoading || (poolCount > 0 && metaLoading);

  if (isLoading) {
    return (
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--muted)", padding: "48px 0", letterSpacing: "0.1em" }}>
        <span className="spinner">⟳</span> LOADING FEED<span className="cursor-blink">_</span>
      </div>
    );
  }

  if (poolCount === 0) {
    return (
      <div style={{ maxWidth: 480, margin: "0 auto", textAlign: "center", paddingTop: 56, display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
        <span className="logo-glitch" data-text="EXNIHILO" style={{ fontSize: "clamp(2.5rem, 8vw, 5rem)" }}>EXNIHILO</span>
        <p style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--muted)", letterSpacing: "0.12em" }}>NO MARKETS YET</p>
        <Link to="/app/create" className="btn-terminal btn-cyan">CREATE FIRST MARKET</Link>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 480, margin: "0 auto" }}>
      <RouterApprovalModal />

      {currentPool && (
        <FeedCard
          key={currentPool.addr}
          poolAddress={currentPool.addr}
          symbol={currentPool.symbol}
          tokenDecimals={currentPool.decimals}
          underlyingUsdc={addrs.usdc}
          backedAirToken={currentPool.backedAirToken}
          backedAirUsd={currentPool.backedAirUsd}
          rating={currentPool.rating}
          onAdvance={handleNext}
        />
      )}

      {/* ── Back / Next navigation ── */}
      {total > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 14,
            padding: "0 4px",
          }}
        >
          <button
            onClick={handleBack}
            className="btn-terminal"
            style={{
              fontSize: "0.62rem",
              letterSpacing: "0.1em",
              padding: "8px 18px",
            }}
          >
            ‹ BACK
          </button>

          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.58rem",
              letterSpacing: "0.1em",
              color: "var(--muted)",
            }}
          >
            {(currentIndex % total) + 1} / {total}
          </span>

          <button
            onClick={handleNext}
            className="btn-terminal"
            style={{
              fontSize: "0.62rem",
              letterSpacing: "0.1em",
              padding: "8px 18px",
            }}
          >
            NEXT ›
          </button>
        </div>
      )}
    </div>
  );
}
