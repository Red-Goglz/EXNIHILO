import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { useAppChain } from "../hooks/useAppChain.ts";
import { hasIndexer, indexerFetch } from "../lib/indexer.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProtocolMetrics {
  totalPositionVolume: string;
  totalPayout: string;
  totalFees: string;
  totalLpFees: string;
  totalProtocolFees: string;
  totalPositions: number;
  totalCloses: number;
  poolCount: number;
}

interface PoolMetric {
  pool: string;
  positionVolume: string;
  totalFees: string;
  lpFees: string;
  protocolFees: string;
  longCount: number;
  shortCount: number;
  closeCount: number;
  totalPayout: string;
}

interface UserMetrics {
  totalUsers: number;
  activeUsers30d: number;
  activeUsers7d: number;
  totalUserVolume: string;
  totalUserFeesPaid: string;
}

interface UserDetail {
  address: string;
  firstSeen: number;
  lastSeen: number;
  longCount: number;
  shortCount: number;
  closeCount: number;
  totalVolume: string;
  totalFeesPaid: string;
  totalPayout: string;
}

interface DailyPoint {
  date: number;
  volume: string;
  fees: string;
  positions: number;
  closes: number;
  users: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtUsd(raw: string): string {
  const n = Number(raw) / 1e6;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(6).replace(/0+$/, "")}`;
  return "$0";
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

async function fetchJson<T>(path: string, chainId: number): Promise<T | null> {
  try {
    return await indexerFetch<T>(chainId, path);
  } catch {
    return null;
  }
}

// ─── Stat components ─────────────────────────────────────────────────────────

function StatBox({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="stat-box">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color: color ?? "var(--body)" }}>{value}</div>
    </div>
  );
}

function SectionHeader({ children }: { children: string }) {
  return (
    <h2 style={{
      fontFamily: "var(--font-display)",
      fontSize: "1.1rem",
      letterSpacing: "0.08em",
      color: "#fff",
      marginBottom: 12,
      marginTop: 32,
    }}>
      {children}
    </h2>
  );
}

// ─── Bar chart (SVG) ─────────────────────────────────────────────────────────

function MiniBarChart({
  data,
  color = "var(--cyan)",
  height = 80,
}: {
  data: { label: string; value: number }[];
  color?: string;
  height?: number;
}) {
  if (data.length === 0) return null;
  const max = Math.max(...data.map((d) => d.value), 1);
  const W = 500;
  const barW = Math.min(40, (W - data.length * 2) / data.length);
  const gap = 2;

  return (
    <svg viewBox={`0 0 ${W} ${height + 20}`} style={{ width: "100%", maxWidth: W, display: "block" }}>
      {data.map((d, i) => {
        const barH = (d.value / max) * height;
        const x = i * (barW + gap);
        return (
          <g key={i}>
            <rect x={x} y={height - barH} width={barW} height={barH}
              fill={color} opacity="0.7" rx="1" />
            <text x={x + barW / 2} y={height + 14} textAnchor="middle"
              fill="var(--dim)" fontSize="7" fontFamily="var(--font-mono)">
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const { address } = useAccount();
  const { chainId, label: chainLabel } = useAppChain();

  const indexed = hasIndexer(chainId);

  // chainId is part of every query key, so switching chains reads a different
  // cache entry instead of leaving the previous chain's numbers on screen.
  const overview = useQuery({
    queryKey: ["analytics", chainId],
    enabled: indexed,
    staleTime: 30_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      const [p, pm, u, d] = await Promise.all([
        fetchJson<ProtocolMetrics>("/metrics/protocol", chainId),
        fetchJson<{ pools: PoolMetric[] }>("/metrics/pools", chainId),
        fetchJson<UserMetrics>("/metrics/users", chainId),
        fetchJson<{ days: DailyPoint[] }>("/metrics/daily?days=30", chainId),
      ]);
      return { protocol: p, pools: pm?.pools ?? [], users: u, daily: d?.days ?? [] };
    },
  });

  const myStatsQuery = useQuery({
    queryKey: ["analyticsUser", chainId, address],
    enabled: indexed && !!address,
    staleTime: 30_000,
    queryFn: () =>
      fetchJson<UserDetail>(`/metrics/user/${address!.toLowerCase()}`, chainId),
  });

  const protocol = overview.data?.protocol ?? null;
  const pools = overview.data?.pools ?? [];
  const users = overview.data?.users ?? null;
  const daily = useMemo(() => overview.data?.daily ?? [], [overview.data]);
  const myStats = myStatsQuery.data ?? null;
  const loading = overview.isPending;

  const dailyChartData = useMemo(() =>
    daily.map((d) => ({
      label: fmtDate(d.date),
      value: Number(d.volume) / 1e6,
    })),
    [daily],
  );

  const dailyFeesData = useMemo(() =>
    daily.map((d) => ({
      label: fmtDate(d.date),
      value: Number(d.fees) / 1e6,
    })),
    [daily],
  );

  const dailyUsersData = useMemo(() =>
    daily.map((d) => ({
      label: fmtDate(d.date),
      value: d.users,
    })),
    [daily],
  );

  if (!indexed) {
    return (
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--muted)", letterSpacing: "0.1em", padding: "40px 0" }}>
        NO INDEXER FOR {chainLabel} — ANALYTICS UNAVAILABLE ON THIS CHAIN
      </div>
    );
  }

  if (loading) {
    return (
      <p style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--muted)", letterSpacing: "0.1em" }}>
        <span className="spinner">⟳</span> LOADING ANALYTICS<span className="cursor-blink">_</span>
      </p>
    );
  }

  return (
    <div>
      <h1 style={{
        fontFamily: "var(--font-display)",
        fontSize: "2.2rem",
        color: "#fff",
        letterSpacing: "0.05em",
        lineHeight: 1,
        marginBottom: 6,
      }}>
        ANALYTICS
      </h1>
      <p style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-label)",
        color: "var(--muted)",
        letterSpacing: "0.06em",
        marginBottom: 24,
      }}>
        Protocol-wide metrics from the on-chain indexer
      </p>

      {/* ── Protocol overview ───────────────────────────────────────────── */}
      {protocol && (
        <>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <StatBox label="POSITION VOLUME" value={fmtUsd(protocol.totalPositionVolume)} color="var(--cyan)" />
            <StatBox label="TOTAL PAYOUT" value={fmtUsd(protocol.totalPayout)} />
            <StatBox label="POOLS" value={String(protocol.poolCount)} color="var(--cyan)" />
          </div>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <StatBox label="TOTAL FEES" value={fmtUsd(protocol.totalFees)} color="var(--green)" />
            <StatBox label="LP FEES" value={fmtUsd(protocol.totalLpFees)} />
            <StatBox label="PROTOCOL FEES" value={fmtUsd(protocol.totalProtocolFees)} />
          </div>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <StatBox label="POSITIONS OPENED" value={String(protocol.totalPositions)} />
            <StatBox label="POSITIONS CLOSED" value={String(protocol.totalCloses)} />
          </div>
        </>
      )}

      {/* ── User metrics ────────────────────────────────────────────────── */}
      {users && (
        <>
          <SectionHeader>USERS</SectionHeader>
          <div className="grid grid-cols-4 gap-3 mb-3">
            <StatBox label="TOTAL USERS" value={String(users.totalUsers)} color="var(--cyan)" />
            <StatBox label="ACTIVE 7D" value={String(users.activeUsers7d)} />
            <StatBox label="ACTIVE 30D" value={String(users.activeUsers30d)} />
            <StatBox label="USER VOLUME" value={fmtUsd(users.totalUserVolume)} />
          </div>
        </>
      )}

      {/* ── Connected user stats ────────────────────────────────────────── */}
      {myStats && (
        <>
          <SectionHeader>YOUR STATS</SectionHeader>
          <div className="grid grid-cols-4 gap-3 mb-3">
            <StatBox label="YOUR VOLUME" value={fmtUsd(myStats.totalVolume)} color="var(--cyan)" />
            <StatBox label="FEES PAID" value={fmtUsd(myStats.totalFeesPaid)} />
            <StatBox label="PAYOUT" value={fmtUsd(myStats.totalPayout)} color="var(--green)" />
            <StatBox label="LONGS" value={String(myStats.longCount)} />
          </div>
          <div className="grid grid-cols-4 gap-3 mb-3">
            <StatBox label="SHORTS" value={String(myStats.shortCount)} />
            <StatBox label="CLOSES" value={String(myStats.closeCount)} />
            <StatBox label="FIRST SEEN" value={fmtDate(myStats.firstSeen)} />
            <StatBox label="LAST SEEN" value={fmtDate(myStats.lastSeen)} />
          </div>
        </>
      )}

      {/* ── Daily charts ────────────────────────────────────────────────── */}
      {daily.length > 0 && (
        <>
          <SectionHeader>DAILY VOLUME (30D)</SectionHeader>
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", padding: 16, position: "relative", marginBottom: 12 }}>
            <span style={{ position: "absolute", top: -1, left: -1, width: 10, height: 10, borderTop: "1px solid var(--cyan)", borderLeft: "1px solid var(--cyan)", pointerEvents: "none" }} />
            <span style={{ position: "absolute", bottom: -1, right: -1, width: 10, height: 10, borderBottom: "1px solid var(--cyan)", borderRight: "1px solid var(--cyan)", pointerEvents: "none" }} />
            <MiniBarChart data={dailyChartData} color="#00e5ff" />
          </div>

          <SectionHeader>DAILY FEES (30D)</SectionHeader>
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", padding: 16, position: "relative", marginBottom: 12 }}>
            <span style={{ position: "absolute", top: -1, left: -1, width: 10, height: 10, borderTop: "1px solid var(--green)", borderLeft: "1px solid var(--green)", pointerEvents: "none" }} />
            <span style={{ position: "absolute", bottom: -1, right: -1, width: 10, height: 10, borderBottom: "1px solid var(--green)", borderRight: "1px solid var(--green)", pointerEvents: "none" }} />
            <MiniBarChart data={dailyFeesData} color="#00ff88" />
          </div>

          <SectionHeader>DAILY UNIQUE USERS (30D)</SectionHeader>
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", padding: 16, position: "relative", marginBottom: 12 }}>
            <span style={{ position: "absolute", top: -1, left: -1, width: 10, height: 10, borderTop: "1px solid var(--orange)", borderLeft: "1px solid var(--orange)", pointerEvents: "none" }} />
            <span style={{ position: "absolute", bottom: -1, right: -1, width: 10, height: 10, borderBottom: "1px solid var(--orange)", borderRight: "1px solid var(--orange)", pointerEvents: "none" }} />
            <MiniBarChart data={dailyUsersData} color="#ff9500" />
          </div>
        </>
      )}

      {/* ── Pool breakdown ──────────────────────────────────────────────── */}
      {pools.length > 0 && (
        <>
          <SectionHeader>POOL BREAKDOWN</SectionHeader>
          <div style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            position: "relative",
            overflow: "auto",
          }}>
            <span style={{ position: "absolute", top: -1, left: -1, width: 10, height: 10, borderTop: "1px solid var(--cyan)", borderLeft: "1px solid var(--cyan)", pointerEvents: "none" }} />
            <span style={{ position: "absolute", bottom: -1, right: -1, width: 10, height: 10, borderBottom: "1px solid var(--cyan)", borderRight: "1px solid var(--cyan)", pointerEvents: "none" }} />
            <table style={{
              width: "100%",
              borderCollapse: "collapse",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-label)",
              letterSpacing: "0.04em",
            }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["POOL", "VOLUME", "FEES", "LONGS", "SHORTS", "CLOSES"].map((h) => (
                    <th key={h} style={{
                      padding: "10px 12px",
                      textAlign: "left",
                      color: "var(--muted)",
                      fontWeight: 600,
                      letterSpacing: "0.1em",
                      fontSize: "var(--fs-micro)",
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pools.map((p) => (
                  <tr key={p.pool} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "10px 12px", color: "var(--cyan)" }}>{shortAddr(p.pool)}</td>
                    <td style={{ padding: "10px 12px" }}>{fmtUsd(p.positionVolume)}</td>
                    <td style={{ padding: "10px 12px", color: "var(--green)" }}>{fmtUsd(p.totalFees)}</td>
                    <td style={{ padding: "10px 12px" }}>{p.longCount}</td>
                    <td style={{ padding: "10px 12px" }}>{p.shortCount}</td>
                    <td style={{ padding: "10px 12px" }}>{p.closeCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
