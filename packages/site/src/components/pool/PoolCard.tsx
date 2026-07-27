import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useReadContracts } from "wagmi";
import { exnihiloPoolAbi, erc20Abi } from "@exnihilio/abis";
import { formatPrice, formatUsdcCompact, decodeSpotPrice } from "../../lib/format.ts";
import { usePoolApr } from "../../hooks/usePoolApr.ts";
import { useAppChain } from "../../hooks/useAppChain.ts";

/**
 * Open-interest cell: total OI in $ plus a long/short split bar.
 * Green = long share, red = short share of the combined open interest.
 */
function OiCell({ longOi, shortOi }: { longOi: bigint; shortOi: bigint }) {
  const total = longOi + shortOi;
  if (total === 0n) {
    return <span style={{ color: "var(--dim)" }}>—</span>;
  }
  const longPct = Number((longOi * 1000n) / total) / 10;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontWeight: 500 }}>{formatUsdcCompact(total)}</span>
      <div
        style={{
          display: "flex",
          width: 52,
          height: 3,
          background: "var(--dim)",
        }}
        title={`Long ${formatUsdcCompact(longOi)} / Short ${formatUsdcCompact(shortOi)}`}
      >
        <span style={{ width: `${longPct}%`, background: "var(--green)" }} />
        <span style={{ flex: 1, background: "var(--magenta)" }} />
      </div>
    </div>
  );
}

