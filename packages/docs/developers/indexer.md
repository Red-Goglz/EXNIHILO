---
description: "How the Ponder indexer serves price history, LP APR and protocol analytics, why it runs one instance per chain, and what breaks without it."
---

# Indexer

The dApp reads live state directly from the chain, but anything **historical or
aggregated** — price charts, LP APR, protocol analytics — comes from a
[Ponder](https://ponder.sh) indexer in `packages/indexer`.

Without it the app still works: markets, positions and trading are all on-chain
reads. You lose price history, APR, and the analytics page.

## One instance per chain

A Ponder process indexes exactly one chain. The HTTP API rejects requests
carrying a different `?chainId=` with a 404 rather than answering with
wrong-chain data:

```json
{ "error": "This indexer serves chainId 43114, got 31337" }
```

To serve both mainnet and a local node, run **two instances on different ports**
and give each chain its own URL in the frontend (`VITE_INDEXER_URL_AVALANCHE`,
`VITE_INDEXER_URL_LOCAL`). The site's chain registry
(`packages/site/src/lib/chains.ts`) only queries chains that have an
`indexerUrl`, so an unindexed chain shows an "unavailable" state instead of
firing requests that can only fail.

## Configuration

Everything lives in `packages/indexer/.env.local` (copy `.env.example`).
Chain id, contract addresses and start block default to the Avalanche mainnet
deployment in `src/chain.ts` and are all overridable. The RPC variable name is
derived from the chain id, so it must match `PONDER_CHAIN_ID`:

```bash
# Avalanche mainnet (defaults — only the RPC is required)
PONDER_RPC_URL_43114=https://api.avax.network/ext/bc/C/rpc

# Local Hardhat node
# PONDER_CHAIN_ID=31337
# PONDER_START_BLOCK=0
# PONDER_RPC_URL_31337=http://127.0.0.1:8545
# PONDER_FACTORY_ADDRESS=0x...
# PONDER_POSITION_NFT_ADDRESS=0x...
# PONDER_LP_NFT_ADDRESS=0x...

DATABASE_URL=postgresql://exnihilo:exnihilo@127.0.0.1:5432/exnihilo_indexer
```

`START_BLOCK` is the factory's own deploy block. Never lower it — there is
nothing to index before the factory exists, and doing so turns a minutes-long
backfill into an hours-long one.

## Storage

**Use Postgres.** With `DATABASE_URL` unset, Ponder falls back to PGlite (an
embedded WASM Postgres writing to `.ponder/`), which is fine on a laptop and
wrong on a server:

- **Single process.** A second process touching the data directory aborts the
  WASM engine, so there are no rolling restarts and no second API replica.
- **No backup story** — no `pg_dump`, no PITR, no replication.
- The indexer and the API share one single-threaded process, so API traffic
  competes with indexing.
- Ponder caches contract reads in `ponder_sync.rpc_request_results` **inside the
  same database**. Losing it means re-reading everything.

Local Postgres:

```bash
docker run -d --name exnihilo-pg -p 5432:5432 \
  -e POSTGRES_USER=exnihilo -e POSTGRES_PASSWORD=exnihilo \
  -e POSTGRES_DB=exnihilo_indexer \
  -v exnihilo-pgdata:/var/lib/postgresql/data \
  --restart unless-stopped postgres:16-alpine
```

## Running it

```bash
npm run dev:indexer      # hot reload, from the repo root
npm run start:indexer    # production
```

Serves on **42069** by default; override with `PORT`. Pin it explicitly in
production — Ponder silently increments to the next free port if it is taken,
which desynchronises it from `VITE_INDEXER_URL_*`.

## Fee accounting — read this before changing handlers

The LP/protocol fee split is **never** derived from the 3%/2% bps constants. The
pool routes the whole impact fee to LPs and takes a separate close fee on
surplus, so the ratio moves with crowding and depth.

Handlers instead read the pool's lifetime accrual and record the delta since the
last indexed event. `accumulated + paidTotal` is monotonic — collecting fees
zeroes the former and adds the same amount to the latter — so the delta is never
negative.

## RPC budget

Each position event costs **2 reads**, not 9: `EXNIHILOPool.indexerState()`
bundles four fee accumulators and four price/reserve values into a single
`eth_call`, leaving that plus `PositionNFT.getPosition`. Pool-only events
(renew, close, expire, pool close) cost 1.

Prefer extending `indexerState()` over adding a second read. Bundling
contract-side works on every chain, unlike `client.multicall`, which needs
Multicall3 deployed and so would break against a bare Hardhat node.

## HTTP API

All routes take `?chainId=`.

| Route | Returns |
|---|---|
| `/api-status` | `{ status, chainId }` |
| `/prices/:pool?limit=` | Price snapshots (spot / long / short), oldest first |
| `/positions/:pool?status=` | Positions in a pool |
| `/positions/user/:address` | Positions held by an address |
| `/position/:nftId` | One position |
| `/metrics/pool/:pool`, `/metrics/pools` | Per-pool volume, fees, counts |
| `/metrics/protocol` | Protocol-wide totals |
| `/metrics/users`, `/metrics/user/:address` | User aggregates |
| `/metrics/daily[/:pool]?days=` | Daily volume, fees, positions, unique users |
| `/metrics/apr/:pool` | LP APR over 1d / 7d / 30d |

`uniqueUsers` is a genuine distinct count, backed by a per-(scope, day, address)
table — not an event counter.

## Schema changes require a re-index

Ponder writes into a schema named by `--schema`. Changing `ponder.schema.ts`,
**including adding an index**, does not migrate in place. Deploy under a new
schema name, let it sync, then repoint the reverse proxy.

## Deployment

See [`packages/indexer/deploy/README.md`](https://github.com/Red-Goglz/EXNIHILO/tree/main/packages/indexer/deploy)
for the VPS runbook: `provision-postgres.sh`, a hardened systemd unit with
restart-on-failure, and a Caddy reverse-proxy snippet.
