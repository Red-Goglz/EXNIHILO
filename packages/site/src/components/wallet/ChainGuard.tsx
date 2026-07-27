import { useAccount, useSwitchChain } from "wagmi";
import { type ReactNode } from "react";
import { useAppChain } from "../../hooks/useAppChain.ts";
import { APP_CHAINS } from "../../lib/chains.ts";

interface ChainGuardProps {
  children: ReactNode;
}

/**
 * Gates wallet-dependent content: requires a connected wallet on the chain
 * the URL points at (/app/:chainSlug/...). The URL chain is the source of
 * truth — the wallet is asked to follow it.
 */
export default function ChainGuard({ children }: ChainGuardProps) {
  const { isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const { chainId: urlChainId, label } = useAppChain();

  if (!isConnected) {
    return (
      <div
        className="flex flex-col items-center justify-center py-24 gap-4"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        <p
          style={{
            fontSize: "0.7rem",
            letterSpacing: "0.15em",
            color: "var(--muted)",
          }}
        >
          — WALLET NOT CONNECTED —
        </p>
        <p
          style={{
            fontSize: "var(--fs-body-s)",
            color: "var(--dim)",
            letterSpacing: "0.1em",
          }}
        >
          Connect your wallet to continue
        </p>
      </div>
    );
  }

  if (chainId !== urlChainId) {
    return (
      <div
        className="flex flex-col items-center justify-center py-24 gap-6"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        <p
          style={{
            fontSize: "0.7rem",
            letterSpacing: "0.15em",
            color: "var(--red)",
          }}
        >
          — WRONG NETWORK —
        </p>
        <p
          style={{
            fontSize: "var(--fs-body-s)",
            color: "var(--muted)",
            letterSpacing: "0.08em",
          }}
        >
          This page is on {label}. Switch your wallet to continue.
        </p>
        <div className="flex gap-3">
          {APP_CHAINS.map((c) => (
            <button
              key={c.slug}
              onClick={() => switchChain({ chainId: c.chain.id })}
              className={
                c.chain.id === urlChainId ? "btn-terminal btn-cyan" : "btn-terminal"
              }
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
