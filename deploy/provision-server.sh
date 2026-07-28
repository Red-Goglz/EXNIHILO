#!/usr/bin/env bash
# Provision a fresh Ubuntu 24.04 box to serve EXNIHILO: the static site + docs
# behind Caddy, and the Ponder indexer + API behind the same proxy.
#
#   sudo bash provision-server.sh
#
# Idempotent — safe to re-run. Postgres, the service user and the indexer
# secrets file are handled by packages/indexer/deploy/provision-postgres.sh,
# which this script invokes if it is present.
set -euo pipefail

NODE_MAJOR="${NODE_MAJOR:-22}"
APP_DIR="${APP_DIR:-/srv/exnihilo}"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "==> Base packages"
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl gnupg git ufw fail2ban unattended-upgrades rsync

echo "==> Unattended security upgrades"
# Security patches without a human. Reboots are left off deliberately: the
# indexer's restart is cheap but a surprise reboot mid-backfill is not.
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF

echo "==> Firewall"
# Order matters: allow SSH *before* enabling, or this script locks itself out.
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw default deny incoming
ufw default allow outgoing
ufw --force enable
ufw status verbose

echo "==> Node.js ${NODE_MAJOR}"
if ! command -v node &>/dev/null || [[ "$(node -v)" != v${NODE_MAJOR}* ]]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
  chmod a+r /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
echo "    node $(node -v), npm $(npm -v)"

echo "==> Caddy"
if ! command -v caddy &>/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg --yes
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi
echo "    $(caddy version)"

echo "==> Caddy restart policy"
# The packaged unit has no Restart=, so Caddy defaults to Restart=no and a crash
# takes the site and the indexer proxy down until a human notices. A drop-in
# rather than an edit: the package overwrites its own unit on upgrade.
CADDY_DROPIN="$(dirname "$0")/systemd/caddy-restart.conf"
if [[ -f "$CADDY_DROPIN" ]]; then
  install -d -m 0755 /etc/systemd/system/caddy.service.d
  install -m 0644 "$CADDY_DROPIN" /etc/systemd/system/caddy.service.d/restart.conf
  systemctl daemon-reload
  echo "    Restart=$(systemctl show caddy -p Restart --value), RestartSec=$(systemctl show caddy -p RestartUSec --value)"
else
  echo "    !! ${CADDY_DROPIN} not found — Caddy will not restart on failure" >&2
fi

echo "==> Postgres + service user + indexer secrets"
PG_SCRIPT="$(dirname "$0")/../packages/indexer/deploy/provision-postgres.sh"
if [[ -f "$PG_SCRIPT" ]]; then
  bash "$PG_SCRIPT"
else
  echo "    !! ${PG_SCRIPT} not found — run it manually before starting the indexer" >&2
fi

echo "==> Application directory"
install -d -m 0755 -o exnihilo -g exnihilo "$APP_DIR"

# Caddy runs as its own user and only needs to read the built site.
usermod -aG exnihilo caddy 2>/dev/null || true

cat <<DONE

──────────────────────────────────────────────────────────────
Server provisioned.

  node    $(node -v)
  caddy   $(caddy version | head -1)
  app dir ${APP_DIR}

Next, from your workstation:
  bash deploy/deploy.sh

Then install the proxy config and start the indexer:
  install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
  systemctl reload caddy
  install -m 0644 packages/indexer/deploy/exnihilo-indexer.service /etc/systemd/system/
  systemctl daemon-reload && systemctl enable --now exnihilo-indexer
──────────────────────────────────────────────────────────────
DONE
