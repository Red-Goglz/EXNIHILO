import { useState, useRef, useEffect } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";

export default function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.7rem",
            color: "var(--cyan)",
            letterSpacing: "0.05em",
          }}
        >
          [{address.slice(0, 6)}…{address.slice(-4)}]
        </span>
        <button
          onClick={() => disconnect()}
          className="btn-terminal"
          style={{ fontSize: "0.6rem", padding: "5px 12px" }}
        >
          DISCONNECT
        </button>
      </div>
    );
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-terminal btn-cyan"
        style={{ fontSize: "0.65rem", padding: "6px 16px" }}
        disabled={isPending}
      >
        {isPending ? "CONNECTING…" : "CONNECT WALLET"}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            minWidth: 220,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            zIndex: 100,
            boxShadow: "0 8px 32px rgba(0,0,0,0.7)",
          }}
        >
          {/* Cyber corners */}
          <span style={{ position: "absolute", top: -1, left: -1, width: 8, height: 8, borderTop: "1px solid var(--cyan)", borderLeft: "1px solid var(--cyan)" }} />
          <span style={{ position: "absolute", bottom: -1, right: -1, width: 8, height: 8, borderBottom: "1px solid var(--cyan)", borderRight: "1px solid var(--cyan)" }} />

          {/* Header */}
          <div
            style={{
              padding: "9px 14px 7px",
              fontFamily: "var(--font-mono)",
              fontSize: "0.58rem",
              letterSpacing: "0.14em",
              color: "var(--dim)",
              borderBottom: "1px solid var(--border)",
            }}
          >
            SELECT WALLET
          </div>

          {/* Connector list */}
          {connectors.map((connector) => (
            <button
              key={connector.uid}
              onClick={() => {
                connect({ connector });
                setOpen(false);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "10px 14px",
                background: "transparent",
                border: "none",
                borderBottom: "1px solid var(--border)",
                cursor: "pointer",
                textAlign: "left",
                transition: "background 0.12s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,229,255,0.05)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              }}
            >
              {/* Wallet icon (EIP-6963 wallets provide one) */}
              {connector.icon ? (
                <img
                  src={connector.icon}
                  alt=""
                  style={{ width: 20, height: 20, borderRadius: 4, flexShrink: 0 }}
                />
              ) : (
                <span style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.9rem", flexShrink: 0 }}>
                  {connector.name.toLowerCase().includes("walletconnect") ? "🔗" : "⬡"}
                </span>
              )}
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.65rem",
                  letterSpacing: "0.06em",
                  color: "var(--body)",
                }}
              >
                {connector.name.toUpperCase()}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
