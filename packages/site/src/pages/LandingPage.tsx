import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { DEFAULT_CHAIN } from "../lib/chains.ts";
import { hasIndexer, indexerFetch } from "../lib/indexer.ts";
import { formatUsdcCompact } from "../lib/format.ts";

export default function LandingPage() {
  return (
    <div style={{ fontFamily: "var(--font-mono)", color: "var(--body)" }}>
      {/* ── NAV ──────────────────────────────────────────────────────────── */}
      <nav
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 md:px-12 py-4"
        style={{
          background: "rgba(0,0,0,0.85)",
          backdropFilter: "blur(12px)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span className="logo-glitch text-2xl" data-text="EXNIHILO">
          EXNIHILO
        </span>
        <div className="flex items-center gap-6">
          <a
            href="/docs"
            className="section-label hidden sm:block"
            style={{ transition: "color 0.15s" }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.color = "var(--cyan)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.color = "var(--muted)")
            }
          >
            Docs
          </a>
          <Link to="/app" className="btn btn-primary text-xs py-2 px-5">
            Launch App
          </Link>
        </div>
      </nav>

      {/* ── HERO ─────────────────────────────────────────────────────────── */}
      <section className="min-h-screen flex flex-col items-center justify-center text-center px-6 pt-20">
        <div className="fade-up">
          <p className="section-label mb-4">Out of Thin Air</p>
          <h1
            className="logo-glitch text-6xl md:text-8xl lg:text-9xl mb-6"
            data-text="EXNIHILO"
          >
            EXNIHILO
          </h1>
        </div>

        <p
          className="fade-up fade-up-d1 font-mono text-xl md:text-3xl max-w-2xl mb-3"
          style={{ color: "var(--body)" }}
        >
          $5 moves like $100. And nothing can liquidate you.
        </p>
        <p
          className="fade-up fade-up-d2 font-mono text-base md:text-lg max-w-2xl mb-10"
          style={{ color: "var(--muted)" }}
        >
          Long or short any ERC-20 token on Avalanche. You pay a fee, not
          collateral &mdash; and that fee is the most you can ever lose.
        </p>

        <div className="fade-up fade-up-d3 flex flex-col sm:flex-row gap-4">
          <Link to="/app" className="btn btn-primary">
            Launch App
          </Link>
          <a href="/docs" className="btn btn-outline">
            Read Docs
          </a>
        </div>

        {/* scroll hint */}
        <div className="fade-up fade-up-d4 mt-20" style={{ color: "var(--dim)" }}>
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="mx-auto animate-bounce"
          >
            <path d="M4 7l6 6 6-6" />
          </svg>
        </div>
      </section>

      {/* ── HOW IT WORKS ─────────────────────────────────────────────────── */}
      <section className="max-w-4xl mx-auto px-6 py-24">
        <p className="section-label mb-2 text-center">How it works</p>
        <h2 className="font-display text-4xl md:text-5xl text-white text-center mb-16 tracking-wide">
          Three steps. That's it.
        </h2>

        <div className="grid md:grid-cols-3 gap-8">
          <div className="cyber-panel p-6">
            <div className="step-num mb-3">01</div>
            <h3 className="font-display text-xl text-white tracking-wider mb-2">
              Pick a token
            </h3>
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              Browse available markets or create one for any ERC-20 token. No
              approvals needed &mdash; markets are fully permissionless.
            </p>
          </div>

          <div className="cyber-panel p-6">
            <div className="step-num mb-3">02</div>
            <h3 className="font-display text-xl text-white tracking-wider mb-2">
              Go long or short
            </h3>
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              Enter your position size in USDC. No collateral required, only pay the fee. You receive an NFT representing your position.
            </p>
          </div>

          <div className="cyber-panel p-6">
            <div className="step-num mb-3">03</div>
            <h3 className="font-display text-xl text-white tracking-wider mb-2">
              Close when you want
            </h3>
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              No liquidation engine. No margin calls. Close your position at any
              time and collect your USDC. Your NFT tracks live P&amp;L on-chain.
            </p>
          </div>
        </div>
      </section>

      <div className="divider max-w-4xl mx-auto" />

      {/* ── THE MATH ─────────────────────────────────────────────────────── */}
      <section className="max-w-3xl mx-auto px-6 py-24">
        <p className="section-label mb-2 text-center">The math</p>
        <h2 className="font-display text-4xl md:text-5xl text-white text-center mb-4 tracking-wide">
          What $5 actually buys.
        </h2>
        <p
          className="text-center text-sm max-w-xl mx-auto mb-12"
          style={{ color: "var(--muted)" }}
        >
          Opening a $100 position in a pool with $10,000 of USDC reserves. You
          post no collateral &mdash; only the fee.
        </p>

        <div className="cyber-panel p-6 md:p-8">
          <div className="font-mono text-sm space-y-3">
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>Position size</span>
              <span style={{ color: "var(--body)" }}>$100.00</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>Base fee (5%)</span>
              <span style={{ color: "var(--body)" }}>$5.00</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>Impact fee</span>
              <span style={{ color: "var(--body)" }}>$0.08</span>
            </div>
            <div
              className="flex justify-between pt-3"
              style={{ borderTop: "1px solid var(--border)" }}
            >
              <span style={{ color: "var(--body)" }}>
                Total paid &mdash; your entire downside
              </span>
              <span style={{ color: "var(--green)" }}>$5.08</span>
            </div>
          </div>

          <div
            className="mt-8 pt-6 font-mono text-sm space-y-3"
            style={{ borderTop: "1px solid var(--border)" }}
          >
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>Token +200%</span>
              <span style={{ color: "var(--green)" }}>
                &asymp; +$200 &nbsp;<span style={{ color: "var(--dim)" }}>(~40&times;)</span>
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>Token +50%</span>
              <span style={{ color: "var(--green)" }}>
                &asymp; +$50 &nbsp;<span style={{ color: "var(--dim)" }}>(~10&times;)</span>
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>Any move down</span>
              <span style={{ color: "var(--red)" }}>&minus;$5.08. Never more.</span>
            </div>
          </div>

          <p className="mt-6 text-xs" style={{ color: "var(--dim)" }}>
            Illustrative. Settlement runs through the pool&rsquo;s AMM curves, so
            realized profit is reduced by slippage &mdash; significantly if your
            position is large relative to pool reserves. The fee has a 0.05 USDC
            floor, so a $1 position costs $0.05.
          </p>
        </div>

        <div
          className="cyber-panel p-6 mt-6"
          style={{ borderColor: "var(--orange)" }}
        >
          <p
            className="section-label mb-2"
            style={{ color: "var(--orange)" }}
          >
            The catch
          </p>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Positions expire &mdash; 7 days by default. Renew before the
            deadline, let a winner auto-renew from its own profit, or it
            settles. An underwater position cannot be closed at all and settles
            for nothing. You have to be right{" "}
            <em style={{ color: "var(--body)" }}>within the window</em>.
          </p>
        </div>
      </section>

      <div className="divider max-w-4xl mx-auto" />

      {/* ── FEATURES ─────────────────────────────────────────────────────── */}
      <section className="max-w-4xl mx-auto px-6 py-24">
        <p className="section-label mb-2 text-center">Why EXNIHILO</p>
        <h2 className="font-display text-4xl md:text-5xl text-white text-center mb-16 tracking-wide">
          Built different.
        </h2>

        <div className="grid sm:grid-cols-2 gap-6">
          <FeatureCard
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2v20M2 12h20" />
              </svg>
            }
            iconColor="var(--green)"
            title="Your loss is capped at the fee"
            desc="No collateral, no margin, no liquidation engine. The premium you pay to open is your entire downside — enforced by the contract, not by policy."
          />
          <FeatureCard
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 12h6M12 9v6" />
              </svg>
            }
            iconColor="var(--cyan)"
            title="NFT positions"
            desc="Every position is an NFT with on-chain SVG art and live P&L. Transfer or trade your positions freely."
          />
          <FeatureCard
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M8 12l3 3 5-5" />
              </svg>
            }
            iconColor="var(--orange)"
            title="No oracles"
            desc="Price is derived from the AMM's own constant-product curves. No external dependencies, no oracle manipulation."
          />
          <FeatureCard
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            }
            iconColor="var(--red)"
            title="Fully permissionless"
            desc="Anyone can create a market for any token. No admin keys, no governance, no gatekeeping. The factory is immutable."
          />
          <FeatureCard
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
            }
            iconColor="var(--green)"
            title="Fully on-chain"
            desc="No backend servers, no subgraphs, no IPFS. All logic and metadata live on-chain. Zero downtime risk."
          />
          <FeatureCard
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20.24 12.24a6 6 0 00-8.49-8.49L5 10.5V19h8.5z" />
                <line x1="16" y1="8" x2="2" y2="22" />
                <line x1="17.5" y1="15" x2="9" y2="15" />
              </svg>
            }
            iconColor="var(--cyan)"
            title="Positions are options"
            desc="A long is a call, a short is a put, the open fee is the premium. No strike to pick, no implied volatility, no Greeks — just a direction and a deadline."
          />
        </div>
      </section>

      {/* ── LIVE STATS ───────────────────────────────────────────────────── */}
      <ProtocolStats />

      {/* ── CTA ──────────────────────────────────────────────────────────── */}
      <section className="max-w-2xl mx-auto px-6 py-24 text-center">
        <h2 className="font-display text-5xl md:text-6xl text-white tracking-wide mb-4">
          Start trading
        </h2>
        <p className="text-sm mb-10" style={{ color: "var(--muted)" }}>
          Connect your wallet and open your first position in under a minute.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link to="/app" className="btn btn-primary">
            Launch App
          </Link>
          <a href="/docs" className="btn btn-outline">
            Read Docs
          </a>
        </div>
      </section>

      {/* ── FOOTER ───────────────────────────────────────────────────────── */}
      <footer style={{ borderTop: "1px solid var(--border)" }} className="px-6 md:px-12 py-8">
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <span className="logo-glitch text-lg" data-text="EXNIHILO">
            EXNIHILO
          </span>
          <div className="flex items-center gap-6">
            <Link
              to="/app"
              className="section-label"
              style={{ transition: "color 0.15s" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--cyan)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted)")}
            >
              App
            </Link>
            <a
              href="/docs"
              className="section-label"
              style={{ transition: "color 0.15s" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--cyan)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted)")}
            >
              Docs
            </a>
            <a
              href="https://github.com/Red-Goglz/EXNIHILO"
              className="section-label"
              style={{ transition: "color 0.15s" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--cyan)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted)")}
            >
              GitHub
            </a>
            <a
              href="https://x.com/exnihiloFinance"
              className="section-label"
              style={{ transition: "color 0.15s" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--cyan)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted)")}
            >
              X
            </a>
          </div>
          <p className="text-xs" style={{ color: "var(--dim)" }}>
            &copy; 2026 EXNIHILO
          </p>
        </div>
      </footer>
    </div>
  );
}

