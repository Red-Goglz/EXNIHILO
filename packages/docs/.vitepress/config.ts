import { defineConfig } from "vitepress";

const SITE = "https://exnihilo.markets";

/**
 * Site-wide description. Still needed as the fallback for any page that forgets
 * its own `description` frontmatter — but it should never be the *only* one in
 * play. Every page under this directory carries a specific description; when
 * they did not, all 31 of them shipped this same sentence, which meant a page
 * titled "Risk Disclosure" was described to searchers as a sales pitch.
 */
const SITE_DESCRIPTION =
  "Long or short any ERC-20 token. You pay a fee, not collateral — and that fee is the most you can lose.";

/** `trading/pnl.md` → `https://exnihilo.markets/docs/trading/pnl.html` */
function pageUrl(relativePath: string): string {
  const rel = relativePath
    .replace(/\.md$/, ".html")
    .replace(/(^|\/)index\.html$/, "$1");
  return `${SITE}/docs/${rel}`;
}

export default defineConfig({
  title: "EXNIHILO",
  description: SITE_DESCRIPTION,
  base: "/docs/",
  outDir: "../site/public/docs",
  appearance: "dark",

  // Absolute paths into the host site's /fonts, which is where the app's own
  // shell loads them from too — so a visitor moving between the app and the
  // docs reuses the same cached files instead of fetching a second copy.
  head: [
    [
      "link",
      {
        rel: "preload",
        href: "/fonts/ibm-plex-mono-latin-400.woff2",
        as: "font",
        type: "font/woff2",
        crossorigin: "",
      },
    ],
    ["link", { rel: "stylesheet", href: "/fonts/fonts.css" }],
  ],

  /**
   * Per-page canonical, social tags and article markup.
   *
   * VitePress emits <title> and <meta name="description"> on its own; none of
   * the rest existed, so every docs page was unshareable (a bare grey box in
   * any link preview) and had no canonical at all.
   */
  transformHead({ pageData }) {
    const url = pageUrl(pageData.relativePath);
    const description =
      (pageData.frontmatter.description as string | undefined) ??
      SITE_DESCRIPTION;
    // Derived exactly the way VitePress builds the <title>, rather than
    // hardcoded per layout. A hardcoded value drifts the moment a page sets its
    // own title in frontmatter, and og:title silently disagreeing with the
    // document title is the kind of mismatch nothing warns you about.
    const fmTitle = pageData.frontmatter.title as string | undefined;
    const baseTitle = fmTitle ?? pageData.title;
    const title =
      pageData.frontmatter.titleTemplate === false
        ? baseTitle
        : `${baseTitle} | EXNIHILO`;

    const head: [string, Record<string, string>, string?][] = [
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:type", content: "article" }],
      ["meta", { property: "og:site_name", content: "EXNIHILO" }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { property: "og:image", content: `${SITE}/og-image.png` }],
      ["meta", { name: "twitter:card", content: "summary_large_image" }],
      ["meta", { name: "twitter:site", content: "@exnihiloFinance" }],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: description }],
      ["meta", { name: "twitter:image", content: `${SITE}/og-image.png` }],
    ];

    // TechArticle on real pages only — the home layout is a landing page, not
    // an article, and marking it up as one would be describing it wrongly.
    //
    // Deliberately no FAQPage on /docs/faq/*: Google retired FAQ rich results
    // for every site in May 2026, so it buys nothing in search today.
    if (pageData.frontmatter.layout !== "home") {
      head.push([
        "script",
        { type: "application/ld+json" },
        JSON.stringify({
          "@context": "https://schema.org",
          "@type": "TechArticle",
          headline: pageData.title,
          description,
          url,
          inLanguage: "en-US",
          isPartOf: { "@type": "WebSite", "@id": `${SITE}/#website` },
          publisher: { "@id": `${SITE}/#organization` },
        }),
      ]);
    }

    return head;
  },
  themeConfig: {
    logo: "/logo.svg",
    siteTitle: "EXNIHILO",
    nav: [
      { text: "Home", link: "/" },
      { text: "Launch App", link: "https://exnihilo.markets/app" },
    ],
    sidebar: [
      {
        text: "Introduction",
        collapsed: false,
        items: [
          { text: "What is EXNIHILO", link: "/introduction/what-is-exnihilo" },
          {
            text: "Positions Are Options",
            link: "/introduction/positions-are-options",
          },
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
          { text: "Closing Positions", link: "/trading/closing-realizing" },
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
          { text: "Expiry & Renewal", link: "/positions/expiry" },
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
          { text: "Indexer", link: "/developers/indexer" },
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
      { icon: "github", link: "https://github.com/Red-Goglz/EXNIHILO" },
      { icon: "x", link: "https://x.com/exnihiloFinance" },
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
