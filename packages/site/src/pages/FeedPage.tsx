import { useState, useMemo, useEffect } from "react";
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
  positionNFTAbi,
} from "@exnihilio/abis";
import { getAddresses } from "../contracts/addresses.ts";
import { formatUsdc, formatUsdcCompact, parseUnits, formatToken } from "../lib/format.ts";
import { quoteLong, quoteShort } from "../lib/amm.ts";
import { useRouterApproval } from "../hooks/useRouterApproval.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const POSITION_FEE_BPS = 500n;
const SESSION_KEY = "exnihilo_feed_visited";

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

// ─── Deterministic price chart + activity markers ────────────────────────────

function nextSeed(s: number): number {
  return ((s * 1664525) + 1013904223) | 0;
}

/** Generate N price points ending at 0.5 (center), seeded by pool address. */
function generatePricePath(poolAddr: string, n: number): number[] {
  let seed = 5381;
  for (let i = 0; i < poolAddr.length; i++) {
    seed = (((seed << 5) + seed) + poolAddr.charCodeAt(i)) | 0;
  }
  seed = Math.abs(seed) || 1;

  const pts: number[] = [];
  let v = 0.38 + ((seed & 0xFF) / 255) * 0.24;

  for (let i = 0; i < n - 1; i++) {
    seed = nextSeed(seed);
    const delta = (((seed >>> 0) & 0xFF) / 255 - 0.5) * 0.07;
    v = Math.max(0.06, Math.min(0.94, v + delta));
    pts.push(v);
  }
  pts.push(0.5);
  return pts;
}

interface ActivityMarker {
  /** Index in the pts array */
  idx: number;
  /** 0–1 horizontal position (matches pts[idx]) */
  x: number;
  /** 0–1 vertical position (0 = top/new, 1 = bottom/old) */
  y: number;
  isLong: boolean;
  amount: number;
  pnl: number;
  /** Which side the label floats to */
  labelSide: "left" | "right";
}

function generateMarkers(poolAddr: string, pts: number[]): ActivityMarker[] {
  const N = pts.length;
  // Seed differently from the price path
  let seed = 5381;
  const tag = poolAddr + "_m";
  for (let i = 0; i < tag.length; i++) {
    seed = (((seed << 5) + seed) + tag.charCodeAt(i)) | 0;
  }
  seed = Math.abs(seed) || 1;

  seed = nextSeed(seed);
  const count = 2 + ((seed >>> 0) % 2); // 2 or 3

  const amounts = [5, 10, 25, 50, 100, 200];
  // Spread markers across 15%–85% of the path vertically
  const lo = Math.floor(N * 0.15);
  const hi = Math.floor(N * 0.85);
  const band = Math.floor((hi - lo) / count);

  const markers: ActivityMarker[] = [];
  for (let m = 0; m < count; m++) {
    seed = nextSeed(seed);
    // Pick index within the band for this marker
    const baseIdx = lo + band * m;
    const jitter = (seed >>> 0) % Math.max(1, band - 4);
    const idx = Math.min(hi, baseIdx + jitter + 2);

    seed = nextSeed(seed);
    const isLong = ((seed >>> 0) & 1) === 0;

    seed = nextSeed(seed);
    const amount = amounts[(seed >>> 0) % amounts.length];

    // PnL: biased slightly positive, ±60% of amount
    seed = nextSeed(seed);
    const pnlRatio = ((seed >>> 0 & 0xFF) / 255 - 0.38) * 1.2;
    const pnl = Math.round(amount * pnlRatio * 10) / 10;

    const x = pts[idx];
    const y = 1 - idx / (N - 1); // 0=top, 1=bottom

    // Float label toward center to avoid clipping
    const labelSide: "left" | "right" = x > 0.55 ? "left" : "right";

    markers.push({ idx, x, y, isLong, amount, pnl, labelSide });
  }
  return markers;
}

// ─── Price Chart (SVG) ───────────────────────────────────────────────────────