/* ── Small sub-components ──────────────────────────────────────────────── */

function FeatureCard({
  icon,
  iconColor,
  title,
  desc,
}: {
  icon: React.ReactNode;
  iconColor: string;
  title: string;
  desc: string;
}) {
  return (
    <div className="cyber-panel p-6 flex gap-4">
      <div className="feature-icon" style={{ color: iconColor }}>
        {icon}
      </div>
      <div>
        <h3 className="font-display text-lg text-white tracking-wider mb-1">
          {title}
        </h3>
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          {desc}
        </p>
      </div>
    </div>
  );
}

interface ProtocolMetrics {
  totalFees: string;
  totalPositions: number;
  poolCount: number;
}

/**
 * Protocol stats, read from the indexer's `/metrics/protocol`.
 *
 * Renders nothing until there is something worth showing. A landing page
 * advertising "0 positions opened / $0 fees" is worse than one that stays
 * quiet — it is proof of no traction to the exact visitor we are trying to
 * convert. The section appears on its own once the first position is opened,
 * so this needs no follow-up once markets are live.
 *
 * TVL is deliberately absent: the indexer exposes no aggregate TVL figure.
 * `backedAirUsd` only exists inside per-event `priceSnapshot` rows, so a real
 * number would mean a new endpoint summing the latest snapshot per pool.
 * Better nothing than a placeholder dash.
 */
