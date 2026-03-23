/**
 * Production server: serves static site + proxies API to Ponder.
 * Single port — Ponder runs internally on 42069 (never exposed).
 *
 * Env vars (all optional):
 *   PORT         — server port (default: 3000, Replit sets this automatically)
 *   PONDER_PORT  — internal Ponder port (default: 42069)
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const PORT = parseInt(process.env.PORT || "3000", 10);
const PONDER_PORT = parseInt(process.env.PONDER_PORT || "42069", 10);
const PONDER_URL = `http://127.0.0.1:${PONDER_PORT}`;
const DIST = join(import.meta.dirname, "packages/site/dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".map": "application/json",
};

// Static assets with hashed filenames get long cache; html gets no-cache
function cacheHeader(filePath) {
  if (filePath.endsWith(".html")) return "no-cache";
  if (filePath.includes("/assets/")) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}

function serveStatic(req, res) {
  const urlPath = (req.url || "/").split("?")[0];
  let filePath = join(DIST, urlPath);

  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, "index.html");
  }

  if (existsSync(filePath) && statSync(filePath).isFile()) {
    const ext = extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": cacheHeader(filePath),
    });
    res.end(readFileSync(filePath));
    return true;
  }
  return false;
}

// Try multiple addresses — Ponder may bind to localhost (::1) or 127.0.0.1
const PONDER_URLS = [
  `http://127.0.0.1:${PONDER_PORT}`,
  `http://localhost:${PONDER_PORT}`,
  `http://[::1]:${PONDER_PORT}`,
];

async function tryFetch(path, method, headers) {
  for (const base of PONDER_URLS) {
    try {
      const r = await fetch(`${base}${path}`, { method, headers: { ...headers, host: new URL(base).host } });
      return r;
    } catch { /* try next */ }
  }
  return null;
}

function proxyToPonder(req, res) {
  tryFetch(req.url, req.method, req.headers)
    .then(async (pRes) => {
      if (!pRes) throw new Error("unreachable");
      res.writeHead(pRes.status, {
        "Content-Type": pRes.headers.get("content-type") || "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      });
      const body = await pRes.arrayBuffer();
      res.end(Buffer.from(body));
    })
    .catch(() => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Indexer not ready" }));
    });
}

const server = createServer((req, res) => {
  const url = req.url || "/";

  // Proxy API routes to Ponder
  if (
    url.startsWith("/prices") ||
    url.startsWith("/health") ||
    url.startsWith("/ready") ||
    url.startsWith("/api-status") ||
    url.startsWith("/graphql")
  ) {
    return proxyToPonder(req, res);
  }

  // Try static file
  if (serveStatic(req, res)) return;

  // SPA fallback — serve index.html
  const indexPath = join(DIST, "index.html");
  if (existsSync(indexPath)) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(readFileSync(indexPath));
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found — run 'npm run build' first");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
  console.log(`Proxying API → Ponder on port ${PONDER_PORT}`);
  console.log(`Serving static files from ${DIST}`);

  // Periodically check Ponder connectivity
  let ponderReady = false;
  const check = async () => {
    const r = await tryFetch("/health", "GET", {});
    if (r && !ponderReady) {
      ponderReady = true;
      console.log(`Ponder connected at ${r.url || "port " + PONDER_PORT}`);
    }
    if (!ponderReady) setTimeout(check, 5000);
  };
  setTimeout(check, 3000);
});
