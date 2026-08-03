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
// query. So the untouched shell is kept as app.html and Caddy routes /app/* at
// that copy instead. See deploy/Caddyfile.
writeFileSync(join(DIST, "app.html"), shell, "utf8");

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
    `  (app.html kept as the untouched /app/* shell)`,
);