function ProtocolStats() {
  const chainId = DEFAULT_CHAIN.chain.id;

  const { data } = useQuery({
    queryKey: ["landingProtocolMetrics", chainId],
    enabled: hasIndexer(chainId),
    staleTime: 60_000,
    retry: false,
    queryFn: () => indexerFetch<ProtocolMetrics>(chainId, "/metrics/protocol"),
  });

  if (!data || data.totalPositions === 0) return null;

  return (
    <>
      <div className="divider max-w-4xl mx-auto" />

      <section className="max-w-4xl mx-auto px-6 py-24">
        <p className="section-label mb-2 text-center">
          <span className="pulse-dot mr-2" />
          Live on Avalanche
        </p>
        <h2 className="font-display text-4xl md:text-5xl text-white text-center mb-16 tracking-wide">
          Protocol stats
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatBox label="Markets" value={String(data.poolCount)} />
          <StatBox
            label="Positions opened"
            value={String(data.totalPositions)}
          />
          <StatBox
            label="Total fees"
            value={formatUsdcCompact(BigInt(data.totalFees))}
          />
        </div>

        <p className="text-center mt-6 text-xs" style={{ color: "var(--dim)" }}>
          Stats update from on-chain data on Avalanche C-Chain.
        </p>
      </section>

      <div className="divider max-w-4xl mx-auto" />
    </>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="cyber-panel p-5 text-center">
      <p className="section-label mb-1">{label}</p>
      <p className="font-display text-3xl text-white">{value}</p>
    </div>
  );
}