function PriceChart({
  poolAddress,
  height = 380,
  markers,
}: {
  poolAddress: string;
  height?: number;
  markers: ActivityMarker[];
}) {
  const W = 400;
  const H = height;
  const N = 90;

  const pts = useMemo(() => generatePricePath(poolAddress, N), [poolAddress]);

  // SVG coords: y=H is bottom (oldest), y=0 is top (newest/current)
  const svgPts = pts.map((x, i) => ({
    x: x * W,
    y: H - (i / (N - 1)) * H,
  }));

  const linePath = svgPts
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join("");

  const greenFill =
    `M0,${H}` +
    svgPts.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("") +
    `L0,0Z`;

  const redFill =
    `M${W},${H}` +
    svgPts.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("") +
    `L${W},0Z`;

  // Map marker path indices to SVG coords
  const markerSvgPts = markers.map((m) => svgPts[m.idx] ?? svgPts[svgPts.length - 1]);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}
      preserveAspectRatio="none"
    >
      {/* Tinted fills */}
      <path d={greenFill} fill="rgba(0,255,136,0.10)" />
      <path d={redFill}   fill="rgba(255,59,48,0.10)" />

      {/* Grid lines */}
      {[0.25, 0.5, 0.75].map((x) => (
        <line key={x} x1={x * W} y1={0} x2={x * W} y2={H}
          stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
      ))}

      {/* Center dashed guide (current price) */}
      <line x1={W / 2} y1={0} x2={W / 2} y2={H}
        stroke="rgba(0,229,255,0.18)" strokeWidth="1" strokeDasharray="5 4" />

      {/* Price line */}
      <path d={linePath}
        stroke="rgba(255,255,255,0.55)" strokeWidth="2" fill="none"
        strokeLinejoin="round" strokeLinecap="round" />

      {/* Current price dot */}
      <circle cx={W / 2} cy={0} r={5} fill="#00e5ff" opacity="0.9" />
      <circle cx={W / 2} cy={0} r={10} fill="#00e5ff" opacity="0.12" />

      {/* Activity marker dots */}
      {markerSvgPts.map((pt, i) => {
        const m = markers[i];
        const color = m.isLong ? "#00ff88" : "#ff3b30";
        return (
          <g key={i}>
            <circle cx={pt.x} cy={pt.y} r={5} fill={color} opacity="0.9" />
            <circle cx={pt.x} cy={pt.y} r={10} fill={color} opacity="0.15" />
          </g>
        );
      })}
    </svg>
  );
}

// ─── Activity marker overlays (HTML, positioned over chart) ──────────────────

