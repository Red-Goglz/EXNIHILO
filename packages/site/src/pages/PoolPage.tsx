import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useAccount, useChainId, useReadContracts } from "wagmi";
import { exnihiloPoolAbi, erc20Abi, lpNFTAbi } from "@exnihilio/abis";
import { getAddresses } from "../contracts/addresses.ts";
import { formatUsdc, formatToken, decodeSpotPrice } from "../lib/format.ts";
import ChainGuard from "../components/wallet/ChainGuard.tsx";
import LongShortPanel from "../components/trade/LongShortPanel.tsx";
import LpPanel from "../components/trade/LpPanel.tsx";
import SwapPanel from "../components/trade/SwapPanel.tsx";

type Tab = "trade" | "swap" | "lp";

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
    >
      <span style={{ letterSpacing: "0.05em", fontSize: "1rem" }}>
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
          {/* Cyber corner accent */}
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

function pctColor(pct: number): string {
  if (pct === 0) return "var(--muted)";
  if (pct <= 33) return "var(--green)";
  if (pct <= 66) return "var(--orange)";
  return "var(--red)";
}

function formatPct(pct: number): string {
  if (pct === 0) return "0%";
  return `${pct.toFixed(2)}%`;
}

export default function PoolPage() {
  return (
    <ChainGuard>
      <PoolContent />
    </ChainGuard>
  );
}

