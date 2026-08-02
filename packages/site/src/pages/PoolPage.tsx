import { useState, useEffect, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { useAccount, useReadContracts } from "wagmi";
import { exnihiloPoolAbi, erc20Abi, lpNFTAbi } from "@exnihilio/abis";
import { useAppChain } from "../hooks/useAppChain.ts";
import { formatUsdc, formatUsdcCompact, formatToken, decodeSpotPrice } from "../lib/format.ts";
import { premiumPct } from "../components/pool/PoolCard.tsx";
import { usePriceHistory } from "../hooks/usePriceHistory.ts";
import { usePoolApr } from "../hooks/usePoolApr.ts";
import ChainGuard from "../components/wallet/ChainGuard.tsx";
import PoolPriceChart from "../components/pool/PoolPriceChart.tsx";
import LongShortPanel from "../components/trade/LongShortPanel.tsx";
import LpPanel from "../components/trade/LpPanel.tsx";
import SwapPanel from "../components/trade/SwapPanel.tsx";
import { useSeo } from "../lib/seo.ts";

type Tab = "trade" | "swap" | "lp";

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
  return <PoolContent />;
}

function PoolContent() {
  const { poolAddr } = useParams<{ poolAddr: string }>();
  const { address: userAddress } = useAccount();
  const { chainId, addresses, path } = useAppChain();

  const [tab, setTab] = useState<Tab>("trade");
  const tradePanelRef = useRef<HTMLDivElement>(null);
  const [panelHeight, setPanelHeight] = useState(0);

  useEffect(() => {
    if (!tradePanelRef.current) return;
    const ro = new ResizeObserver(([entry]) => setPanelHeight(entry.contentRect.height));
    ro.observe(tradePanelRef.current);
    return () => ro.disconnect();
  }, []);

  if (!poolAddr) return (
    <p style={{ color: "var(--red)", fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}>
      Invalid pool address.
    </p>
  );

  const poolAddress = poolAddr as `0x${string}`;
  const poolContract = { address: poolAddress, abi: exnihiloPoolAbi, chainId } as const;

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
      { ...poolContract, functionName: "longPrice" },            // 10
      { ...poolContract, functionName: "shortPrice" },           // 11
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
  const longPriceRaw       = data?.[10]?.result as bigint | undefined;
  const shortPriceRaw      = data?.[11]?.result as bigint | undefined;

  // Token metadata
  const { data: tokenMeta } = useReadContracts({
    contracts: underlyingToken
      ? [
          { address: underlyingToken, abi: erc20Abi, functionName: "symbol", chainId },
          { address: underlyingToken, abi: erc20Abi, functionName: "decimals", chainId },
        ]
      : [],
    query: { enabled: !!underlyingToken },
  });

  const tokenSymbol   = (tokenMeta?.[0]?.result as string | undefined) ?? "…";
  const tokenDecimals = (tokenMeta?.[1]?.result as number | undefined) ?? 18;

  // Sits here rather than in the PoolPage wrapper because the title needs the
  // symbol, which is only known after the token metadata read resolves. It
  // reruns when tokenSymbol goes from the "…" placeholder to the real ticker.
  //
  // The canonical is the pool address, not the symbol: addresses are unique and
  // permanent, symbols are neither — anyone can deploy a second token calling
  // itself USDC and create a market for it.
  useSeo({
    title: tokenSymbol === "…" ? "Market" : `${tokenSymbol} market`,
    description:
      tokenSymbol === "…"
        ? "Long or short this market on EXNIHILO, with your loss capped at the premium you pay."
        : `Go long or short ${tokenSymbol} on Avalanche with no liquidation risk. Live entry prices, open interest and LP depth for the ${tokenSymbol} market on EXNIHILO.`,
    path: path(`markets/${poolAddress}`),
  });

  // LP ownership — only query once lpNftId is known
  const { data: lpOwnerData } = useReadContracts({
    contracts: lpNftId !== undefined
      ? [{ address: addresses.lpNFT, abi: lpNFTAbi, functionName: "ownerOf", args: [lpNftId], chainId }]
      : [],
    query: { enabled: lpNftId !== undefined },
  });

  const { data: priceHistory } = usePriceHistory(poolAddress, chainId);
  const { data: aprData } = usePoolApr(poolAddress, chainId);

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

  const longPrice =
    longPriceRaw !== undefined && longPriceRaw > 0n
      ? decodeSpotPrice(longPriceRaw, tokenDecimals)
      : "—";

  const shortPrice =
    shortPriceRaw !== undefined && shortPriceRaw > 0n
      ? decodeSpotPrice(shortPriceRaw, tokenDecimals)
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
  const totalOiRaw = hasOiData ? longOpenInterest! + shortOpenInterest! : undefined;
  const longOiShare =
    totalOiRaw !== undefined && totalOiRaw > 0n
      ? Number((longOpenInterest! * 1000n) / totalOiRaw) / 10
      : 0;

  // Entry-price gap vs spot: how far synthetic supply has bent each curve.
  const longPremium  = premiumPct(longPriceRaw, spotPriceRaw);
  const shortPremium = premiumPct(shortPriceRaw, spotPriceRaw);

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
          to={path("markets")}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-body-s)",
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
            fontSize: "var(--fs-label)",
            color: "var(--muted)",
            letterSpacing: "0.05em",
            marginTop: 4,
          }}
        >
          {poolAddress}
        </p>
      </div>

      {/* Stats — row 1: prices */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
        <div className="stat-box">
          <div className="stat-label">SPOT PRICE</div>
          <div className="stat-value" style={{ color: "var(--cyan)" }}>{price}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">LONG PRICE</div>
          <div className="stat-value" style={{ color: "var(--green)" }}>{longPrice}</div>
          {longPremium !== undefined && (
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)", color: "var(--dim)", letterSpacing: "0.04em", marginTop: 2 }}>
              {longPremium >= 0 ? "+" : ""}{longPremium.toFixed(1)}% vs spot
            </div>
          )}
        </div>
        <div className="stat-box">
          <div className="stat-label">SHORT PRICE</div>
          <div className="stat-value" style={{ color: "var(--magenta)" }}>{shortPrice}</div>
          {shortPremium !== undefined && (
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)", color: "var(--dim)", letterSpacing: "0.04em", marginTop: 2 }}>
              {shortPremium >= 0 ? "+" : ""}{shortPremium.toFixed(1)}% vs spot
            </div>
          )}
        </div>
      </div>

      {/* Stats — row 2: reserves + TVL */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
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
        <div className="stat-box">
          <div className="stat-label">TOTAL TVL</div>
          <div className="stat-value">
            {totalTvlRaw !== undefined ? formatUsdcCompact(totalTvlRaw) : "—"}
          </div>
        </div>
      </div>

      {/* APR bar */}
      {aprData && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <div className="stat-box">
            <div className="stat-label">APR (24H)</div>
            <div className="stat-value" style={{ color: aprData["1d"].apr > 0 ? "var(--green)" : "var(--muted)" }}>
              {aprData["1d"].apr.toFixed(1)}%
            </div>
          </div>
          <div className="stat-box" style={{ border: "1px solid var(--green)", boxShadow: "0 0 8px rgba(0,255,100,0.08)" }}>
            <div className="stat-label" style={{ color: "var(--green)" }}>APR (7D)</div>
            <div className="stat-value" style={{ color: "var(--green)", fontWeight: 700 }}>
              {aprData["7d"].apr.toFixed(1)}%
            </div>
          </div>
          <div className="stat-box">
            <div className="stat-label">APR (30D)</div>
            <div className="stat-value" style={{ color: aprData["30d"].apr > 0 ? "var(--green)" : "var(--muted)" }}>
              {aprData["30d"].apr.toFixed(1)}%
            </div>
          </div>
        </div>
      )}

      {/* Stats — row 3: positions + open interest */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <div className="stat-box">
          <div className="stat-label">OPEN POSITIONS</div>
          <div className="stat-value">{openPositionCount?.toString() ?? "—"}</div>
        </div>
        <div
          className="stat-box"
          title="Long open interest as % of the pool's USDC reserves — LP utilization, not trader sentiment. High = the pool is heavily drawn on by longs."
          style={{ cursor: "help" }}
        >
          <div className="stat-label">% LONG · UTIL</div>
          <div
            className="stat-value"
            style={{ color: pctColor(pctLong), fontWeight: pctLong > 0 ? 600 : 400 }}
          >
            {hasOiData ? formatPct(pctLong) : "—"}
          </div>
        </div>
        <div
          className="stat-box"
          title="Short open interest as % of the pool's USDC reserves — LP utilization, not trader sentiment. High = the pool is heavily drawn on by shorts."
          style={{ cursor: "help" }}
        >
          <div className="stat-label">% SHORT · UTIL</div>
          <div
            className="stat-value"
            style={{ color: pctColor(pctShort), fontWeight: pctShort > 0 ? 600 : 400 }}
          >
            {hasOiData ? formatPct(pctShort) : "—"}
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-label">OPEN INTEREST</div>
          {totalOiRaw !== undefined && totalOiRaw > 0n ? (
            <>
              <div className="stat-value">{formatUsdcCompact(totalOiRaw)}</div>
              <div
                style={{ display: "flex", height: 3, marginTop: 6, background: "var(--dim)" }}
                title={`Long ${formatUsdcCompact(longOpenInterest!)} / Short ${formatUsdcCompact(shortOpenInterest!)}`}
              >
                <span style={{ width: `${longOiShare}%`, background: "var(--green)" }} />
                <span style={{ flex: 1, background: "var(--magenta)" }} />
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--fs-nano)",
                  letterSpacing: "0.04em",
                  marginTop: 3,
                }}
              >
                <span style={{ color: "var(--green)" }}>L {formatUsdcCompact(longOpenInterest!)}</span>
                <span style={{ color: "var(--magenta)" }}>S {formatUsdcCompact(shortOpenInterest!)}</span>
              </div>
            </>
          ) : (
            <div className="stat-value" style={{ color: "var(--dim)" }}>—</div>
          )}
        </div>
      </div>

      {/* Trade panel + Chart — wraps to a stacked layout on narrow screens */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
        {/* Trade panel */}
        <div
          ref={tradePanelRef}
          style={{
            width: "min(500px, 100%)",
            flexShrink: 0,
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
            <ChainGuard>
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
            </ChainGuard>
          </div>
        </div>

        {/* Price chart */}
        <div
          style={{
            flex: "1 1 300px",
            maxWidth: "100%",
            height: panelHeight || 420,
            position: "relative",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            overflow: "hidden",
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
              zIndex: 1,
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
              zIndex: 1,
            }}
          />

          {/* Token label overlay */}
          <div
            style={{
              position: "absolute",
              top: 16,
              left: 20,
              zIndex: 2,
              fontFamily: "var(--font-display)",
              fontSize: "1.4rem",
              color: "rgba(255,255,255,0.12)",
              letterSpacing: "0.08em",
              lineHeight: 1,
              pointerEvents: "none",
            }}
          >
            {tokenSymbol}
          </div>

          <PoolPriceChart
            highlightLine={null}
            priceData={priceHistory}
            spotLabel={price}
            longLabel={longPrice}
            shortLabel={shortPrice}
          />
        </div>
      </div>
    </div>
  );
}
