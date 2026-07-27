import { createConfig } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import { wagmiChains, wagmiTransports } from "./src/lib/chains.ts";

const wcProjectId = import.meta.env.VITE_WC_PROJECT_ID ?? "";

// Chains and transports derive from the registry in src/lib/chains.ts —
// add new chains there, not here.
export const config = createConfig({
  chains: wagmiChains,
  connectors: [
    injected(),                          // catches any window.ethereum (legacy fallback)
    walletConnect({ projectId: wcProjectId }), // WalletConnect v2 (mobile + Rabby desktop via WC)
  ],
  // EIP-6963 multi-wallet discovery is enabled by default — Rabby, MetaMask, etc.
  // will appear automatically as additional connectors alongside the above.
  transports: wagmiTransports,
});
