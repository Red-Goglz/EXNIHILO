# Deploying the indexer

One Ponder process indexes one chain and serves the API for it. Run one
instance per chain; each rejects requests carrying a different `?chainId=`.

## Why Postgres and not the embedded PGlite

PGlite is a WASM Postgres writing to `packages/indexer/.ponder`. It is fine for
a laptop and wrong for a server:

- **Single process.** A second process touching the data dir aborts the engine
  (`RuntimeError: Aborted()`). That rules out rolling restarts and a second API
  replica, and lets a stale process wedge the whole indexer.
- **No backup story.** No `pg_dump`, no PITR, no replication — just a directory
  you must stop the process to copy safely.
- **The indexer and the API share one single-threaded process,** so API traffic
  competes directly with indexing.
- **Ponder caches contract reads in `ponder_sync.rpc_request_results`, inside
  the same database.** Losing the data dir loses the cache, and a cold re-sync
  costs ~9 RPC reads per position event.

Switching is one variable: set `DATABASE_URL`.

## Local development

```bash
docker run -d --name exnihilo-pg -p 5432:5432 \
  -e POSTGRES_USER=exnihilo -e POSTGRES_PASSWORD=exnihilo \
  -e POSTGRES_DB=exnihilo_indexer \
  -v exnihilo-pgdata:/var/lib/postgresql/data \
  --restart unless-stopped postgres:16-alpine
```

Then in `packages/indexer/.env.local`:

```
DATABASE_URL=postgresql://exnihilo:exnihilo@127.0.0.1:5432/exnihilo_indexer
```

`npm run dev:indexer` from the repo root.

## VPS

```bash
# as root, from this directory
bash provision-postgres.sh          # Postgres + role + db + service user + nightly pg_dump
install -m 0644 exnihilo-indexer.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now exnihilo-indexer
journalctl -u exnihilo-indexer -f
```

Postgres binds to `127.0.0.1` only — the indexer is on the same box, so the
database never needs a public interface.

Secrets live in `/etc/exnihilo/indexer.env` (mode 0600), referenced by the unit
via `EnvironmentFile=`. Nothing sensitive is in the unit file or in git.

### Restart behaviour

Ponder exits non-zero on an indexing error, so the unit uses `Restart=always`
with `RestartSec=10`, `RestartSteps=5` and `RestartMaxDelaySec=300`: retries
walk 10s → ~1m → ~5m and stay there. A wedged sync recovers without a human,
while a sustained failure settles at 12 attempts an hour instead of 360 — the
RPC provider does not get hammered, and the unit never gives up.

That last part is deliberate. `StartLimitIntervalSec`/`StartLimitBurst` were
tried first and were wrong twice over: they are only valid in `[Unit]`, so
sitting in `[Service]` they were silently ignored (`systemd-analyze verify`
shows the "Unknown key name" line) and the window fell back to the 10s default,
which `RestartSec=10` makes impossible to trip. And even placed correctly, a
start limit parks the unit in `failed` until someone runs `systemctl
reset-failed` — a bad trade when the commonest failure is a flaky RPC endpoint.

`RestartSteps` needs systemd 254+; Ubuntu 24.04 ships 255.

`TimeoutStopSec=30` covers Ponder's shutdown path, which can hang, before
`SIGKILL`.

### Restart behaviour of the other services

Neither Caddy nor Postgres restarts on failure out of the box, so both get a
drop-in from `deploy/systemd/` (installed by the provision scripts):

| Service | Packaged default | Drop-in |
|---|---|---|
| Caddy | no `Restart=` at all → `Restart=no` | `on-failure`, `RestartSec=5s` |
| Postgres | `Restart=` commented out deliberately | `on-failure`, `RestartSec=10s` |

They are drop-ins under `/etc/systemd/system/<unit>.d/` rather than edits,
because both packages overwrite their own unit files on upgrade.

**The Postgres one overrides a deliberate Debian decision.** Read the header of
`deploy/systemd/postgresql-restart.conf` before keeping it. The short version:
`pg_ctlcluster 16 main stop` run directly will now be undone by systemd — use
`systemctl stop postgresql@16-main` instead. Package upgrades are unaffected.
Applying a drop-in only needs `systemctl daemon-reload`, not a service restart,
so none of this costs downtime or a re-sync.

### Schema changes

Ponder writes into a schema named by `--schema`. Changing `ponder.schema.ts`
(including adding indexes) requires a fresh schema name or a re-index; it does
not migrate in place. Deploy a new schema, let it sync, then point the reverse
proxy at the new instance.

## Reverse proxy

Caddy, giving the API a real HTTPS origin for `VITE_INDEXER_URL_AVALANCHE`:

```
indexer.exnihilo.markets {
    reverse_proxy 127.0.0.1:42069
}
```

## Operational notes

- **RPC volume is 2 reads per position event**, not 9: `EXNIHILOPool.indexerState()`
  bundles the four fee accumulators and four price/reserve values into a single
  `eth_call`, leaving that plus `PositionNFT.getPosition`. Pool-only events
  (renew, close, expire, pool close) cost 1. Measured: 25 reads for 10 positions
  across 5 pools, against 95 before bundling.
  Do not go back to reading the fields individually — and prefer extending
  `indexerState()` over adding a second read if the indexer needs more.
- **The RPC endpoint is the thing that breaks on a VPS, and it fails
  misleadingly.** Two separate traps, both hit on the Contabo deploy:
  - `api.avax-test.network` is behind Cloudflare, which blocks datacenter IP
    ranges. Every request returns a "Sorry, you have been blocked" HTML page,
    viem raises `HttpRequestError`, and Ponder exits on the unhandled
    rejection. It works fine from a laptop, which is what makes it such a
    convincing default.
  - PublicNode accepts hosting ranges but rejects *archive* queries
    (`Archive requests require a personal token`). Realtime sync looks healthy
    while the backfill never completes.

  So when swapping endpoints, test with an archive `eth_getLogs` at
  `START_BLOCK` — every endpoint that failed above answered `eth_blockNumber`
  correctly. On Fuji, `avalanche-fuji.drpc.org` serves both.

  Both traps are **testnet-specific**. Production now indexes Avalanche
  mainnet, where the public `api.avax.network/ext/bc/C/rpc` handles archive
  `eth_getLogs` fine and is not blocked from hosting ranges — it is what the
  box uses today. Do not assume the mainnet and testnet endpoints behave alike;
  they are run differently. A paid endpoint is still worth it for a large
  backfill.
- **`START_BLOCK` is the factory's deploy block** (`src/chain.ts`). Never lower
  it — there is nothing to index before the factory exists, and doing so turns
  a minutes-long backfill into an hours-long one.
- **Restarts are cheap only while the RPC cache survives.** Keep the database.
