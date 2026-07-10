# The `larva` CLI

Everything in the [Larva API](../LARVA-DESIGN.md#13-api-surface-complete), runnable from a shell. It ships inside `@larva-db/core` — there is nothing extra to install:

```bash
npx larva --help        # any project with @larva-db/core installed
bunx larva --help       # same, under bun
npm i -g @larva-db/core # or install globally and just type `larva`
```

The CLI talks to the same database your app does: point it at the same Blob store and prefix, and `larva sql` sees exactly what `db.sql` sees.

## Setup — the one thing that must be right

The CLI needs **`BLOB_READ_WRITE_TOKEN`** (the same credential your app uses). It auto-loads `.env.local` and `.env` **from the directory you run it in** — so from a linked Vercel project, setup is one command:

```bash
vercel env pull .env.local   # writes BLOB_READ_WRITE_TOKEN into .env.local
npx larva version            # if this prints a number, you're connected
```

If the token is missing you get an immediate, specific error (see [Troubleshooting](#troubleshooting)) — the CLI never half-works without credentials.

## Global options

| Flag | Default | What it does |
|---|---|---|
| `--prefix PATH` | `larva/` | which database inside the store — every Larva database lives under a blob-path prefix |
| `--allow-full-table` | off | permit `UPDATE`/`DELETE` without a `WHERE` clause (deliberately explicit) |
| `-h`, `--help` | | usage text |

> **Mind the prefix.** Connecting is zero-config by design: pointing at a prefix with no database **creates a fresh, empty one**. If a query unexpectedly returns nothing or `UNKNOWN_TABLE`, the most likely cause is that you're at the wrong `--prefix` looking at a brand-new empty database — not that your data is gone.

## Commands

### `larva sql "STATEMENT"`

Run one statement in the [supported dialect](larva-for-agents.md). Rows print as a table, followed by timing and how many chunks the zone maps let the query skip:

```
$ npx larva sql "SELECT name, email FROM customers ORDER BY name"
┌───┬──────────────┬───────────────────┐
│   │ name         │ email             │
├───┼──────────────┼───────────────────┤
│ 0 │ Ada Lovelace │ ada@example.com   │
│ 1 │ Grace Hopper │ grace@example.com │
└───┴──────────────┴───────────────────┘
2 rows in 595ms — read 1/1 chunks
```

Writes work too — `INSERT ... RETURNING`, upserts, `CREATE TABLE`, all of it. Guardrails carry over from the API:

```
$ npx larva sql "DELETE FROM customers"
larva: DELETE without a WHERE clause affects every row in "customers"; add --allow-full-table if that is intended
```

Errors are the same machine-readable messages agents get, printed to stderr with exit code 1.

### `larva export --format postgres|sqlite|json|csv [--out FILE]`

Write the whole database to a file — the escape hatch, from your shell:

| Flag | Required | Notes |
|---|---|---|
| `--format` | yes | `postgres` (pg_dump-shaped `.sql`), `sqlite` (a genuine `.db` file), `json`, `csv` |
| `--out FILE` | no | defaults: `larva-export.sql` / `.db` / `.json`; `csv` writes one `larva-export-<table>.csv` per table |

```bash
npx larva export --format postgres --out export.sql
psql $DATABASE_URL < export.sql        # the entire migration to Postgres
```

The Postgres file has `CREATE TABLE`s with real types, data as fast `COPY` blocks, and foreign keys added after the data so load order never matters. **`sqlite` needs the bun runtime** (`bunx larva export --format sqlite`) — every other format works everywhere.

### `larva upgrade`

Flip the database to the top format — **the ordered commit log plus two-tier writes (fast appends)** — cheaper conflicts and commit cost that stops scaling with database size ([design §6](../LARVA-DESIGN.md#6-the-commit-protocol-and-consistency-model)). One atomic commit, one-way, idempotent; data, history, and rollback all survive:

```
$ npx larva upgrade
format 4 (the ordered commit log + two-tier writes), version 3
```

After the flip, clients older than the format refuse loudly (`FORMAT_UNSUPPORTED`) instead of writing through the wrong protocol.

### `larva rollback VERSION`

The undo button. Restores a past version as a **new** commit — nothing is destroyed, and the rollback itself can be rolled back:

```
$ npx larva rollback 41
restored v41 as new version 43 (undo with: larva rollback 42)
```

Find the version you want with `larva version` (current) or by checking timestamps in your app's `db.asOf()`. Retention is 7 days or 50 versions, whichever keeps more.

### `larva vacuum [--retain-days N] [--retain-versions N]`

Reclaim storage outside the retention window (defaults: 7 days / 50 versions, whichever keeps more):

```
$ npx larva vacuum
dropped 12 history objects and 4 chunks; 50 versions retained
```

### `larva version`

Prints the current database version — one integer, script-friendly. Also the cheapest possible "am I connected?" check.

## Exit codes

`0` on success, `1` on any failure, errors on **stderr** with the same machine-readable codes as the API (`UNSUPPORTED_FEATURE`, `MISSING_WHERE`, `UNIQUE_CONFLICT`, …) — safe to wire into scripts and agents.

## Troubleshooting

**`larva: BLOB_READ_WRITE_TOKEN is not set`** — the #1 issue. The CLI reads `.env.local` / `.env` from the **current directory**:
- Run `vercel env pull .env.local` in a linked project, or `export BLOB_READ_WRITE_TOKEN=...` in your shell.
- Already pulled it? Make sure you're running the CLI **from the directory that contains `.env.local`** (usually the project root).

**Queries return nothing / `UNKNOWN_TABLE`, but the app has data** — you're almost certainly at the wrong `--prefix`. Connecting auto-creates an empty database, so a typo'd prefix looks exactly like missing data. Find the prefix your app passes to `larva({ prefix })` (default `larva/`) and match it. `vercel blob list` shows what actually lives in the store.

**`FORMAT_UNSUPPORTED: this database uses format version N…`** — the store was upgraded by a newer client than your CLI. Do what the message says: `npm i -g @larva-db/core@latest` (or reinstall the project's dependency).

**`EXPORT_UNAVAILABLE` on `--format sqlite`** — SQLite export needs the bun runtime: `bunx larva export --format sqlite`. Postgres/JSON/CSV work under plain `npx`/node.

**`Commit failed after N attempts due to concurrent writers`** — heavy write contention (this is the loud `ConflictError`, never silent data loss). Rerun; if it persists, something is hammering the database — see the [performance envelope](../LARVA-DESIGN.md#10-the-performance-envelope--how-you-outgrow-larva).

**Slow first command (~a second)** — cold connect fetches the manifest and pins a snapshot; subsequent commands in scripts pay less. Timing is printed with every `sql` result so you can see it.
