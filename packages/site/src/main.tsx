import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import "./index.css";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FormoAnalyticsProvider } from "@formo/analytics";
import { config } from "../wagmi.config.ts";
import Layout from "./components/layout/Layout.tsx";
import LandingPage from "./pages/LandingPage.tsx";
import FeedPage from "./pages/FeedPage.tsx";
import MarketsPage from "./pages/MarketsPage.tsx";
import PoolPage from "./pages/PoolPage.tsx";
import PortfolioPage from "./pages/PortfolioPage.tsx";
import CreatePage from "./pages/CreatePage.tsx";
import AnalyticsPage from "./pages/AnalyticsPage.tsx";
import ChainRoute, { RedirectToFeed } from "./components/routing/ChainRoute.tsx";
import { appPath, DEFAULT_CHAIN } from "./lib/chains.ts";

const queryClient = new QueryClient();

/**
 * Formo analytics write key.
 *
 * Client-side by design — it ships in the bundle either way, so this is not a
 * secret. It lives in env rather than source so that rotating it (or pointing a
 * preview deploy at a different project) is a config change, not a code change
 * that lands in git history forever.
 *
 * The key is origin-locked by Formo. A key issued for one domain is rejected
 * elsewhere, and because every call site uses `analytics?.track(...)`, that
 * failure is silent. If events stop arriving after a domain move, this is the
 * first thing to check.
 *
 * Unset (local dev, CI) → analytics is disabled rather than half-initialised.
 */
const formoWriteKey: string | undefined =
  import.meta.env.VITE_FORMO_WRITE_KEY || undefined;

if (!formoWriteKey && import.meta.env.PROD) {
  console.warn(
    "[analytics] VITE_FORMO_WRITE_KEY is not set — Formo analytics is disabled.",
  );
}

/** Wraps children in the Formo provider only when a key is configured. */
function Analytics({ children }: { children: React.ReactNode }) {
  if (!formoWriteKey) return <>{children}</>;
  return (
    <FormoAnalyticsProvider
      writeKey={formoWriteKey}
      options={{ wagmi: { config, queryClient } }}
    >
      {children}
    </FormoAnalyticsProvider>
  );
}

// All app routes are chain-scoped: /app/:chainSlug/... — the URL segment
// (not the wallet) decides which chain's contracts the page reads.
// Legacy chainless URLs (/app/markets/0xabc) redirect to the default chain.
const router = createBrowserRouter([
  { path: "/", element: <LandingPage /> },
  {
    path: "/app",
    children: [
      { index: true, element: <Navigate to={appPath(DEFAULT_CHAIN.slug)} replace /> },
      {
        path: ":chainSlug",
        element: <ChainRoute />,
        children: [
          {
            element: <Layout />,
            children: [
              { index: true, element: <FeedPage /> },
              { path: "markets", element: <MarketsPage /> },
              { path: "markets/:poolAddr", element: <PoolPage /> },
              { path: "portfolio", element: <PortfolioPage /> },
              { path: "create", element: <CreatePage /> },
              { path: "analytics", element: <AnalyticsPage /> },
              { path: "*", element: <RedirectToFeed /> },
            ],
          },
        ],
      },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <Analytics>
          <RouterProvider router={router} />
        </Analytics>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>
);
