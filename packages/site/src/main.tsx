import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./index.css";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { config } from "../wagmi.config.ts";
import Layout from "./components/layout/Layout.tsx";
import FeedPage from "./pages/FeedPage.tsx";
import MarketsPage from "./pages/MarketsPage.tsx";
import PoolPage from "./pages/PoolPage.tsx";
import PortfolioPage from "./pages/PortfolioPage.tsx";
import CreatePage from "./pages/CreatePage.tsx";

const queryClient = new QueryClient();

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <FeedPage /> },
      { path: "markets", element: <MarketsPage /> },
      { path: "markets/:poolAddr", element: <PoolPage /> },
      { path: "portfolio", element: <PortfolioPage /> },
      { path: "create", element: <CreatePage /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>
);
