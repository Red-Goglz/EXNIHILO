import { useAccount, useSwitchChain } from "wagmi";
import { hardhat, avalancheFuji } from "viem/chains";
import { type ReactNode } from "react";

const SUPPORTED_CHAIN_IDS = [hardhat.id, avalancheFuji.id];

interface ChainGuardProps {
  children: ReactNode;
}

export default function ChainGuard({ children }: ChainGuardProps) {
  const { isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();

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
            fontSize: "0.65rem",
            color: "var(--dim)",
            letterSpacing: "0.1em",
          }}
        >
          Connect your wallet to continue
        </p>
      </div>
    );
  }

  if (!SUPPORTED_CHAIN_IDS.includes(chainId as (typeof SUPPORTED_CHAIN_IDS)[number])) {
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
          — UNSUPPORTED NETWORK —
        </p>
        <p
          style={{
            fontSize: "0.65rem",
            color: "var(--muted)",
            letterSpacing: "0.08em",
          }}
        >
          Switch to Hardhat (local) or Avalanche Fuji
        </p>
        <div className="flex gap-3">
          <button
            onClick={() => switchChain({ chainId: hardhat.id })}
            className="btn-terminal"
          >
            HARDHAT LOCAL
          </button>
          <button
            onClick={() => switchChain({ chainId: avalancheFuji.id })}
            className="btn-terminal btn-cyan"
          >
            AVALANCHE FUJI
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
