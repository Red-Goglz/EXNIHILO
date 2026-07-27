import { Navigate, Outlet, useLocation, useParams } from "react-router-dom";
import { appPath, DEFAULT_CHAIN, isChainSlug } from "../../lib/chains.ts";

/**
 * Guards /app/:chainSlug/* routes. Unknown slugs are treated as legacy
 * chainless URLs (e.g. /app/markets/0xabc) and redirected to the same
 * path under the default chain (/app/fuji/markets/0xabc).
 */
export default function ChainRoute() {
  const { chainSlug } = useParams();
  const { pathname, search, hash } = useLocation();

  if (!isChainSlug(chainSlug)) {
    const rest = pathname.replace(/^\/app\/?/, "");
    return (
      <Navigate
        to={`${appPath(DEFAULT_CHAIN.slug, rest)}${search}${hash}`}
        replace
      />
    );
  }

  return <Outlet />;
}

/** Fallback for unknown sub-paths under a valid chain — back to the feed. */
export function RedirectToFeed() {
  const { chainSlug } = useParams();
  const slug = isChainSlug(chainSlug) ? chainSlug : DEFAULT_CHAIN.slug;
  return <Navigate to={appPath(slug)} replace />;
}
