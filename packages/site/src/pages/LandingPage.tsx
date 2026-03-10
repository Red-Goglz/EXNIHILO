import { Link } from "react-router-dom";

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
          className="fade-up fade-up-d1 font-mono text-lg md:text-xl max-w-2xl mb-3"
          style={{ color: "var(--body)" }}
        >
          Buy Now and Pay Later trading.
        </p>
        <p
          className="fade-up fade-up-d2 font-mono text-base md:text-lg max-w-xl mb-10"
          style={{ color: "var(--muted)" }}
        >
          Go long or short any token. No liquidations.
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
              Enter your position size in USDC. No collateral required beyond the
              trade itself. You receive an NFT representing your position.
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
            title="No liquidations"
            desc="Positions never get force-closed. You decide when to exit — the protocol doesn't."
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
            title="Buy now, pay later"
            desc="Get leveraged exposure with just your trade size. No extra collateral. No margin requirements. Just USDC in, position out."
          />
        </div>
      </section>

      <div className="divider max-w-4xl mx-auto" />

      {/* ── LIVE STATS ───────────────────────────────────────────────────── */}
      <section className="max-w-4xl mx-auto px-6 py-24">
        <p className="section-label mb-2 text-center">
          <span className="pulse-dot mr-2" />
          Live on Avalanche
        </p>
        <h2 className="font-display text-4xl md:text-5xl text-white text-center mb-16 tracking-wide">
          Protocol stats
        </h2>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatBox label="Markets" value="—" />
          <StatBox label="Total TVL" value="—" />
          <StatBox label="Positions opened" value="—" />
          <StatBox label="Total fees" value="—" />
        </div>

        <p
          className="text-center mt-6 text-xs"
          style={{ color: "var(--dim)" }}
        >
          Stats update from on-chain data. Coming soon after mainnet launch.
        </p>
      </section>

      <div className="divider max-w-4xl mx-auto" />

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
              href="https://github.com/exnihilo-finance"
              className="section-label"
              style={{ transition: "color 0.15s" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--cyan)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted)")}
            >
              GitHub
            </a>
            <a
              href="https://x.com/exnihilo_fi"
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

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="cyber-panel p-5 text-center">
      <p className="section-label mb-1">{label}</p>
      <p className="font-display text-3xl text-white">{value}</p>
    </div>
  );
}
