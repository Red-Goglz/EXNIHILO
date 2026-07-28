#!/usr/bin/env bash
# Provision Postgres for the EXNIHILO indexer on a fresh Debian/Ubuntu VPS.
#
#   sudo bash provision-postgres.sh
#
# Idempotent: re-running will not clobber an existing role, database or config.
# Prints the DATABASE_URL to paste into /etc/exnihilo/indexer.env.
set -euo pipefail

DB_NAME="${DB_NAME:-exnihilo_indexer}"
DB_USER="${DB_USER:-exnihilo}"
DB_PASS="${DB_PASS:-$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)}"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

echo "==> Installing PostgreSQL"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq postgresql postgresql-contrib

systemctl enable --now postgresql

echo "==> Creating role and database"
# Bind on localhost only. The indexer runs on the same box, so Postgres never
# needs to listen on a public interface — that is the single biggest win for
# not having to think about database firewalling.
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';
  END IF;
END
\$\$;
SQL

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  sudo -u postgres createdb -O "${DB_USER}" "${DB_NAME}"
  echo "    created database ${DB_NAME}"
else
  echo "    database ${DB_NAME} already exists — leaving it alone"
fi

echo "==> Creating service user and directories"
id -u exnihilo &>/dev/null || useradd --system --create-home --shell /usr/sbin/nologin exnihilo
install -d -m 0750 -o exnihilo -g exnihilo /etc/exnihilo

ENV_FILE=/etc/exnihilo/indexer.env
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<ENV
# EXNIHILO indexer — secrets. Keep mode 0600.
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}

# NOT api.avax-test.network. That endpoint sits behind Cloudflare, which blocks
# datacenter IPs outright — from a VPS every request comes back as a "Sorry, you
# have been blocked" HTML page, and Ponder dies on the unhandled rejection. It
# works from a laptop, which is what makes it such a convincing default.
#
# Not PublicNode either: it accepts hosting ranges but answers any historical
# eth_getLogs with "Archive requests require a personal token", which kills the
# backfill while realtime sync looks fine. dRPC serves both. Verify a
# replacement with an *archive* eth_getLogs against START_BLOCK, not
# eth_blockNumber — every dead endpoint here passed eth_blockNumber.
PONDER_RPC_URL_43113=https://avalanche-fuji.drpc.org
ENV
  chown exnihilo:exnihilo "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
  echo "    wrote $ENV_FILE"
else
  echo "    $ENV_FILE exists — not overwriting"
fi

echo "==> Nightly backup (pg_dump, 14 days retained)"
install -d -m 0750 -o postgres -g postgres /var/backups/exnihilo
cat > /etc/cron.daily/exnihilo-pgdump <<'CRON'
#!/bin/sh
set -e
OUT="/var/backups/exnihilo/exnihilo_indexer-$(date +%F).sql.gz"
sudo -u postgres pg_dump -Fc exnihilo_indexer | gzip > "$OUT"
find /var/backups/exnihilo -name '*.sql.gz' -mtime +14 -delete
CRON
chmod +x /etc/cron.daily/exnihilo-pgdump

cat <<DONE

──────────────────────────────────────────────────────────────
Postgres ready.

  DATABASE_URL=postgresql://${DB_USER}:*****@127.0.0.1:5432/${DB_NAME}

  Full value is in ${ENV_FILE} (mode 0600).

Next:
  install -m 0644 exnihilo-indexer.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now exnihilo-indexer
  journalctl -u exnihilo-indexer -f
──────────────────────────────────────────────────────────────
DONE
