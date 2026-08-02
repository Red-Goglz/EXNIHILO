// Emits dist/sitemap.xml after `vite build`.
//
// Runs against dist/ rather than the source tree on purpose: the docs are built
// by a separate package into site/public/docs and copied in by Vite, so dist is
// the only place where the full set of shipped pages exists at once. Scanning
// sources instead would silently miss a page whose build failed.
//
// Usage: node scripts/generate-sitemap.mjs
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = "https://exnihilo.markets";
const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

/**
 * Client-rendered routes worth indexing. Kept in sync by hand with the router
 * in src/main.tsx — there is no build-time route manifest to derive them from.
 *
 * Absent deliberately:
 *   /app/:chain/portfolio   noindex; its content is whatever wallet is connected
 *   /app/:chain/markets/:addr  enumerable only from chain state, not at build time
 */
const APP_ROUTES = [
  { path: "/", priority: "1.0", changefreq: "weekly" },
  { path: "/app/avalanche", priority: "0.9", changefreq: "daily" },
  { path: "/app/avalanche/markets", priority: "0.9", changefreq: "daily" },
  { path: "/app/avalanche/create", priority: "0.6", changefreq: "monthly" },
  { path: "/app/avalanche/analytics", priority: "0.6", changefreq: "daily" },
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const today = iso(Date.now());

const urls = APP_ROUTES.map((r) => ({
  loc: `${SITE}${r.path}`,
  lastmod: today,
  changefreq: r.changefreq,
  priority: r.priority,
}));

// VitePress ships its own 404.html; the app ships one at the root. Neither
// belongs in a sitemap — a sitemap is a list of pages you want indexed.
for (const file of walk(join(DIST, "docs"))) {
  const rel = relative(DIST, file).split("\\").join("/");
  if (rel.endsWith("404.html")) continue;

  urls.push({
    loc: `${SITE}/${rel.replace(/(^|\/)index\.html$/, "$1")}`,
    lastmod: iso(statSync(file).mtime),
    changefreq: "monthly",
    priority: rel === "docs/index.html" ? "0.8" : "0.7",
  });
}

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) =>
      `  <url>\n` +
      `    <loc>${u.loc}</loc>\n` +
      `    <lastmod>${u.lastmod}</lastmod>\n` +
      `    <changefreq>${u.changefreq}</changefreq>\n` +
      `    <priority>${u.priority}</priority>\n` +
      `  </url>`,
  )
  .join("\n")}
</urlset>
`;

writeFileSync(join(DIST, "sitemap.xml"), xml, "utf8");
console.log(`sitemap.xml: ${urls.length} URLs`);
