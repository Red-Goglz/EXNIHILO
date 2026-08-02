import { useEffect } from "react";

/**
 * Per-route document metadata.
 *
 * ── Why this is imperative rather than declarative ──────────────────────────
 * React 19 can hoist a <title> or <meta> rendered anywhere in the tree up into
 * <head>, which looks like the obvious tool for this. It is the wrong one here.
 * Hoisting *appends*; it does not replace. index.html already ships a static
 * title, description and og:* block — which it must, because social link
 * unfurlers never run our JS — so hoisting would leave two <title> elements in
 * the document. Browsers and Google both take the first, which is the static
 * one, so every per-route title would be silently ignored while appearing to
 * work in the React tree.
 *
 * Mutating the existing tags in place is the behaviour we actually want, and it
 * costs one effect instead of a dependency (react-helmet-async and friends
 * exist to solve exactly this, but only because React <19 could not hoist at
 * all — the replace-vs-append problem is unchanged).
 *
 * ── What this does and does not buy ─────────────────────────────────────────
 * Googlebot executes JS, so it sees these values. Link unfurlers do not, so a
 * URL pasted into X or Telegram always previews with the static defaults from
 * index.html regardless of route. Fixing *that* needs prerendering or SSR, not
 * a bigger metadata library.
 */

/** Canonical origin. Deliberately not window.location.origin: a canonical must
 *  name the one URL we want indexed, not whichever host served the response. */
const SITE_ORIGIN = "https://exnihilo.markets";

export interface SeoInput {
  /** Page title, without the brand suffix — this adds it. */
  title: string;
  description: string;
  /** Root-relative path, e.g. "/app/avalanche/markets". Omit for no canonical. */
  path?: string;
  /** Keep out of the index. Use for wallet-gated or per-user views. */
  noindex?: boolean;
}

function setMeta(selector: string, attr: "name" | "property", key: string, value: string) {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", value);
}

export function useSeo({ title, description, path, noindex = false }: SeoInput) {
  useEffect(() => {
    const fullTitle = title === "EXNIHILO" ? title : `${title} | EXNIHILO`;
    document.title = fullTitle;

    setMeta('meta[name="description"]', "name", "description", description);

    // og:title / og:description are updated too so that anything which *does*
    // render before scraping (a headless renderer, a preview service that runs
    // JS) sees the route's own values rather than the landing page's.
    setMeta('meta[property="og:title"]', "property", "og:title", fullTitle);
    setMeta('meta[property="og:description"]', "property", "og:description", description);
    setMeta('meta[name="twitter:title"]', "name", "twitter:title", fullTitle);
    setMeta('meta[name="twitter:description"]', "name", "twitter:description", description);

    // Always write robots, never only on noindex routes: leaving the previous
    // route's value in place is how a client-side app ends up noindexing pages
    // it merely navigated through.
    setMeta(
      'meta[name="robots"]',
      "name",
      "robots",
      noindex ? "noindex, follow" : "index, follow",
    );

    const existing = document.head.querySelector<HTMLLinkElement>(
      'link[rel="canonical"]',
    );

    if (path) {
      const href = `${SITE_ORIGIN}${path}`;
      const link = existing ?? document.createElement("link");
      link.rel = "canonical";
      link.href = href;
      if (!existing) document.head.appendChild(link);
      setMeta('meta[property="og:url"]', "property", "og:url", href);
    } else if (existing) {
      // A route with no canonical of its own must *remove* the one left behind,
      // not leave it. index.html ships a static canonical pointing at the
      // homepage, so without this the portfolio page claimed to be a duplicate
      // of "/" — and any client-side navigation would inherit the canonical of
      // whatever route the user happened to come from.
      existing.remove();
    }
  }, [title, description, path, noindex]);
}
