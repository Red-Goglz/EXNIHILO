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
        <FormoAnalyticsProvider
          writeKey="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJvcmlnaW4iOiJodHRwczovL2V4bmloaWxvLmZpbmFuY2UiLCJwcm9qZWN0X2lkIjoiYzhvZWVOT0JMY2J4N19UWmlIczB4IiwiaWF0IjoxNzc1MTYyODA3fQ.uzIzGUk7PpIH07huL1DkIplFUvfxyeCoTYKyG218qhg"
          options={{
            wagmi: {
              config: config,
              queryClient: queryClient,
            },
          }}
        >
          <RouterProvider router={router} />
        </FormoAnalyticsProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>
);
