import { defineConfig } from "vitepress";

export default defineConfig({
  title: "EXNIHILO",
  description: "Buy Now and Pay Later trading. Go long or short any token. No liquidations.",
  base: "/docs/",
  appearance: "dark",
  head: [
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    [
      "link",
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" },
    ],
    [
      "link",
      {
        href: "https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@300;400;500;600;700&display=swap",
        rel: "stylesheet",
      },
    ],
  ],
  themeConfig: {
    logo: "/logo.svg",
    siteTitle: "EXNIHILO",
    nav: [
      { text: "Home", link: "/" },
      { text: "Launch App", link: "https://exnihilo.finance/app" },
    ],
    sidebar: [
      {
        text: "Introduction",
        collapsed: false,
        items: [
          { text: "What is EXNIHILO", link: "/introduction/what-is-exnihilo" },
          { text: "Key Concepts", link: "/introduction/key-concepts" },
          { text: "Glossary", link: "/introduction/glossary" },
        ],
      },
      {
        text: "Trading",
        collapsed: false,
        items: [
          { text: "Opening a Long", link: "/trading/opening-a-long" },
          { text: "Opening a Short", link: "/trading/opening-a-short" },
          { text: "Closing / Realizing", link: "/trading/closing-realizing" },
          { text: "Swapping Tokens", link: "/trading/swapping" },
          { text: "Fees", link: "/trading/fees" },
          { text: "P&L Calculation", link: "/trading/pnl" },
        ],
      },
      {
        text: "Positions",
        collapsed: false,
        items: [
          { text: "Position NFTs", link: "/positions/position-nfts" },
          {
            text: "Transferring Positions",
            link: "/positions/transferring",
          },
          { text: "On-chain SVG Metadata", link: "/positions/metadata" },
        ],
      },
      {
        text: "Liquidity Providing",
        collapsed: false,
        items: [
          { text: "LP NFT & Ownership", link: "/lp/ownership" },
          { text: "Adding / Withdrawing", link: "/lp/add-withdraw" },
          { text: "Fee Earnings", link: "/lp/fees" },
          { text: "Position Caps", link: "/lp/position-caps" },
          {
            text: "Force Realize Positions",
            link: "/lp/force-realize",
          },
        ],
      },
      {
        text: "Markets",
        collapsed: false,
        items: [
          { text: "Creating a Market", link: "/markets/creating" },
          { text: "How Pricing Works", link: "/markets/pricing" },
          { text: "Reserve Accounting", link: "/markets/reserves" },
        ],
      },
      {
        text: "Protocol",
        collapsed: false,
        items: [
          { text: "Architecture Overview", link: "/protocol/architecture" },
          { text: "Contract Addresses", link: "/protocol/addresses" },
          { text: "Fee Structure", link: "/protocol/fees" },
          { text: "Security", link: "/protocol/security" },
        ],
      },
      {
        text: "Developers",
        collapsed: true,
        items: [
          { text: "Contract Reference", link: "/developers/reference" },
          { text: "ABIs", link: "/developers/abis" },
          { text: "Local Development", link: "/developers/local-dev" },
        ],
      },
      {
        text: "FAQ & Risks",
        collapsed: true,
        items: [
          { text: "Common Questions", link: "/faq/questions" },
          { text: "Risk Disclosure", link: "/faq/risks" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/exnihilo-finance" },
      { icon: "x", link: "https://x.com/exnihilo_fi" },
    ],
    footer: {
      message: "BUSL-1.1 Licensed",
      copyright: "© 2026 EXNIHILO",
    },
    search: {
      provider: "local",
    },
  },
});
