// Bake the landing page into dist/index.html as static HTML.
//
// Runs after `vite build` (the client bundle) and after the SSR bundle has been
// built to dist-ssr/. See src/entry-server.tsx for why this exists and why it
// deliberately stops short of hydration.
//
// Usage: node scripts/prerender.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const SSR_ENTRY = join(ROOT, "dist-ssr", "entry-server.js");

const shellPath = join(DIST, "index.html");
const shell = readFileSync(shellPath, "utf8");

// The shell is also the fallback for every /app/* route. If the landing page's
// markup were baked into it, a crawler hitting /app/avalanche/markets would be
// served the landing page's content under that URL — the wrong content for the
// address, and exactly the sort of thing that gets a page indexed for the wrong
// query. So a copy is kept as app.html and Caddy routes /app/* at that copy
// instead. See deploy/Caddyfile.
//
// That copy used to be byte-identical to the shell, which kept the landing
// page's *body* off app URLs — the point — while carrying its *head* along.
// Every /app/* route served `<link rel="canonical" href="https://exnihilo.markets/">`
// plus the landing page's title, description and og:* block, verbatim. All four
// app routes in sitemap.xml were therefore announcing themselves as duplicates
// of the homepage.
//
// src/lib/seo.ts rewrites all of it correctly once React mounts, so Googlebot
// renders and sees the right values. Nothing that skips JS does — Bing, and the
// AI retrieval crawlers robots.txt deliberately leaves unblocked (OAI-SearchBot,
// PerplexityBot, Claude-User).
//
// So the head is neutralised here rather than personalised: one honest set of
// app-wide defaults, and *no* canonical at all. A missing canonical lets the
// crawler fall back to the requested URL, which is the right answer; a wrong one
// does not. Per-route static shells would be better still, but they need a shell
// per route in the Caddyfile and could never cover /app/:chain/markets/:poolAddr,
// which is enumerable only from chain state. The app routes render live data
// anyway — the quotable prose is in /docs, which VitePress already emits as
// real static files.
const APP_TITLE = "EXNIHILO — Trade, provide liquidity, create markets";
const APP_DESCRIPTION =
  "Open a long or short on any ERC-20 market, add liquidity, or deploy a market " +
  "of your own. Your loss is capped at the premium you pay — there is no " +
  "liquidation engine.";

/** Replace one head tag, or fail the build. A silent miss here restores exactly
 *  the bug this function exists to remove, so a miss must never be survivable. */
function rewriteTag(html, pattern, replacement, what) {
  if (!pattern.test(html)) {
    console.error(
      `prerender: app.html — no match for ${what}. index.html changed shape; ` +
        `update the pattern rather than dropping the rewrite.`,
    );
    process.exit(1);
  }
  return html.replace(pattern, replacement);
}

// `[^>]*` spans newlines, so these match index.html's wrapped attributes and a
// minified single-line build equally. No content="" value contains a `>`.
let appShell = shell;
appShell = rewriteTag(
  appShell,
  /<title>[^<]*<\/title>/,
  `<title>${APP_TITLE}</title>`,
  "<title>",
);
appShell = rewriteTag(
  appShell,
  /<meta\s+name="description"[^>]*>/,
  `<meta name="description" content="${APP_DESCRIPTION}" />`,
  "meta description",
);
appShell = rewriteTag(
  appShell,
  /<meta\s+property="og:title"[^>]*>/,
  `<meta property="og:title" content="${APP_TITLE}" />`,
  "og:title",
);
appShell = rewriteTag(
  appShell,
  /<meta\s+property="og:description"[^>]*>/,
  `<meta property="og:description" content="${APP_DESCRIPTION}" />`,
  "og:description",
);
appShell = rewriteTag(
  appShell,
  /<meta\s+name="twitter:title"[^>]*>/,
  `<meta name="twitter:title" content="${APP_TITLE}" />`,
  "twitter:title",
);
appShell = rewriteTag(
  appShell,
  /<meta\s+name="twitter:description"[^>]*>/,
  `<meta name="twitter:description" content="${APP_DESCRIPTION}" />`,
  "twitter:description",
);

// Dropped outright, not rewritten: both name a single URL, and the shell is
// served under many. seo.ts sets the route's own value on mount.
appShell = rewriteTag(
  appShell,
  /\n?\s*<link rel="canonical"[^>]*>/,
  "",
  "canonical link",
);
appShell = rewriteTag(
  appShell,
  /\n?\s*<meta\s+property="og:url"[^>]*>/,
  "",
  "og:url",
);

// The actual invariant, asserted rather than eyeballed. Deliberately narrow:
// the Organization and WebSite JSON-LD both carry "url": "https://exnihilo.markets/"
// and both are correct on every route, so a blanket search for the homepage URL
// only teaches you to ignore the warning.
for (const [pattern, what] of [
  [/rel="canonical"/, "a canonical link"],
  [/property="og:url"/, "an og:url"],
]) {
  if (pattern.test(appShell)) {
    console.error(
      `prerender: app.html still has ${what}. It is served under every /app/* ` +
        `URL, so it cannot name one.`,
    );
    process.exit(1);
  }
}

writeFileSync(join(DIST, "app.html"), appShell, "utf8");

if (!existsSync(SSR_ENTRY)) {
  console.error(
    `prerender: ${SSR_ENTRY} missing — run \`vite build --ssr src/entry-server.tsx --outDir dist-ssr\` first.`,
  );
  process.exit(1);
}

const { render } = await import(pathToFileURL(SSR_ENTRY).href);
const html = render();

const MARKER = '<div id="root"></div>';
if (!shell.includes(MARKER)) {
  // Fail loudly. Silently emitting the un-prerendered shell would leave the
  // build green while quietly undoing the only thing this script does.
  console.error(`prerender: could not find ${MARKER} in dist/index.html`);
  process.exit(1);
}

const out = shell.replace(MARKER, `<div id="root">${html}</div>`);
writeFileSync(shellPath, out, "utf8");

const kb = (s) => (Buffer.byteLength(s, "utf8") / 1024).toFixed(1);
console.log(
  `prerender: / ${kb(shell)} KB -> ${kb(out)} KB` +
    `  (app.html ${kb(appShell)} KB, head neutralised, no canonical)`,
);