/** Signed % gap between an entry price and spot, e.g. "+2.3%". */
export function premiumPct(entryRaw: bigint | undefined, spotRaw: bigint | undefined): number | undefined {
  if (entryRaw === undefined || spotRaw === undefined || spotRaw === 0n || entryRaw === 0n) {
    return undefined;
  }
  return Number(((entryRaw - spotRaw) * 10_000n) / spotRaw) / 100;
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

export interface PoolMeta {
  symbol: string;
  oiRaw: bigint;
  spotRaw: bigint;
  longRaw: bigint;
  shortRaw: bigint;
  tvlRaw: bigint;
  positions: number;
  pctLong: number;
  pctShort: number;
  apr7d: number;
}

interface PoolCardProps {
  poolAddress: `0x${string}`;
  onData?: (meta: PoolMeta) => void;
}

export default function PoolCard({ poolAddress, onData }: PoolCardProps) {
  const navigate = useNavigate();
  const { chainId, path } = useAppChain();
  const poolContract = { address: poolAddress, abi: exnihiloPoolAbi, chainId } as const;

  const { data } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "backedAirToken" },      // 0
      { ...poolContract, functionName: "backedAirUsd" },       // 1
      { ...poolContract, functionName: "openPositionCount" },  // 2
      { ...poolContract, functionName: "underlyingToken" },     // 3
      { ...poolContract, functionName: "longOpenInterest" },   // 4
      { ...poolContract, functionName: "shortOpenInterest" },  // 5
      { ...poolContract, functionName: "longPrice" },          // 6
      { ...poolContract, functionName: "shortPrice" },         // 7
      { ...poolContract, functionName: "closeDate" },          // 8
    ],
  });

  const backedAirToken      = data?.[0]?.result as bigint | undefined;
  const backedAirUsd       = data?.[1]?.result as bigint | undefined;
  const openPositionCount  = data?.[2]?.result as bigint | undefined;
  const underlyingToken     = data?.[3]?.result as `0x${string}` | undefined;
  const longOpenInterest   = data?.[4]?.result as bigint | undefined;
  const shortOpenInterest  = data?.[5]?.result as bigint | undefined;
  const longPriceRaw       = data?.[6]?.result as bigint | undefined;
  const shortPriceRaw      = data?.[7]?.result as bigint | undefined;
  const closeDate          = data?.[8]?.result as bigint | undefined;
  const isClosed           = closeDate !== undefined && closeDate > 0n;
  const isInactive =
    !isClosed &&
    backedAirToken !== undefined &&
    backedAirUsd !== undefined &&
    (backedAirToken === 0n || backedAirUsd === 0n);

  const { data: metaData } = useReadContracts({
    contracts: underlyingToken
      ? [
          { address: underlyingToken, abi: erc20Abi, functionName: "symbol", chainId },
          { address: underlyingToken, abi: erc20Abi, functionName: "decimals", chainId },
        ]
      : [],
    query: { enabled: !!underlyingToken },
  });

  const symbol   = (metaData?.[0]?.result as string | undefined) ?? "…";
  const decimals = (metaData?.[1]?.result as number | undefined) ?? 18;

  const priceRaw =
    backedAirToken !== undefined &&
    backedAirToken > 0n &&
    backedAirUsd !== undefined
      ? (backedAirUsd * 10n ** BigInt(decimals)) / backedAirToken
      : undefined;

  const price = priceRaw !== undefined ? formatPrice(priceRaw) : "—";

  const longPrice  = longPriceRaw !== undefined && longPriceRaw > 0n
    ? decodeSpotPrice(longPriceRaw, decimals) : "—";
  const shortPrice = shortPriceRaw !== undefined && shortPriceRaw > 0n
    ? decodeSpotPrice(shortPriceRaw, decimals) : "—";

  const tokenValueRaw =
    backedAirToken !== undefined && priceRaw !== undefined
      ? (backedAirToken * priceRaw) / 10n ** BigInt(decimals)
      : undefined;
  const totalTvlRaw =
    tokenValueRaw !== undefined && backedAirUsd !== undefined
      ? tokenValueRaw + backedAirUsd
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
  const totalOiRaw = hasOiData ? longOpenInterest! + shortOpenInterest! : undefined;

  // Entry-price gap vs spot: how far synthetic supply has pushed each curve.
  const longPremium  = premiumPct(longPriceRaw, priceRaw);
  const shortPremium = premiumPct(shortPriceRaw, priceRaw);

  // Fetch APR from indexer
  const { data: aprData } = usePoolApr(poolAddress, chainId);
  const apr7d = aprData?.["7d"]?.apr ?? 0;
  const apr1d = aprData?.["1d"]?.apr ?? 0;

  // Report all sortable fields up to parent for filter/sort
  useEffect(() => {
    if (symbol !== "…" && onData) {
      onData({
        symbol,
        oiRaw: totalOiRaw ?? 0n,
        spotRaw: priceRaw ?? 0n,
        longRaw: longPriceRaw ?? 0n,
        shortRaw: shortPriceRaw ?? 0n,
        tvlRaw: totalTvlRaw ?? 0n,
        positions: Number(openPositionCount ?? 0n),
        pctLong,
        pctShort,
        apr7d,
      });
    }
  }, [symbol, totalOiRaw, priceRaw, longPriceRaw, shortPriceRaw, totalTvlRaw, openPositionCount, pctLong, pctShort, apr7d, onData]);

  return (
    <tr
      onClick={() => navigate(path(`markets/${poolAddress}`))}
      style={isClosed || isInactive ? { opacity: 0.55 } : undefined}
    >
      <td>
        <span style={{ fontWeight: 500 }}>{symbol}</span>
        <span style={{ color: "var(--muted)" }}> / USDC</span>
        {(isClosed || isInactive) && (
          <span
            style={{
              marginLeft: 8,
              padding: "1px 6px",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-nano)",
              letterSpacing: "0.1em",
              color: "var(--red)",
              border: "1px solid rgba(255,59,48,0.4)",
              background: "rgba(255,59,48,0.08)",
              verticalAlign: "middle",
            }}
          >
            {isClosed ? "CLOSED" : "INACTIVE"}
          </span>
        )}
      </td>
      <td style={{ color: "var(--cyan)", fontWeight: 500 }}>{price}</td>
      <td style={{ color: "var(--green)" }}>
        {longPrice}
        {longPremium !== undefined && (
          <span style={{ fontSize: "var(--fs-micro)", color: "var(--dim)", marginLeft: 4 }}>
            {longPremium >= 0 ? "+" : ""}{longPremium.toFixed(1)}%
          </span>
        )}
      </td>
      <td style={{ color: "var(--magenta)" }}>
        {shortPrice}
        {shortPremium !== undefined && (
          <span style={{ fontSize: "var(--fs-micro)", color: "var(--dim)", marginLeft: 4 }}>
            {shortPremium >= 0 ? "+" : ""}{shortPremium.toFixed(1)}%
          </span>
        )}
      </td>
      <td>{totalTvl}</td>
      <td style={{ color: apr7d > 0 ? "var(--green)" : "var(--muted)", fontWeight: apr7d > 0 ? 600 : 400 }}>
        {aprData ? `${apr7d.toFixed(1)}%` : "—"}
        {apr1d > 0 && aprData && (
          <span style={{ fontSize: "var(--fs-micro)", color: "var(--dim)", marginLeft: 4 }}>
            ({apr1d.toFixed(0)}% 24h)
          </span>
        )}
      </td>
      <td>{openPositionCount?.toString() ?? "—"}</td>
      <td style={{ color: pctColor(pctLong), fontWeight: pctLong > 0 ? 600 : 400 }}>
        {hasOiData ? formatPct(pctLong) : "—"}
      </td>
      <td style={{ color: pctColor(pctShort), fontWeight: pctShort > 0 ? 600 : 400 }}>
        {hasOiData ? formatPct(pctShort) : "—"}
      </td>
      <td>
        {hasOiData ? (
          <OiCell longOi={longOpenInterest!} shortOi={shortOpenInterest!} />
        ) : (
          <span style={{ color: "var(--dim)" }}>—</span>
        )}
      </td>
    </tr>
  );
}