function ActivityMarkers({
  markers,
  pts,
}: {
  markers: ActivityMarker[];
  pts: number[];
}) {
  return (
    <>
      {markers.map((m, i) => {
        const color = m.isLong ? "var(--green)" : "var(--red)";
        const borderColor = m.isLong ? "rgba(0,255,136,0.25)" : "rgba(255,59,48,0.25)";
        const pnlColor = m.pnl >= 0 ? "var(--green)" : "var(--red)";
        const N = pts.length;
        // Compute pixel y from index
        const yPct = (1 - m.idx / (N - 1)) * 100;
        const xPct = m.x * 100;

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${xPct}%`,
              top: `${yPct}%`,
              transform: "translateY(-50%)",
              zIndex: 4,
              pointerEvents: "none",
            }}
          >
            {/* Label */}
            <div
              style={{
                position: "absolute",
                [m.labelSide === "right" ? "left" : "right"]: 14,
                top: "50%",
                transform: "translateY(-50%)",
                background: "rgba(5,5,5,0.92)",
                border: `1px solid ${borderColor}`,
                padding: "5px 9px",
                whiteSpace: "nowrap",
                display: "flex",
                flexDirection: "column",
                gap: 2,
                boxShadow: "0 2px 12px rgba(0,0,0,0.6)",
              }}
            >
              {/* Top accent */}
              <span style={{
                position: "absolute", top: -1, left: -1, width: 5, height: 5,
                borderTop: `1px solid ${color}`, borderLeft: `1px solid ${color}`,
              }} />
              <span style={{
                position: "absolute", bottom: -1, right: -1, width: 5, height: 5,
                borderBottom: `1px solid ${color}`, borderRight: `1px solid ${color}`,
              }} />

              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.55rem",
                  letterSpacing: "0.08em",
                  color,
                  fontWeight: 700,
                }}
              >
                {m.isLong ? "▲ LONG" : "▼ SHORT"} ${m.amount}
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.52rem",
                  letterSpacing: "0.05em",
                  color: pnlColor,
                }}
              >
                PNL {m.pnl >= 0 ? "+" : ""}${Math.abs(m.pnl).toFixed(1)}
              </span>
            </div>
          </div>
        );
      })}
    </>
  );
}

// ─── Feed Card ────────────────────────────────────────────────────────────────

const CHART_HEIGHT = 380;
const N_PTS = 90;

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

  const [direction, setDirection] = useState<"long" | "short" | null>(null);
  const [preset, setPreset]       = useState<number | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [customInput, setCustomInput] = useState("");

  const presets = getPresets(rating);

  const amountStr = showCustom ? customInput : preset !== null ? String(preset) : "";
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

  // Precompute chart data (stable references)
  const pts     = useMemo(() => generatePricePath(poolAddress, N_PTS), [poolAddress]);
  const markers = useMemo(() => generateMarkers(poolAddress, pts), [poolAddress, pts]);

  // Lazy-load trading data after direction is picked
  const poolContract = { address: poolAddress, abi: exnihiloPoolAbi } as const;

  const { data: poolData } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "swapFeeBps" },
      { ...poolContract, functionName: "airToken" },
      { ...poolContract, functionName: "airUsdToken" },
      {
        address: underlyingUsdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address ?? "0x0000000000000000000000000000000000000000", poolAddress],
      },
    ],
    query: { enabled: !!direction && !!address },
  });

  const swapFeeBps  = poolData?.[0]?.result as bigint | undefined;
  const airTokenAddr = poolData?.[1]?.result as `0x${string}` | undefined;
  const airUsdAddr  = poolData?.[2]?.result as `0x${string}` | undefined;
  const allowance   = poolData?.[3]?.result as bigint | undefined;

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

  let previewOut: bigint | undefined;
  if (
    usdcRaw > 0n && direction !== null &&
    backedAirToken !== undefined && backedAirUsd !== undefined &&
    airTokenTotalSupply !== undefined && airUsdTotalSupply !== undefined &&
    swapFeeBps !== undefined
  ) {
    previewOut =
      direction === "long"
        ? quoteLong(usdcRaw, airUsdTotalSupply, backedAirToken, swapFeeBps)
        : quoteShort(usdcRaw, airTokenTotalSupply, backedAirUsd, swapFeeBps);
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

  function toggleDirection(dir: "long" | "short") {
    if (direction === dir) {
      // Deselect
      setDirection(null);
      setPreset(null);
      setShowCustom(false);
      setCustomInput("");
    } else {
      setDirection(dir);
      setPreset(null);
      setShowCustom(false);
      setCustomInput("");
    }
  }

  function selectPreset(amount: number) {
    setPreset(amount);
    setShowCustom(false);
    setCustomInput("");
  }

  const dirColor = direction === "long" ? "var(--green)" : direction === "short" ? "var(--red)" : "transparent";

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

      {/* ── LONG / SHORT buttons at top ── */}
      <div style={{ display: "flex" }}>
        <button
          onClick={() => toggleDirection("long")}
          style={{
            flex: 1,
            padding: "13px 0",
            fontFamily: "var(--font-mono)",
            fontSize: "0.72rem",
            letterSpacing: "0.15em",
            fontWeight: 700,
            border: "none",
            borderBottom: "1px solid var(--border)",
            borderRight: "1px solid var(--border)",
            background: direction === "long"
              ? "rgba(0,255,136,0.14)"
              : "rgba(0,0,0,0.2)",
            color: direction === "long" ? "var(--green)" : "var(--muted)",
            cursor: "pointer",
            transition: "all 0.12s",
          }}
          onMouseEnter={(e) => {
            if (direction !== "long")
              (e.currentTarget as HTMLButtonElement).style.color = "var(--green)";
          }}
          onMouseLeave={(e) => {
            if (direction !== "long")
              (e.currentTarget as HTMLButtonElement).style.color = "var(--muted)";
          }}
        >
          ▲ LONG
        </button>
        <button
          onClick={() => toggleDirection("short")}
          style={{
            flex: 1,
            padding: "13px 0",
            fontFamily: "var(--font-mono)",
            fontSize: "0.72rem",
            letterSpacing: "0.15em",
            fontWeight: 700,
            border: "none",
            borderBottom: "1px solid var(--border)",
            background: direction === "short"
              ? "rgba(255,59,48,0.14)"
              : "rgba(0,0,0,0.2)",
            color: direction === "short" ? "var(--red)" : "var(--muted)",
            cursor: "pointer",
            transition: "all 0.12s",
          }}
          onMouseEnter={(e) => {
            if (direction !== "short")
              (e.currentTarget as HTMLButtonElement).style.color = "var(--red)";
          }}
          onMouseLeave={(e) => {
            if (direction !== "short")
              (e.currentTarget as HTMLButtonElement).style.color = "var(--muted)";
          }}
        >
          ▼ SHORT
        </button>
      </div>

      {/* ── Amount preset buttons (between toggle and chart) ── */}
      {direction !== null && (
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
            background: direction === "long" ? "rgba(0,255,136,0.06)" : "rgba(255,59,48,0.06)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", gap: 6 }}>
            {presets.map((amount) => {
              const isActive = preset === amount && !showCustom;
              return (
                <button
                  key={amount}
                  onClick={() => selectPreset(amount)}
                  style={{
                    flex: 1,
                    padding: "9px 4px",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.68rem",
                    letterSpacing: "0.04em",
                    background: isActive ? "rgba(0,229,255,0.12)" : "var(--surface)",
                    border: `1px solid ${isActive ? "var(--cyan)" : "var(--border)"}`,
                    color: isActive ? "var(--cyan)" : "var(--body)",
                    cursor: "pointer",
                    transition: "all 0.1s",
                  }}
                >
                  ${amount}
                </button>
              );
            })}
            <button
              onClick={() => { setShowCustom(true); setPreset(null); }}
              style={{
                flex: 1,
                padding: "9px 4px",
                fontFamily: "var(--font-mono)",
                fontSize: "0.68rem",
                letterSpacing: "0.04em",
                background: showCustom ? "rgba(0,229,255,0.12)" : "var(--surface)",
                border: `1px solid ${showCustom ? "var(--cyan)" : "var(--border)"}`,
                color: showCustom ? "var(--cyan)" : "var(--muted)",
                cursor: "pointer",
                transition: "all 0.1s",
              }}
            >
              CUSTOM
            </button>
          </div>

          {showCustom && (
            <input
              type="number"
              placeholder="Enter USDC amount…"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              className="input-terminal"
              style={{ fontSize: "0.72rem" }}
              autoFocus
            />
          )}
        </div>
      )}

      {/* ── Chart area ── */}
      <div style={{ position: "relative", height: CHART_HEIGHT }}>
        <PriceChart poolAddress={poolAddress} height={CHART_HEIGHT} markers={markers} />

        {/* Activity marker overlays */}
        <ActivityMarkers markers={markers} pts={pts} />

        {/* Bottom gradient */}
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: 72,
            background: "linear-gradient(to top, rgba(7,7,7,0.88), transparent)",
            pointerEvents: "none",
          }}
        />

        {/* Direction accent bar at bottom edge */}
        {direction !== null && (
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              height: 3,
              background: dirColor,
              opacity: 0.85,
            }}
          />
        )}
      </div>

      {/* ── Token info below chart ── */}
      <div
        style={{
          padding: "14px 18px 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTop: "1px solid var(--border)",
        }}
      >
        <div>
          <div
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "1.9rem",
              color: "#fff",
              letterSpacing: "0.05em",
              lineHeight: 1,
            }}
          >
            {symbol}
            <span style={{ color: "var(--muted)", fontSize: "1rem", marginLeft: 8 }}>
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
            }}
          >
            {priceDisplay}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <div style={{ fontSize: "1.05rem", letterSpacing: "0.04em" }}>
            {([1, 2, 3, 4, 5] as const).map((i) => (
              <span key={i} style={{ color: i <= rating ? "var(--cyan)" : "var(--dim)" }}>
                ★
              </span>
            ))}
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.58rem",
              color: "var(--muted)",
              letterSpacing: "0.1em",
            }}
          >
            TVL {tvlDisplay}
          </div>
        </div>
      </div>

      {/* ── Confirm section (fee info + approve/open) ── */}
      {direction !== null && (
        <div
          style={{
            padding: "12px 18px 16px",
            borderTop: `1px solid ${direction === "long" ? "rgba(0,255,136,0.18)" : "rgba(255,59,48,0.18)"}`,
            background: "rgba(0,0,0,0.2)",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {hasAmount && (
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
              <span>{formatUsdc(feePulled)}</span>
            </div>
          )}

          {previewOut !== undefined && previewOut > 0n && (
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
              <span>EST. {direction === "long" ? symbol : "USDC"} LOCKED</span>
              <span style={{ color: "var(--body)" }}>
                {formatToken(previewOut, direction === "long" ? tokenDecimals : 6)}{" "}
                {direction === "long" ? symbol : "USDC"}
              </span>
            </div>
          )}

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
        </div>
      )}

      {/* ── Footer ── */}
      <div
        style={{
          padding: "10px 18px",
          display: "flex",
          justifyContent: "space-between",
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
        <button
          onClick={onAdvance}
          style={{ fontFamily: "var(--font-mono)", fontSize: "0.58rem", letterSpacing: "0.1em", color: "var(--dim)", background: "transparent", border: "none", cursor: "pointer", padding: 0 }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--muted)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--dim)")}
        >
          SKIP ›
        </button>
      </div>
    </div>
  );
}

// ─── Feed Page ────────────────────────────────────────────────────────────────

export default function FeedPage() {
  const { address } = useAccount();
  const chainId     = useChainId();
  const addrs       = getAddresses(chainId);

  const [visitedSet, setVisitedSet] = useState<Set<string>>(() => {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      return new Set();
    }
  });

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

  // User's open position pools (excluded from personal queue)
  const posNFT = { address: addrs.positionNFT, abi: positionNFTAbi } as const;

  const { data: nftBalance } = useReadContract({
    ...posNFT,
    functionName: "balanceOf",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: !!address },
  });
  const nftCount = Number(nftBalance ?? 0n);

  const { data: tokenIdResults } = useReadContracts({
    contracts: Array.from({ length: nftCount }, (_, i) => ({
      ...posNFT,
      functionName: "tokenOfOwnerByIndex" as const,
      args: [address ?? "0x0000000000000000000000000000000000000000", BigInt(i)] as const,
    })),
    query: { enabled: nftCount > 0 && !!address },
  });

  const tokenIds = useMemo(
    () =>
      (tokenIdResults ?? [])
        .map((r) => r.result as bigint | undefined)
        .filter((id): id is bigint => id !== undefined),
    [tokenIdResults]
  );

  const { data: positionResults } = useReadContracts({
    contracts: tokenIds.map((id) => ({
      ...posNFT,
      functionName: "getPosition" as const,
      args: [id] as const,
    })),
    query: { enabled: tokenIds.length > 0 },
  });

  const userPositionPools = useMemo<Set<string>>(() => {
    if (!positionResults || !address) return new Set();
    return new Set(
      positionResults
        .map((r) => {
          const pos = r.result as { pool: `0x${string}` } | undefined;
          return pos?.pool?.toLowerCase();
        })
        .filter((p): p is string => Boolean(p))
    );
  }, [positionResults, address]);

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

  const feedQueue = useMemo(() => {
    return enrichedPools.filter((p) => {
      const key = p.addr.toLowerCase();
      if (visitedSet.has(key)) return false;
      if (address && userPositionPools.has(key)) return false;
      return true;
    });
  }, [enrichedPools, visitedSet, userPositionPools, address]);

  const currentPool = feedQueue[0];

  function handleAdvance() {
    if (!currentPool) return;
    const newSet = new Set(visitedSet).add(currentPool.addr.toLowerCase());
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify([...newSet])); } catch { /* ignore */ }
    setVisitedSet(newSet);
  }

  function handleReset() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    setVisitedSet(new Set());
  }

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

  if (!currentPool) {
    return (
      <div style={{ maxWidth: 480, margin: "0 auto", textAlign: "center", paddingTop: 56, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <p style={{ fontFamily: "var(--font-display)", fontSize: "2rem", color: "#fff", letterSpacing: "0.05em" }}>ALL CAUGHT UP</p>
        <p style={{ fontFamily: "var(--font-mono)", fontSize: "0.63rem", color: "var(--muted)", letterSpacing: "0.1em" }}>
          {address ? "You've seen all available markets (excluding your open positions)." : "You've seen all available markets."}
        </p>
        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <button onClick={handleReset} className="btn-terminal btn-cyan">↺ RESET FEED</button>
          <Link to="/app/markets" className="btn-terminal">VIEW ALL MARKETS</Link>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 480, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <p style={{ fontFamily: "var(--font-mono)", fontSize: "0.58rem", letterSpacing: "0.12em", color: "var(--dim)" }}>
          {feedQueue.length} MARKET{feedQueue.length !== 1 ? "S" : ""} IN QUEUE
          {address && " · PERSONALIZED"}
        </p>
        {visitedSet.size > 0 && (
          <button
            onClick={handleReset}
            style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.08em", color: "var(--dim)", background: "transparent", border: "none", cursor: "pointer", padding: 0 }}
          >
            RESET ↺
          </button>
        )}
      </div>

      <FeedCard
        key={currentPool.addr}
        poolAddress={currentPool.addr}
        symbol={currentPool.symbol}
        tokenDecimals={currentPool.decimals}
        underlyingUsdc={addrs.usdc}
        backedAirToken={currentPool.backedAirToken}
        backedAirUsd={currentPool.backedAirUsd}
        rating={currentPool.rating}
        onAdvance={handleAdvance}
      />
    </div>
  );
}
