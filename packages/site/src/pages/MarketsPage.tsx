import { useState, useCallback } from "react";
import { useChainId, useReadContract, useReadContracts } from "wagmi";
import { exnihiloFactoryAbi } from "@exnihilio/abis";
import { getAddresses } from "../contracts/addresses.ts";
import PoolCard from "../components/pool/PoolCard.tsx";
import { Link } from "react-router-dom";

export default function MarketsPage() {
  return <MarketsContent />;
}

function MarketsContent() {
  const chainId = useChainId();
  const addresses = getAddresses(chainId);

  const [search, setSearch] = useState("");
  const [sortByRating, setSortByRating] = useState(true);
  // poolMeta: symbol + rating reported back from each PoolCard as data loads
  const [poolMeta, setPoolMeta] = useState<Record<string, { symbol: string; rating: number }>>({});

  const handlePoolData = useCallback((addr: string) => (symbol: string, rating: number) => {
    setPoolMeta((prev) => {
      if (prev[addr]?.symbol === symbol && prev[addr]?.rating === rating) return prev;
      return { ...prev, [addr]: { symbol, rating } };
    });
  }, []);

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

  // Sort by rating descending if requested
  const sorted = sortByRating
    ? [...filtered].sort((a, b) => (poolMeta[b]?.rating ?? 0) - (poolMeta[a]?.rating ?? 0))
    : filtered;

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

      {/* Filter + Sort controls */}
      {!isLoading && poolCount > 0 && (
        <div
          style={{
            display: "flex",
            gap: 8,
            marginBottom: 16,
            alignItems: "center",
          }}
        >
          {/* Search */}
          <div style={{ position: "relative", flex: 1, maxWidth: 280 }}>
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

          {/* Sort toggle */}
          <button
            onClick={() => setSortByRating((v) => !v)}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.62rem",
              letterSpacing: "0.08em",
              padding: "7px 14px",
              border: `1px solid ${sortByRating ? "var(--cyan)" : "var(--border)"}`,
              background: sortByRating ? "rgba(0,229,255,0.07)" : "transparent",
              color: sortByRating ? "var(--cyan)" : "var(--muted)",
              cursor: "pointer",
              transition: "all 0.15s",
              whiteSpace: "nowrap",
            }}
          >
            ★ RATING {sortByRating ? "↓" : "—"}
          </button>
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
                <th>MARKET</th>
                <th>PRICE</th>
                <th>TOTAL TVL</th>
                <th>POSITIONS</th>
                <th>% LONG</th>
                <th>% SHORT</th>
                <th>RATING</th>
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