function PoolContent() {
  const { poolAddr } = useParams<{ poolAddr: string }>();
  const { address: userAddress } = useAccount();
  const chainId = useChainId();
  const addresses = getAddresses(chainId);

  const [tab, setTab] = useState<Tab>("trade");

  if (!poolAddr) return (
    <p style={{ color: "var(--red)", fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}>
      Invalid pool address.
    </p>
  );

  const poolAddress = poolAddr as `0x${string}`;
  const poolContract = { address: poolAddress, abi: exnihiloPoolAbi } as const;

  const { data } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "underlyingToken" },       // 0
      { ...poolContract, functionName: "underlyingUsdc" },       // 1
      { ...poolContract, functionName: "backedAirToken" },        // 2
      { ...poolContract, functionName: "backedAirUsd" },         // 3
      { ...poolContract, functionName: "spotPrice" },            // 4
      { ...poolContract, functionName: "openPositionCount" },    // 5
      { ...poolContract, functionName: "swapFeeBps" },           // 6
      { ...poolContract, functionName: "longOpenInterest" },     // 7
      { ...poolContract, functionName: "shortOpenInterest" },    // 8
      { ...poolContract, functionName: "lpNftId" },              // 9
    ],
  });

  const underlyingToken     = data?.[0]?.result as `0x${string}` | undefined;
  const underlyingUsdc     = data?.[1]?.result as `0x${string}` | undefined;
  const backedAirToken      = data?.[2]?.result as bigint | undefined;
  const backedAirUsd       = data?.[3]?.result as bigint | undefined;
  const spotPriceRaw       = data?.[4]?.result as bigint | undefined;
  const openPositionCount  = data?.[5]?.result as bigint | undefined;
  const longOpenInterest   = data?.[7]?.result as bigint | undefined;
  const shortOpenInterest  = data?.[8]?.result as bigint | undefined;
  const lpNftId            = data?.[9]?.result as bigint | undefined;

  // Token metadata
  const { data: tokenMeta } = useReadContracts({
    contracts: underlyingToken
      ? [
          { address: underlyingToken, abi: erc20Abi, functionName: "symbol" },
          { address: underlyingToken, abi: erc20Abi, functionName: "decimals" },
        ]
      : [],
    query: { enabled: !!underlyingToken },
  });

  const tokenSymbol   = (tokenMeta?.[0]?.result as string | undefined) ?? "…";
  const tokenDecimals = (tokenMeta?.[1]?.result as number | undefined) ?? 18;

  // LP ownership — only query once lpNftId is known
  const { data: lpOwnerData } = useReadContracts({
    contracts: lpNftId !== undefined
      ? [{ address: addresses.lpNFT, abi: lpNFTAbi, functionName: "ownerOf", args: [lpNftId] }]
      : [],
    query: { enabled: lpNftId !== undefined },
  });

  const lpOwner   = lpOwnerData?.[0]?.result as `0x${string}` | undefined;
  const isLpHolder = !!userAddress && !!lpOwner &&
    lpOwner.toLowerCase() === userAddress.toLowerCase();

  // If the LP tab is active but wallet is not LP holder, fall back to trade
  useEffect(() => {
    if (tab === "lp" && !isLpHolder) setTab("trade");
  }, [isLpHolder, tab]);


  // Derived stats
  const price =
    spotPriceRaw !== undefined && spotPriceRaw > 0n
      ? decodeSpotPrice(spotPriceRaw, tokenDecimals)
      : "—";

  // TVL = token side (in USDC) + USDC side
  // spotPriceRaw = (backedAirUsd * 1e18) / backedAirToken
  // token value in raw USDC = backedAirToken * spotPriceRaw / 1e18
  const tokenValueRaw =
    backedAirToken !== undefined && spotPriceRaw !== undefined && spotPriceRaw > 0n
      ? (backedAirToken * spotPriceRaw) / (10n ** 18n)
      : undefined;
  const totalTvlRaw =
    tokenValueRaw !== undefined && backedAirUsd !== undefined
      ? tokenValueRaw + backedAirUsd
      : undefined;

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

  const tabs: { key: Tab; label: string }[] = [
    { key: "trade", label: "LONG / SHORT" },
    { key: "swap",  label: "SWAP" },
    ...(isLpHolder ? [{ key: "lp" as Tab, label: "LIQUIDITY" }] : []),
  ];

  return (
    <div>
      {/* Breadcrumb */}
      <div className="mb-5">
        <Link
          to="/app/markets"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            letterSpacing: "0.1em",
            color: "var(--muted)",
            textDecoration: "none",
            transition: "color 0.15s",
          }}
          onMouseEnter={(e) => ((e.target as HTMLElement).style.color = "var(--body)")}
          onMouseLeave={(e) => ((e.target as HTMLElement).style.color = "var(--muted)")}
        >
          ← MARKETS
        </Link>
      </div>

      {/* Pool header */}
      <div className="mb-6">
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "2.2rem",
            color: "#fff",
            letterSpacing: "0.05em",
            lineHeight: 1,
          }}
        >
          {tokenSymbol !== "…" ? `${tokenSymbol} / USDC` : "LOADING…"}
        </h1>
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.62rem",
            color: "var(--muted)",
            letterSpacing: "0.05em",
            marginTop: 4,
          }}
        >
          {poolAddress}
        </p>
      </div>

      {/* Stats — row 1: price, reserves */}
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div className="stat-box">
          <div className="stat-label">PRICE</div>
          <div className="stat-value" style={{ color: "var(--cyan)" }}>{price}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">BACKED {tokenSymbol !== "…" ? tokenSymbol : "TOKEN"}</div>
          <div className="stat-value">
            {backedAirToken !== undefined ? formatToken(backedAirToken, tokenDecimals) : "—"}
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-label">BACKED USDC</div>
          <div className="stat-value">
            {backedAirUsd !== undefined ? formatUsdc(backedAirUsd) : "—"}
          </div>
        </div>
      </div>

      {/* Stats — row 2: positions, OI, rating */}
      <div className="grid grid-cols-4 gap-3 mb-8">
        <div className="stat-box">
          <div className="stat-label">OPEN POSITIONS</div>
          <div className="stat-value">{openPositionCount?.toString() ?? "—"}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">% LONG</div>
          <div
            className="stat-value"
            style={{ color: pctColor(pctLong), fontWeight: pctLong > 0 ? 600 : 400 }}
          >
            {hasOiData ? formatPct(pctLong) : "—"}
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-label">% SHORT</div>
          <div
            className="stat-value"
            style={{ color: pctColor(pctShort), fontWeight: pctShort > 0 ? 600 : 400 }}
          >
            {hasOiData ? formatPct(pctShort) : "—"}
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-label">RATING</div>
          <div style={{ marginTop: 4 }}>
            <StarsWithTooltip count={rating} />
          </div>
        </div>
      </div>

      {/* Trade panel */}
      <div
        style={{
          maxWidth: 500,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          position: "relative",
        }}
      >
        {/* Cyber corner decoration */}
        <span
          style={{
            position: "absolute",
            top: -1, left: -1,
            width: 12, height: 12,
            borderTop: "1px solid var(--cyan)",
            borderLeft: "1px solid var(--cyan)",
            pointerEvents: "none",
          }}
        />
        <span
          style={{
            position: "absolute",
            bottom: -1, right: -1,
            width: 12, height: 12,
            borderBottom: "1px solid var(--cyan)",
            borderRight: "1px solid var(--cyan)",
            pointerEvents: "none",
          }}
        />

        {/* Tab bar */}
        <div className="tab-bar" style={{ margin: 0 }}>
          {tabs.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`tab-item${tab === key ? " active" : ""}`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Panel content */}
        <div style={{ padding: "20px 24px 24px" }}>
          {underlyingToken && underlyingUsdc ? (
            <>
              {tab === "trade" && (
                <LongShortPanel
                  poolAddress={poolAddress}
                  underlyingUsdc={underlyingUsdc}
                  tokenSymbol={tokenSymbol}
                  tokenDecimals={tokenDecimals}
                />
              )}
              {tab === "swap" && (
                <SwapPanel
                  poolAddress={poolAddress}
                  underlyingToken={underlyingToken}
                  underlyingUsdc={underlyingUsdc}
                  tokenSymbol={tokenSymbol}
                  tokenDecimals={tokenDecimals}
                />
              )}
              {tab === "lp" && isLpHolder && (
                <LpPanel
                  poolAddress={poolAddress}
                  lpNftAddress={addresses.lpNFT}
                  underlyingToken={underlyingToken}
                  underlyingUsdc={underlyingUsdc}
                  tokenSymbol={tokenSymbol}
                  tokenDecimals={tokenDecimals}
                />
              )}
            </>
          ) : (
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.7rem",
                color: "var(--muted)",
                letterSpacing: "0.1em",
              }}
            >
              <span className="spinner">⟳</span> LOADING
              <span className="cursor-blink">_</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
