---
description: "How the Ponder indexer serves price history, funding, LP APR and protocol analytics, why it runs one instance per chain, and what breaks without it."
---

# Indexer

Live state comes straight from the chain, but anything **historical or aggregated** — price charts,
funding history, LP APR, analytics — comes from a [Ponder](https://ponder.sh) indexer in
`packages/indexer`. Without it trading still works; those views are empty.

## One instance per chain

A Ponder process follows exactly one chain, and the API answers any other `?chainId=` with a 404
rather than wrong data. To serve two chains, run two instances. The site only queries chains that
have an `indexerUrl` in `packages/site/src/lib/chains.ts`.

## Configuration

Settings live in `packages/indexer/.env.local` (copy `.env.example`). The defaults follow
Avalanche mainnet, with contract addresses and start block read from the deployment's address book,
`packages/site/src/contracts/mainnetAddresses.json` — so a redeploy moves the site and the indexer
together. Only the RPC is required:

```bash
PONDER_RPC_URL_43114=https://api.avax.network/ext/bc/C/rpc   # suffix = the chain id
DATABASE_URL=postgresql://exnihilo:exnihilo@127.0.0.1:5432/exnihilo_indexer
# PORT=42069
```

To follow a local node, override the chain and addresses (from `localAddresses.json`):

```bash
PONDER_CHAIN_ID=31337
PONDER_START_BLOCK=0
PONDER_RPC_URL_31337=http://127.0.0.1:8545
PONDER_FACTORY_ADDRESS=0x...
PONDER_POSITION_NFT_ADDRESS=0x...
PONDER_LP_NFT_ADDRESS=0x...
```

Never set the start block below the factory's deploy block: there is nothing to index before it, and
a backfill from earlier takes hours instead of minutes.

## Storage

**Use Postgres.** With `DATABASE_URL` unset Ponder falls back to embedded PGlite, which is
single-process (no rolling restarts, no replica), has no backup story, and takes Ponder's RPC cache
down with it. Fine on a laptop, wrong on a server.

```bash
docker run -d --name exnihilo-pg -p 5432:5432 \
  -e POSTGRES_USER=exnihilo -e POSTGRES_PASSWORD=exnihilo -e POSTGRES_DB=exnihilo_indexer \
  -v exnihilo-pgdata:/var/lib/postgresql/data --restart unless-stopped postgres:16-alpine
```

## Running

```bash
npm run dev:indexer      # hot reload, from the repo root
npm run start:indexer    # production
```

It serves on **42069**. Pin `PORT` in production: Ponder silently moves to the next free port if it
is taken, which desynchronises it from the site's `VITE_INDEXER_URL_AVALANCHE`.

## What it records

- **Fees** come from the pool's lifetime accumulators (`accumulated + paidTotal`, which only grows),
  stored as deltas. They are never derived from the 4% / 1% constants, because the impact fee and the
  close fee make the split variable.
- **Funding** never reaches those accumulators. It is recorded from `FundingAccrued` — collateral
  released and debt cancelled per side, in separate columns because their units differ.
- **Live position sizes** are reconstructed from each side's funding index rather than stored, so
  listing positions needs no per-position calls.

A position event costs two RPC reads — `indexerState()` and `getPosition` — and a pool-only event
one. Extend `indexerState()` rather than adding reads.

## HTTP API

All routes take `?chainId=`.

| Route | Returns |
|---|---|
| `/api-status` | `{ status, chainId }` |
| `/prices/:pool?limit=` | Price snapshots: spot, long and short price, both funding indices (RAY), and the triggering event |
| `/positions/:pool?status=` | Positions in a pool, with live size |
| `/positions/user/:address` | Positions held by an address |
| `/position/:nftId` | One position, with live collateral, debt and notional |
| `/funding/:pool` | Funding rates per side (RAY and % per day), indices, collateral released and debt cancelled |
| `/metrics/pool/:pool`, `/metrics/pools` | Per-pool volume, fees and counts |
| `/metrics/protocol` | Protocol totals |
| `/metrics/users`, `/metrics/user/:address` | User aggregates |
| `/metrics/daily[/:pool]?days=` | Daily volume, fees, positions and distinct users |
| `/metrics/apr/:pool` | LP APR over 1d / 7d / 30d |

## Schema changes need a re-index

Ponder writes into the schema named by `--schema` and does not migrate in place. Changing
`ponder.schema.ts` — even adding an index — means deploying under a new schema name, letting it sync,
then repointing the proxy. The VPS runbook is in
[`packages/indexer/deploy/`](https://github.com/Red-Goglz/EXNIHILO/tree/main/packages/indexer/deploy).
