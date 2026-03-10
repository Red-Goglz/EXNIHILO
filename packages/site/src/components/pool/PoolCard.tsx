import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useReadContracts } from "wagmi";
import { exnihiloPoolAbi, erc20Abi } from "@exnihilio/abis";
import { formatUsdc, formatUsdcCompact } from "../../lib/format.ts";

const STAR_LEVELS = [
  { stars: 1, label: "NO LIQUIDITY",   threshold: "< $1K" },
  { stars: 2, label: "LOW LIQUIDITY",  threshold: "$1K – $10K" },
  { stars: 3, label: "GROWING",        threshold: "$10K – $100K" },
  { stars: 4, label: "ESTABLISHED",    threshold: "$100K – $1M" },
  { stars: 5, label: "DEEP LIQUIDITY", threshold: "> $1M" },
];

function starRating(tvlRaw: bigint | undefined): 1 | 2 | 3 | 4 | 5 {
  if (tvlRaw === undefined) return 1;
  const tvl = Number(tvlRaw) / 1_000_000;
  if (tvl >= 1_000_000) return 5;
  if (tvl >= 100_000)   return 4;
  if (tvl >= 10_000)    return 3;
  if (tvl >= 1_000)     return 2;
  return 1;
}

function StarsWithTooltip({ count }: { count: 1 | 2 | 3 | 4 | 5 }) {
  const [visible, setVisible] = useState(false);
  return (
    <div
      style={{ position: "relative", display: "inline-block", cursor: "help" }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      // Stop row click from navigating when clicking the tooltip area
      onClick={(e) => e.stopPropagation()}
    >
      <span style={{ letterSpacing: "0.05em", fontSize: "0.9rem" }}>
        {([1, 2, 3, 4, 5] as const).map((i) => (
          <span key={i} style={{ color: i <= count ? "var(--cyan)" : "var(--dim)" }}>★</span>
        ))}
      </span>

      {visible && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 10px)",
            right: 0,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            padding: "10px 14px",
            zIndex: 50,
            whiteSpace: "nowrap",
            display: "flex",
            flexDirection: "column",
            gap: 7,
            boxShadow: "0 4px 24px rgba(0,0,0,0.6)",
          }}
        >
          <span style={{ position: "absolute", top: -1, left: -1, width: 8, height: 8, borderTop: "1px solid var(--cyan)", borderLeft: "1px solid var(--cyan)" }} />
          <span style={{ position: "absolute", bottom: -1, right: -1, width: 8, height: 8, borderBottom: "1px solid var(--cyan)", borderRight: "1px solid var(--cyan)" }} />

          {STAR_LEVELS.map(({ stars, label, threshold }) => (
            <div key={stars} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: "0.72rem", letterSpacing: "0.04em" }}>
                {([1, 2, 3, 4, 5] as const).map((i) => (
                  <span key={i} style={{ color: i <= stars ? "var(--cyan)" : "var(--dim)" }}>★</span>
                ))}
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", letterSpacing: "0.06em", color: "var(--muted)", minWidth: 110 }}>
                {label}
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--dim)" }}>
                {threshold}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatPct(pct: number): string {
  if (pct === 0) return "0%";
  return `${pct.toFixed(1)}%`;
}

function pctColor(pct: number): string {
  if (pct === 0) return "var(--muted)";
  if (pct <= 33) return "var(--green)";
  if (pct <= 66) return "var(--orange)";
  return "var(--red)";
}

interface PoolCardProps {
  poolAddress: `0x${string}`;
  onData?: (symbol: string, rating: number) => void;
}

export default function PoolCard({ poolAddress, onData }: PoolCardProps) {
  const navigate = useNavigate();
  const poolContract = { address: poolAddress, abi: exnihiloPoolAbi } as const;

  const { data } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "backedAirMeme" },      // 0
      { ...poolContract, functionName: "backedAirUsd" },       // 1
      { ...poolContract, functionName: "openPositionCount" },  // 2
      { ...poolContract, functionName: "underlyingMeme" },     // 3
      { ...poolContract, functionName: "longOpenInterest" },   // 4
      { ...poolContract, functionName: "shortOpenInterest" },  // 5
    ],
  });

  const backedAirMeme      = data?.[0]?.result as bigint | undefined;
  const backedAirUsd       = data?.[1]?.result as bigint | undefined;
  const openPositionCount  = data?.[2]?.result as bigint | undefined;
  const underlyingMeme     = data?.[3]?.result as `0x${string}` | undefined;
  const longOpenInterest   = data?.[4]?.result as bigint | undefined;
  const shortOpenInterest  = data?.[5]?.result as bigint | undefined;

  const { data: metaData } = useReadContracts({
    contracts: underlyingMeme
      ? [
          { address: underlyingMeme, abi: erc20Abi, functionName: "symbol" },
          { address: underlyingMeme, abi: erc20Abi, functionName: "decimals" },
        ]
      : [],
    query: { enabled: !!underlyingMeme },
  });

  const symbol   = (metaData?.[0]?.result as string | undefined) ?? "…";
  const decimals = (metaData?.[1]?.result as number | undefined) ?? 18;

  const priceRaw =
    backedAirMeme !== undefined &&
    backedAirMeme > 0n &&
    backedAirUsd !== undefined
      ? (backedAirUsd * 10n ** BigInt(decimals)) / backedAirMeme
      : undefined;

  const price = priceRaw !== undefined ? formatUsdc(priceRaw) : "—";

  const memeValueRaw =
    backedAirMeme !== undefined && priceRaw !== undefined
      ? (backedAirMeme * priceRaw) / 10n ** BigInt(decimals)
      : undefined;
  const totalTvlRaw =
    memeValueRaw !== undefined && backedAirUsd !== undefined
      ? memeValueRaw + backedAirUsd
      : undefined;
  const totalTvl = totalTvlRaw !== undefined ? formatUsdcCompact(totalTvlRaw) : "—";

  const pctLong =
    backedAirUsd !== undefined && backedAirUsd > 0n && longOpenInterest !== undefined
      ? Number((longOpenInterest * 10_000n) / backedAirUsd) / 100
      : 0;

  const pctShort =
    backedAirUsd !== undefined && backedAirUsd > 0n && shortOpenInterest !== undefined
      ? Number((shortOpenInterest * 10_000n) / backedAirUsd) / 100
      : 0;

  const hasOiData = longOpenInterest !== undefined && shortOpenInterest !== undefined;
  const rating = starRating(totalTvlRaw);

  // Report symbol + rating up to parent for filter/sort
  useEffect(() => {
    if (symbol !== "…" && onData) {
      onData(symbol, rating);
    }
  }, [symbol, rating, onData]);

  return (
    <tr onClick={() => navigate(`/app/markets/${poolAddress}`)}>
      <td>
        <span style={{ fontWeight: 500 }}>{symbol}</span>
        <span style={{ color: "var(--muted)" }}> / USDC</span>
      </td>
      <td style={{ color: "var(--cyan)", fontWeight: 500 }}>{price}</td>
      <td>{totalTvl}</td>
      <td>{openPositionCount?.toString() ?? "—"}</td>
      <td style={{ color: pctColor(pctLong), fontWeight: pctLong > 0 ? 600 : 400 }}>
        {hasOiData ? formatPct(pctLong) : "—"}
      </td>
      <td style={{ color: pctColor(pctShort), fontWeight: pctShort > 0 ? 600 : 400 }}>
        {hasOiData ? formatPct(pctShort) : "—"}
      </td>
      <td>
        <StarsWithTooltip count={rating} />
      </td>
    </tr>
  );
}
