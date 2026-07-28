#!/usr/bin/env bash
# Ship the current working tree to the VPS, build it there, and restart services.
#
#   bash deploy/deploy.sh [user@host]
#
# Uploads your working tree rather than pulling from GitHub, so what lands on
# the server is exactly what you have locally — including changes you have not
# committed or pushed. It packs the *tracked* file list at their current
# on-disk contents; `git archive HEAD` would silently ship the last commit
# instead and quietly ignore every uncommitted edit. Gitignored files
# (node_modules, .env, build output) are excluded; the secrets the build needs
# are copied separately below.
set -euo pipefail

# The tailnet address, not the public IP: SSH is restricted to the tailscale0
# interface, so 169.58.83.213:22 times out from the open internet. You must be
# logged into the same Tailscale account for this to resolve.
TARGET="${1:-deploy@100.65.57.84}"
APP_DIR="/srv/exnihilo"
INDEXER_URL="${INDEXER_URL:-https://indexer.exnihilo.markets}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

DIRTY="$(git status --porcelain | wc -l | tr -d ' ')"
echo "==> Packing working tree at $(git rev-parse --short HEAD) (${DIRTY} uncommitted change(s))"
git ls-files -z | tar --null -T - -czf "$TMP/exnihilo.tar.gz"

echo "==> Uploading"
scp -q "$TMP/exnihilo.tar.gz" "$TARGET:/tmp/exnihilo.tar.gz"

# Build-time secrets. VITE_* values are compiled into the JS bundle and are
# therefore public by nature, but they still live outside git.
if [[ -f packages/site/.env ]]; then
  scp -q packages/site/.env "$TARGET:/tmp/site.env"
else
  echo "!! packages/site/.env missing — the build will have no WalletConnect id" >&2
fi

echo "==> Building on the server"
ssh "$TARGET" "sudo APP_DIR='$APP_DIR' INDEXER_URL='$INDEXER_URL' bash -s" <<'REMOTE'
set -euo pipefail

install -d -m 0755 -o exnihilo -g exnihilo "$APP_DIR"
tar -xzf /tmp/exnihilo.tar.gz -C "$APP_DIR"
rm -f /tmp/exnihilo.tar.gz

if [[ -f /tmp/site.env ]]; then
  install -m 0644 /tmp/site.env "$APP_DIR/packages/site/.env"
  rm -f /tmp/site.env
fi

# The local .env points VITE_INDEXER_URL_FUJI at a dev box. Vite loads
# .env.production after .env in a production build, so this overrides it
# without touching the file the developer keeps locally.
cat > "$APP_DIR/packages/site/.env.production" <<ENV
VITE_INDEXER_URL_AVALANCHE=${INDEXER_URL}
ENV

chown -R exnihilo:exnihilo "$APP_DIR"

cd "$APP_DIR"
# The blockchain workspace pulls in Hardhat and the Solidity toolchain, none of
# which the server needs to serve a site or index events.
npm ci --workspace packages/abis \
       --workspace packages/docs \
       --workspace packages/site \
       --workspace packages/indexer \
       --include-workspace-root

# Root build = VitePress docs (into packages/site/public/docs) then the Vite app.
npm run build

chown -R exnihilo:exnihilo "$APP_DIR"
REMOTE

echo "==> Restarting services"
ssh "$TARGET" '
  sudo systemctl restart exnihilo-indexer 2>/dev/null || echo "   (indexer unit not installed yet)"
  sudo systemctl reload caddy 2>/dev/null || echo "   (caddy not configured yet)"
'

echo "==> Done"
