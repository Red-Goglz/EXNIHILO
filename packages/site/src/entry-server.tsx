import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { WagmiProvider, createConfig } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiChains, wagmiTransports } from "./lib/chains.ts";
import LandingPage from "./pages/LandingPage.tsx";

/**
 * Build-time render of the landing page to static HTML.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * Googlebot executes JavaScript and already saw this page. AI retrieval
 * crawlers do not: OAI-SearchBot and PerplexityBot were measured receiving
 * 4,934 bytes — the empty shell — for "/". They read the docs fine because
 * VitePress emits real files, so the landing page was the one piece of
 * marketing content on the domain that no AI engine could quote.
 *
 * ── What this is NOT for ────────────────────────────────────────────────────
 * This is not hydration. main.tsx still uses createRoot, which discards
 * whatever is inside #root and re-renders from scratch. Users therefore get no
 * LCP benefit from this file, and in exchange we get no hydration-mismatch
 * class of bug at all — no matter how far this markup drifts from the client's
 * first render, nothing can break, because nothing tries to reconcile them.
 *
 * Switching to hydrateRoot would flip both of those. Do not do it casually:
 * wallet state, live chain reads and localStorage-driven theming make an exact
 * server/client match genuinely hard to hold, and the payoff is LCP, which we
 * have no field data to say is a problem.
 */

/**
 * A wagmi config built only for rendering — no connectors, no storage.
 *
 * The app's own config (wagmi.config.ts) cannot be reused here: injected()
 * reaches for window.ethereum and walletConnect() initialises browser
 * transport on construction, so importing it into Node throws before any
 * component renders. Chains and transports come from the same registry, so
 * contract addresses and RPC URLs cannot drift between the two.
 */
const ssrConfig = createConfig({
  chains: wagmiChains,
  transports: wagmiTransports,
  ssr: true,
});

export function render(): string {
  // retry: false so a query that somehow does fire cannot stall the build.
  // In practice none do — react-query does not fetch during renderToString,
  // so every hook resolves to its pending state, which is exactly what we
  // want emitted: a build-time snapshot must never assert a TVL or fee number
  // that will be hours stale by the time a crawler reads it.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return renderToString(
    <WagmiProvider config={ssrConfig}>
      <QueryClientProvider client={queryClient}>
        <StaticRouter location="/">
          <LandingPage />
        </StaticRouter>
      </QueryClientProvider>
    </WagmiProvider>,
  );
}
