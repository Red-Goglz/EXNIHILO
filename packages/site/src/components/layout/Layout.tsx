import { Link, Outlet, useLocation } from "react-router-dom";
import ConnectButton from "../wallet/ConnectButton.tsx";

const NAV_LINKS = [
  { to: "/app",          label: "FEED",      exact: true  },
  { to: "/app/markets",   label: "MARKETS",   exact: false },
  { to: "/app/portfolio", label: "PORTFOLIO", exact: false },
  { to: "/app/create",    label: "CREATE",    exact: false },
] as const;

const MAX_WIDTH = 1280;

export default function Layout() {
  const { pathname } = useLocation();

  return (
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
          {/* Left: Logo + links */}
          <div style={{ display: "flex", alignItems: "center", gap: 36 }}>
            <Link to="/app" style={{ textDecoration: "none" }}>
              <span
                className="logo-glitch"
                data-text="EXNIHILO"
                style={{ fontSize: "1.5rem" }}
              >
                EXNIHILO
              </span>
            </Link>

            <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
              {NAV_LINKS.map(({ to, label, exact }) => {
                const isActive = exact ? pathname === to : pathname.startsWith(to);
                return (
                  <NavLink key={to} to={to} label={label} isActive={isActive} />
                );
              })}
            </div>
          </div>

          {/* Right: Avalanche + Connect */}
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span
              style={{
                fontSize: "0.58rem",
                letterSpacing: "0.15em",
                color: "var(--red)",
                fontFamily: "var(--font-mono)",
              }}
            >
              ⬡ AVALANCHE
            </span>
            <ConnectButton />
          </div>
        </div>
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
