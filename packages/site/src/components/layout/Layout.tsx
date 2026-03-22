import { useState, useEffect } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAccount, useSwitchChain } from "wagmi";
import { avalancheFuji, hardhat } from "viem/chains";
import ConnectButton from "../wallet/ConnectButton.tsx";
import FaucetButtons from "../wallet/FaucetButton.tsx";
import { PositionAlertContext, usePositionAlertState, usePositionAlerts } from "../../hooks/usePositionAlerts.ts";

const NAV_LINKS = [
  { to: "/app",          label: "FEED",      exact: true  },
  { to: "/app/markets",   label: "MARKETS",   exact: false },
  { to: "/app/portfolio", label: "PORTFOLIO", exact: false },
  { to: "/app/create",    label: "CREATE",    exact: false },
] as const;

const MAX_WIDTH = 1280;

const CHAIN_LABELS: Record<number, string> = {
  [avalancheFuji.id]: "FUJI TESTNET",
  [hardhat.id]: "HARDHAT LOCAL",
};

export default function Layout() {
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const { chainId, isConnected } = useAccount();
  const { switchChain } = useSwitchChain();

  // Close mobile menu on route change
  useEffect(() => { setMenuOpen(false); }, [pathname]);

  // Prompt wallet to switch to Fuji if connected to an unsupported chain
  useEffect(() => {
    if (isConnected && chainId && !CHAIN_LABELS[chainId]) {
      switchChain({ chainId: avalancheFuji.id });
    }
  }, [isConnected, chainId, switchChain]);

  const chainLabel = chainId && CHAIN_LABELS[chainId]
    ? CHAIN_LABELS[chainId]
    : isConnected ? "WRONG NETWORK" : "FUJI TESTNET";

  const alertState = usePositionAlertState();

  return (
    <PositionAlertContext.Provider value={alertState}>
    <div style={{ minHeight: "100vh", fontFamily: "var(--font-mono)", width: "100%", display: "flex", flexDirection: "column" }}>
      {/* ── Navbar ─────────────────────────────────────────────────────── */}
      <nav
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          background: "rgba(0,0,0,0.94)",
          borderBottom: "1px solid var(--border)",
          backdropFilter: "blur(10px)",
          width: "100%",
        }}
      >
        <div
          style={{
            maxWidth: MAX_WIDTH,
            margin: "0 auto",
            padding: "0 24px",
            height: 56,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          {/* Left: Logo */}
          <Link to="/app" style={{ textDecoration: "none", flexShrink: 0 }}>
            <span
              className="logo-glitch"
              data-text="EXNIHILO"
              style={{ fontSize: "1.5rem" }}
            >
              EXNIHILO
            </span>
          </Link>

          {/* Desktop nav links */}
          <div className="desktop-nav" style={{ display: "flex", alignItems: "center", gap: 24, marginLeft: 36 }}>
            {NAV_LINKS.map(({ to, label, exact }) => {
              const isActive = exact ? pathname === to : pathname.startsWith(to);
              return <NavLink key={to} to={to} label={label} isActive={isActive} />;
            })}
          </div>

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Desktop right side */}
          <div className="desktop-nav" style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <FaucetButtons />
            <span
              style={{
                fontSize: "0.58rem",
                letterSpacing: "0.15em",
                color: chainLabel === "WRONG NETWORK" ? "var(--red)" : "var(--orange)",
                fontFamily: "var(--font-mono)",
              }}
            >
              ⬡ {chainLabel}
            </span>
            <ConnectButton />
          </div>

          {/* Mobile hamburger */}
          <button
            className="mobile-only"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Toggle menu"
            style={{
              display: "none", // overridden by CSS media query
              background: "transparent",
              border: "1px solid var(--border)",
              color: menuOpen ? "var(--cyan)" : "var(--muted)",
              fontFamily: "var(--font-mono)",
              fontSize: "1.1rem",
              padding: "4px 10px",
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            {menuOpen ? "✕" : "☰"}
          </button>
        </div>

        {/* ── Mobile dropdown ──────────────────────────────────────────── */}
        {menuOpen && (
          <div
            className="mobile-menu"
            style={{
              borderTop: "1px solid var(--border)",
              background: "rgba(0,0,0,0.96)",
              padding: "12px 24px 16px",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {NAV_LINKS.map(({ to, label, exact }) => {
              const isActive = exact ? pathname === to : pathname.startsWith(to);
              return (
                <Link
                  key={to}
                  to={to}
                  onClick={() => setMenuOpen(false)}
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.72rem",
                    letterSpacing: "0.15em",
                    color: isActive ? "var(--cyan)" : "var(--muted)",
                    textDecoration: "none",
                    padding: "10px 0",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  {label}
                </Link>
              );
            })}

            <div style={{ display: "flex", alignItems: "center", gap: 12, paddingTop: 10, flexWrap: "wrap" }}>
              <span
                style={{
                  fontSize: "0.58rem",
                  letterSpacing: "0.15em",
                  color: chainLabel === "WRONG NETWORK" ? "var(--red)" : "var(--orange)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                ⬡ {chainLabel}
              </span>
              <FaucetButtons />
            </div>

            <div style={{ paddingTop: 8 }}>
              <ConnectButton />
            </div>
          </div>
        )}
      </nav>

      {/* ── Page content ───────────────────────────────────────────────── */}
      <main
        style={{
          maxWidth: MAX_WIDTH,
          margin: "0 auto",
          padding: "32px 24px 64px",
          width: "100%",
          flex: 1,
        }}
      >
        <Outlet />
      </main>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer style={{ borderTop: "1px solid var(--border)" }}>
        <div
          style={{
            maxWidth: MAX_WIDTH,
            margin: "0 auto",
            padding: "24px 24px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 16,
          }}
        >
          <Link to="/" style={{ textDecoration: "none" }}>
            <span className="logo-glitch" data-text="EXNIHILO" style={{ fontSize: "1.1rem" }}>
              EXNIHILO
            </span>
          </Link>
          <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
            <FooterLink href="/docs">Docs</FooterLink>
            <FooterLink href="https://github.com/Red-Goglz/EXNIHILO">GitHub</FooterLink>
            <FooterLink href="https://x.com/exnihiloFinance">X</FooterLink>
          </div>
          <span style={{ fontSize: "0.6rem", color: "var(--dim)", letterSpacing: "0.08em" }}>
            &copy; 2026 EXNIHILO
          </span>
        </div>
      </footer>

      {/* Position alerts */}
      <PositionAlertStack />
    </div>
    </PositionAlertContext.Provider>
  );
}

function PositionAlertStack() {
  const { alerts, removeAlert } = usePositionAlerts();
  const navigate = useNavigate();

  if (alerts.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 20,
        right: 20,
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        maxWidth: 280,
      }}
    >
      {alerts.map((alert) => {
        const color = alert.side === "long" ? "var(--green)" : "var(--red)";
        const borderColor = alert.side === "long" ? "rgba(0,255,136,0.3)" : "rgba(255,59,48,0.3)";
        return (
          <button
            key={alert.id}
            onClick={() => {
              removeAlert(alert.id);
              navigate("/app/portfolio");
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 14px",
              background: "rgba(7,7,7,0.95)",
              border: `1px solid ${borderColor}`,
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              fontSize: "0.6rem",
              letterSpacing: "0.08em",
              color: "var(--body)",
              textAlign: "left",
              boxShadow: "0 4px 20px rgba(0,0,0,0.6)",
              position: "relative",
            }}
          >
            <span style={{ position: "absolute", top: -1, left: -1, width: 6, height: 6, borderTop: `1px solid ${color}`, borderLeft: `1px solid ${color}` }} />
            <span style={{ position: "absolute", bottom: -1, right: -1, width: 6, height: 6, borderBottom: `1px solid ${color}`, borderRight: `1px solid ${color}` }} />
            <span style={{ color, fontWeight: 700 }}>
              {alert.side === "long" ? "▲" : "▼"}
            </span>
            <span>
              Opened <span style={{ color, fontWeight: 600 }}>{alert.side.toUpperCase()}</span> {alert.symbol}
            </span>
            <span style={{ color: "var(--muted)", marginLeft: "auto" }}>→</span>
          </button>
        );
      })}
    </div>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      style={{
        fontSize: "0.62rem",
        letterSpacing: "0.12em",
        color: "var(--muted)",
        textDecoration: "none",
        transition: "color 0.15s",
        textTransform: "uppercase",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = "var(--cyan)")}
      onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted)")}
    >
      {children}
    </a>
  );
}

function NavLink({
  to,
  label,
  isActive,
}: {
  to: string;
  label: string;
  isActive: boolean;
}) {
  return (
    <Link
      to={to}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.65rem",
        letterSpacing: "0.15em",
        color: isActive ? "var(--cyan)" : "var(--muted)",
        textDecoration: "none",
        transition: "color 0.15s",
        borderBottom: isActive ? "1px solid var(--cyan)" : "1px solid transparent",
        paddingBottom: 2,
      }}
      onMouseEnter={(e) => {
        if (!isActive) (e.currentTarget.style.color = "var(--body)");
      }}
      onMouseLeave={(e) => {
        if (!isActive) (e.currentTarget.style.color = "var(--muted)");
      }}
    >
      {label}
    </Link>
  );
}
