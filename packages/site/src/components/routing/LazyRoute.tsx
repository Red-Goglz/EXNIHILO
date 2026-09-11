import React from "react";

/**
 * Suspense boundary for the lazily-loaded app routes.
 *
 * Lives here rather than in main.tsx because react-refresh wants a module to
 * export components and nothing else — main.tsx already defines `Analytics`
 * alongside its router table, and piling more onto that turns a lint exception
 * into a lint habit. For the same reason this is a component rather than the
 * `suspended(element)` helper it started as: a plain function returning JSX
 * trips the rule even from its own file.
 */

/**
 * What a route renders while its chunk is in flight.
 *
 * Deliberately near-empty. The chunks are small and same-origin, so on any real
 * connection this is on screen for a frame or two, and a spinner that flashes
 * for 40ms reads as jank rather than as progress. The `min-height` holds the
 * scroll position so swapping it for the real page does not shift layout under
 * the user — it exists to occupy space, not to say anything.
 */
function RouteFallback() {
  return <div style={{ minHeight: "60vh" }} aria-busy="true" />;
}

/** Wraps one lazy route element. Every React.lazy element needs a boundary
 *  above it, and this keeps the router table readable instead of repeating
 *  <Suspense fallback={…}> at seven call sites. */
export default function LazyRoute({ children }: { children: React.ReactNode }) {
  return <React.Suspense fallback={<RouteFallback />}>{children}</React.Suspense>;
}
