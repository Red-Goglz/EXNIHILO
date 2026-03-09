import { http, createConfig } from "wagmi";
import { avalancheFuji, hardhat } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";

const wcProjectId = import.meta.env.VITE_WC_PROJECT_ID ?? "";

export const config = createConfig({
  chains: [avalancheFuji, hardhat],
  connectors: [
    injected(),                          // catches any window.ethereum (legacy fallback)
    walletConnect({ projectId: wcProjectId }), // WalletConnect v2 (mobile + Rabby desktop via WC)
  ],
  // EIP-6963 multi-wallet discovery is enabled by default — Rabby, MetaMask, etc.
  // will appear automatically as additional connectors alongside the above.
  transports: {
    [hardhat.id]:       http("http://127.0.0.1:8545"),
    [avalancheFuji.id]: http(),
  },
});
