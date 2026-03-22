import { useState, useCallback } from "react";
import { useChainId, useReadContract, useReadContracts } from "wagmi";
import { exnihiloFactoryAbi } from "@exnihilio/abis";
import { getAddresses } from "../contracts/addresses.ts";
import PoolCard from "../components/pool/PoolCard.tsx";
import type { PoolMeta } from "../components/pool/PoolCard.tsx";
import { Link } from "react-router-dom";

type SortCol = "market" | "spot" | "long" | "short" | "tvl" | "positions" | "pctLong" | "pctShort" | "rating";
type SortDir = "asc" | "desc";

const COLUMNS: { key: SortCol; label: string }[] = [
  { key: "market",    label: "MARKET" },
  { key: "spot",      label: "SPOT" },
  { key: "long",      label: "LONG" },
  { key: "short",     label: "SHORT" },
  { key: "tvl",       label: "TOTAL TVL" },
  { key: "positions", label: "POSITIONS" },
  { key: "pctLong",   label: "% LONG" },
  { key: "pctShort",  label: "% SHORT" },
  { key: "rating",    label: "RATING" },
];

function comparePools(a: PoolMeta | undefined, b: PoolMeta | undefined, col: SortCol, dir: SortDir): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;

  let cmp = 0;
  switch (col) {
    case "market":    cmp = a.symbol.localeCompare(b.symbol); break;
    case "spot":      cmp = a.spotRaw < b.spotRaw ? -1 : a.spotRaw > b.spotRaw ? 1 : 0; break;
    case "long":      cmp = a.longRaw < b.longRaw ? -1 : a.longRaw > b.longRaw ? 1 : 0; break;
    case "short":     cmp = a.shortRaw < b.shortRaw ? -1 : a.shortRaw > b.shortRaw ? 1 : 0; break;
    case "tvl":       cmp = a.tvlRaw < b.tvlRaw ? -1 : a.tvlRaw > b.tvlRaw ? 1 : 0; break;
    case "positions": cmp = a.positions - b.positions; break;
    case "pctLong":   cmp = a.pctLong - b.pctLong; break;
    case "pctShort":  cmp = a.pctShort - b.pctShort; break;
    case "rating":    cmp = a.rating - b.rating; break;
  }
  return dir === "desc" ? -cmp : cmp;
}

export default function MarketsPage() {
  return <MarketsContent />;
}

