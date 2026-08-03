import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import "./index.css";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FormoAnalyticsProvider } from "@formo/analytics";
import { config } from "../wagmi.config.ts";
import LandingPage from "./pages/LandingPage.tsx";
import ChainRoute, { RedirectToFeed } from "./components/routing/ChainRoute.tsx";
import LazyRoute from "./components/routing/LazyRoute.tsx";
import { appPath, DEFAULT_CHAIN } from "./lib/chains.ts";

/**
 * The app pages load on demand; the landing page does not.
 *
 * "/" is the only route a first-time visitor and every crawler sees, and it is
 * the one route that is prerendered to static HTML (scripts/prerender.mjs), so
 * it should not pay to parse six trading screens it will never mount. Static
 * imports put all of them in the entry chunk.
 *
 * LandingPage stays eager on purpose. It is the SSR entry (src/entry-server.tsx
 * imports it directly), and lazily loading the one route that is already
 * rendered into the HTML would add a network round-trip to the fastest page.
 *
 * Note this does *not* move wagmi or viem off "/": TradeCalculator on the
 * landing page does live contract reads, and WagmiProvider below is a static
 * import either way. Splitting those out needs a nested provider for the app
 * subtree — a bigger change than this one, and worth measuring first.
 */
const Layout = React.lazy(() => import("./components/layout/Layout.tsx"));
const FeedPage = React.lazy(() => import("./pages/FeedPage.tsx"));
const MarketsPage = React.lazy(() => import("./pages/MarketsPage.tsx"));
const PoolPage = React.lazy(() => import("./pages/PoolPage.tsx"));
const PortfolioPage = React.lazy(() => import("./pages/PortfolioPage.tsx"));
const CreatePage = React.lazy(() => import("./pages/CreatePage.tsx"));
const AnalyticsPage = React.lazy(() => import("./pages/AnalyticsPage.tsx"));

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
//
// Two levels of boundary, not one: the outer covers the Layout chunk, so the
// first hit on /app/* blanks only until the chrome arrives, and the inner ones
// sit under Layout's <Outlet />, so navigating between pages swaps the content
// while the nav and header stay put.
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
            element: (
              <LazyRoute>
                <Layout />
              </LazyRoute>
            ),
            children: [
              {
                index: true,
                element: (
                  <LazyRoute>
                    <FeedPage />
                  </LazyRoute>
                ),
              },
              {
                path: "markets",
                element: (
                  <LazyRoute>
                    <MarketsPage />
                  </LazyRoute>
                ),
              },
              {
                path: "markets/:poolAddr",
                element: (
                  <LazyRoute>
                    <PoolPage />
                  </LazyRoute>
                ),
              },
              {
                path: "portfolio",
                element: (
                  <LazyRoute>
                    <PortfolioPage />
                  </LazyRoute>
                ),
              },
              {
                path: "create",
                element: (
                  <LazyRoute>
                    <CreatePage />
                  </LazyRoute>
                ),
              },
              {
                path: "analytics",
                element: (
                  <LazyRoute>
                    <AnalyticsPage />
                  </LazyRoute>
                ),
              },
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