function MarketsContent() {
  const chainId = useChainId();
  const addresses = getAddresses(chainId);

  const [search, setSearch] = useState("");
  const [sortCol, setSortCol] = useState<SortCol>("rating");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [poolMeta, setPoolMeta] = useState<Record<string, PoolMeta>>({});

  const handlePoolData = useCallback((addr: string) => (meta: PoolMeta) => {
    setPoolMeta((prev) => {
      const existing = prev[addr];
      if (
        existing &&
        existing.symbol === meta.symbol &&
        existing.rating === meta.rating &&
        existing.spotRaw === meta.spotRaw &&
        existing.tvlRaw === meta.tvlRaw &&
        existing.positions === meta.positions
      ) return prev;
      return { ...prev, [addr]: meta };
    });
  }, []);

  const handleSort = (col: SortCol) => {
    if (sortCol === col) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
  };

  const factoryContract = {
    address: addresses.factory,
    abi: exnihiloFactoryAbi,
  } as const;

  const { data: poolLength, isLoading: lengthLoading } = useReadContract({
    ...factoryContract,
    functionName: "allPoolsLength",
  });

  const poolCount = Number(poolLength ?? 0n);
  const indices = Array.from({ length: poolCount }, (_, i) => i);

  const { data: poolResults, isLoading: poolsLoading } = useReadContracts({
    contracts: indices.map((i) => ({
      ...factoryContract,
      functionName: "allPools" as const,
      args: [BigInt(i)] as const,
    })),
    query: { enabled: poolCount > 0 },
  });

  const allPoolAddresses = poolResults
    ?.map((r) => r.result as `0x${string}` | undefined)
    .filter((r): r is `0x${string}` => Boolean(r)) ?? [];

  const isLoading = lengthLoading || poolsLoading;

  // Filter by search term (pass through pools whose symbol hasn't loaded yet)
  const term = search.trim().toLowerCase();
  const filtered = allPoolAddresses.filter((addr) => {
    if (!term) return true;
    const meta = poolMeta[addr];
    if (!meta) return true; // still loading — keep visible
    return meta.symbol.toLowerCase().includes(term);
  });

  // Sort by selected column
  const sorted = [...filtered].sort((a, b) =>
    comparePools(poolMeta[a], poolMeta[b], sortCol, sortDir)
  );

  // Empty state — show the big hero
  if (!isLoading && poolCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-5">
        <span
          className="logo-glitch"
          data-text="EXNIHILO"
          style={{ fontSize: "clamp(3rem, 10vw, 6rem)" }}
        >
          EXNIHILO
        </span>

        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "clamp(0.75rem, 2vw, 1rem)",
            letterSpacing: "0.2em",
            color: "var(--muted)",
          }}
        >
          Out of Thin Air
        </p>

        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            letterSpacing: "0.1em",
            color: "var(--muted)",
            maxWidth: 480,
            textAlign: "center",
          }}
        >
          Permissionless, LP-Governed, NFT-Based Leveraged Trading
        </p>

        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.62rem",
            letterSpacing: "0.18em",
            color: "var(--red)",
          }}
        >
          ⬡ BUILT ON AVALANCHE
        </p>

        <div
          style={{
            width: "100%",
            maxWidth: 400,
            height: "1px",
            background: "var(--border)",
            margin: "12px 0",
          }}
        />

        <Link
          to="/app/create"
          className="btn-terminal btn-cyan"
          style={{ fontSize: "0.7rem", padding: "10px 28px" }}
        >
          CREATE FIRST MARKET
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "2rem",
              color: "#fff",
              letterSpacing: "0.05em",
              lineHeight: 1,
            }}
          >
            MARKETS
          </h1>
          {!isLoading && (
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.62rem",
                color: "var(--muted)",
                letterSpacing: "0.1em",
                marginTop: 4,
              }}
            >
              {poolCount} POOL{poolCount !== 1 ? "S" : ""} ACTIVE
            </p>
          )}
        </div>

        <Link
          to="/app/create"
          className="btn-terminal btn-cyan"
          style={{ fontSize: "0.65rem" }}
        >
          + CREATE
        </Link>
      </div>

      {/* Search */}
      {!isLoading && poolCount > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ position: "relative", maxWidth: 280 }}>
            <span
              style={{
                position: "absolute",
                left: 10,
                top: "50%",
                transform: "translateY(-50%)",
                fontFamily: "var(--font-mono)",
                fontSize: "0.65rem",
                color: "var(--dim)",
                pointerEvents: "none",
              }}
            >
              ⌕
            </span>
            <input
              type="text"
              placeholder="SEARCH MARKET…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input-terminal"
              style={{
                width: "100%",
                paddingLeft: 28,
                fontSize: "0.65rem",
                letterSpacing: "0.08em",
              }}
            />
          </div>
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.7rem",
            color: "var(--muted)",
            padding: "40px 0",
            letterSpacing: "0.1em",
          }}
        >
          <span className="spinner">⟳</span> LOADING MARKETS
          <span className="cursor-blink">_</span>
        </div>
      )}

      {/* Table */}
      {!isLoading && sorted.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table className="markets-table">
            <thead>
              <tr>
                {COLUMNS.map(({ key, label }) => {
                  const active = sortCol === key;
                  return (
                    <th
                      key={key}
                      onClick={() => handleSort(key)}
                      style={{
                        cursor: "pointer",
                        userSelect: "none",
                        color: active ? "var(--cyan)" : undefined,
                        transition: "color 0.15s",
                      }}
                    >
                      {label}{" "}
                      {active ? (sortDir === "desc" ? "↓" : "↑") : ""}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map((addr) => (
                <PoolCard
                  key={addr}
                  poolAddress={addr}
                  onData={handlePoolData(addr)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* No results after filter */}
      {!isLoading && sorted.length === 0 && poolCount > 0 && (
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            color: "var(--muted)",
            letterSpacing: "0.1em",
            padding: "32px 0",
          }}
        >
          NO MARKETS MATCH "{search.toUpperCase()}"
        </p>
      )}
    </div>
  );
}
