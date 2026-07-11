<p align="center">
  <img src="https://raw.githubusercontent.com/pango07/larva-db/main/docs/larvadb.png" alt="larvadb" width="340">
</p>

**A tiny SQL database that lives inside your Vercel Blob store.** No signup, no new vendor, no server, no connection string. When your app grows up, export to a bigger database with one command — that's why it's called Larva.

[![CI](https://github.com/pango07/larva-db/actions/workflows/ci.yml/badge.svg)](https://github.com/pango07/larva-db/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40larva-db%2Fcore)](https://www.npmjs.com/package/@larva-db/core)
[![types](https://img.shields.io/badge/types-included-blue)](https://github.com/pango07/larva-db/blob/main/packages/larvadb/src/index.ts)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/pango07/larva-db/blob/main/LICENSE)

Real SQL (time series, upserts, JSON, multi-table joins, subqueries), atomic transactions, time travel, and a guaranteed exit path to SQLite *or* Postgres.

## Sixty seconds to a database

```bash
npm install @larva-db/core
```

```ts
import { defineSchema, larva, t } from "@larva-db/core";

const schema = defineSchema({
  customers: {
    id: t.text().primaryKey(),          // ULIDs generated for you
    name: t.text(),
    email: t.text().unique(),
    createdAt: t.timestamp().partitionBy(), // ← makes date filters fast
  },
});

const db = larva({ schema }); // credentials auto-discovered from the Vercel env
```

That's the whole setup — no migrations to run, no dashboard to visit. Query it:

```ts
// ${...} values are parameterized automatically — never string-concatenated
await db.sql`INSERT INTO customers (name, email, createdAt)
             VALUES (${"Ada"}, ${"ada@example.com"}, ${"2026-06-01T00:00:00Z"})
             RETURNING *`;
// → [{ id: "01KX...", name: "Ada", email: "ada@example.com", createdAt: "2026-06-01T00:00:00Z" }]

await db.sql`SELECT name FROM customers WHERE email = ${"ada@example.com"}`;
// → [{ name: "Ada" }]
```

## What you can do with it

### Dashboard queries — time series included

```ts
// revenue by day
await db.sql`SELECT DATE(createdAt) AS day, SUM(total) AS revenue
             FROM orders
             GROUP BY DATE(createdAt)
             ORDER BY day`;
// → [{ day: "2026-07-01", revenue: 340 }, { day: "2026-07-02", revenue: 125 }, ...]

// monthly buckets, joins, HAVING — the usual dashboard shapes all work
await db.sql`SELECT customers.name, SUM(orders.total) AS revenue
             FROM orders
             INNER JOIN customers ON orders.customerId = customers.id
             GROUP BY customers.name
             HAVING revenue > ${100}
             ORDER BY revenue DESC
             LIMIT 10`;
```

### Upserts — the counter pattern

```ts
await db.sql`INSERT INTO counters (slug, count) VALUES (${"visits"}, ${1})
             ON CONFLICT (slug) DO UPDATE SET count = count + ${1}`;
```

### Auto IDs, sequences & composite uniques

`t.uuid()` fills a time-ordered UUID on insert — nothing to coordinate, so ID generation never contends. `t.sequence()` auto-assigns small integers that are unique across concurrent processes (drawn from CAS-claimed ranges, gappy on crash — exactly a Postgres sequence). Composite uniques guard pairs, and work as upsert targets:

```ts
const schema = defineSchema(
  {
    orders: { id: t.uuid().primaryKey(), memo: t.text() },
    invoices: { number: t.sequence().primaryKey(), customer: t.text() },
    grants: { id: t.text().primaryKey(), userId: t.text(), feature: t.text(), level: t.integer() },
  },
  { uniques: { grants: [["userId", "feature"]] } },
);

await db.sql`INSERT INTO orders (memo) VALUES (${"first"}) RETURNING id`;
// → [{ id: "0197f8c2-…" }] — omit the column, read it back
await db.sql`INSERT INTO invoices (customer) VALUES (${"ada"}) RETURNING number`;
// → [{ number: 42 }]      — same ergonomics, human-facing numbers

await db.sql`INSERT INTO grants (userId, feature, level) VALUES (${"u1"}, ${"exports"}, ${2})
             ON CONFLICT (userId, feature) DO UPDATE SET level = excluded.level`;
```

### Transactions — several statements, one atomic commit

```ts
await db.transaction(async (tx) => {
  const [order] = await tx.sql`INSERT INTO orders (customerId, total)
                               VALUES (${customerId}, ${99.5}) RETURNING *`;
  await tx.sql`UPDATE inventory SET count = count - 1 WHERE sku = ${sku}`;
});
// either both happened, or neither did
```

### JSON columns (the practical way)

Store JSON with `t.text()` + `JSON.stringify`, then query inside it:

```ts
await db.sql`SELECT JSON_EXTRACT(payload, ${"$.user.name"}) AS who FROM events`;
await db.sql`SELECT payload ->> ${"status"} AS status FROM events`;
```

### The undo button

Every commit is a new immutable version. When something goes wrong — say an AI agent deleted the wrong rows — recovery is one line:

```ts
const past = await db.asOf(new Date(Date.now() - 10 * 60 * 1000)); // 10 min ago
await past.sql`SELECT COUNT(*) FROM customers`;  // peek at the past, read-only
await db.rollbackTo(past.version);               // restore it (itself undoable)
```

### The escape hatch — graduate in one command

Your data is never trapped. That's a promise, not a feature:

```ts
// → Postgres (Neon, Supabase, RDS…): one .sql file, pg_dump-shaped —
//   CREATE TABLEs with real types, data as fast COPY blocks, and your
//   .references() declarations become genuine FOREIGN KEY constraints
const sql = await db.export({ format: "postgres" });
await Bun.write("export.sql", sql);
// then:  psql $DATABASE_URL < export.sql     ← the entire migration

await db.export({ format: "sqlite" }); // a genuine .db file → Turso, D1, anywhere
await db.export({ format: "csv" });    // spreadsheets
await db.export({ format: "json" });   // everything else
await db.vacuum();                     // reclaim storage outside retention
```

### Typed rows

```ts
import type { InferRow } from "@larva-db/core";

type Customer = InferRow<typeof schema, "customers">;
// { id: string; name: string | null; email: string | null; createdAt: string | null }

const rows = await db.sql<Customer>`SELECT * FROM customers`;
```

### More write headroom — the commit log + fast appends

Format 3 changes how commits land: instead of re-uploading the whole manifest per commit, each commit is a tiny immutable delta in an ordered log, and the manifest becomes a periodic checkpoint. Conflicts get cheap (losing a race costs one small read, not a manifest round-trip), write cost stops scaling with database size, and contention tails shrink — same guarantees, verified by the same stress/property gauntlet. One-way, explicit, and old clients refuse loudly instead of corrupting:

Format 4 adds **fast appends** on top: an INSERT whose outcome is fully client-determined — auto-generated id (`t.uuid()`, `t.sequence()`, or the implicit ULID), no unique constraints — is acknowledged the moment one durable PUT lands in a per-writer queue, then folded into the log in the background. Zero contention with anyone, your own reads see the rows immediately, and ordered writes (UPDATE/DELETE/transactions) fold first so they never miss them. Event logs, activity feeds, and telemetry stop touching the ordered path entirely. And when many instances hammer the same rows, the contention heuristic stops the retry storms: writers queue their statements and a lease-elected leader lands every waiting writer's work as **one** commit, each statement's result (or precise error) delivered back individually.

```ts
await db.upgrade();                      // flip an existing database
const db2 = larva({ schema, commitLog: true }); // or start new ones there
```

### The CLI

The whole API is also a shell command — `npx larva` works wherever `@larva-db/core` is installed:

```bash
npx larva sql "SELECT name, email FROM customers LIMIT 5"
npx larva export --format postgres --out export.sql  # then: psql $DATABASE_URL < export.sql
npx larva upgrade                                    # flip to format 4: the commit log + fast appends
npx larva rollback 41                                # the undo button, from your shell
npx larva vacuum
npx larva version
```

Credentials auto-load from `.env.local` (`vercel env pull .env.local`); `--prefix` targets a specific database. Full reference — every command, flag, and troubleshooting — in [docs/cli.md](https://github.com/pango07/larva-db/blob/main/docs/cli.md).

### Any S3-compatible store

Vercel Blob is the default, but the storage contract is four operations, so the same database runs on AWS S3 or Cloudflare R2 — zero extra dependencies:

```ts
import { larva, S3Adapter } from "@larva-db/core";

const db = larva({
  schema,
  store: new S3Adapter({
    bucket: "my-bucket",
    endpoint: "https://<account>.r2.cloudflarestorage.com", // omit for AWS S3
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  }),
});
```

## Give this to your AI agent

Larva is built for apps where an agent writes the SQL. The prompt that teaches an agent the dialect, the guardrails, and the performance rules lives at **[docs/larva-for-agents.md](https://github.com/pango07/larva-db/blob/main/docs/larva-for-agents.md)** — paste its contents into your agent's instructions (CLAUDE.md, AGENTS.md, .cursorrules, a system prompt).

The short version of what it teaches:

- always interpolate with `${…}` (parameterized automatically) — never concatenate SQL
- the supported dialect, and what to do instead for everything outside it
- `UPDATE`/`DELETE` without `WHERE` needs `{ allowFullTable: true }`; multi-statement changes go in `db.transaction`
- filter on raw pk/partition columns for pruning (`createdAt >= '…'`, not `DATE(createdAt) >= '…'`)
- surface `ConflictError`, never swallow it — and `db.rollbackTo()` undoes mistakes

Errors are machine-readable on purpose — agents self-correct from specific messages:

```
UNSUPPORTED_FEATURE: window functions are not supported in Larva v1;
compute windows in application code — tables at this scale fit in memory
```

## Who it's for — and honest limits

Larva is for the enormous long tail of **small applications**: dashboards, internal tools, hobby apps, prototypes, and anything an AI agent is building for you. Within that envelope it promises what most "lightweight" solutions don't: **no silently lost writes, atomic multi-statement transactions, snapshot-isolated reads, and point-in-time rollback.**

The limits, stated plainly (they're physics, not configuration):

- **Storage** grows to gigabytes — that axis never runs out.
- **Writes**: every commit serializes through one compare-and-swap. Sustained throughput is roughly one commit per second (concurrent writers in the same process coalesce into shared commits); five people editing a dashboard will never notice, fifty writes per second will hit a wall.
- **Reads**: queries pull data to the compute. Filters on the primary key or the `.partitionBy()` column prune aggressively; anything else scans the table — fine at tens of thousands of rows, untenable at millions.

When you get there, congratulations: run the export and graduate — `psql $DATABASE_URL < export.sql` and you're on Postgres.

## SQL dialect

Real SQL strings, deliberately scoped: `SELECT` (with `DISTINCT`) over full expressions — arithmetic, `||` concatenation, `CASE WHEN`, `CAST`, scalar functions (`UPPER`, `LOWER`, `LENGTH`, `TRIM`, `ROUND`, `ABS`, `COALESCE`, `NULLIF`, `IFNULL`, `REPLACE`, `CEIL`, `FLOOR`, `MOD`, `SUBSTR`), date helpers (`NOW()`/`CURRENT_TIMESTAMP`, `DATE(x)`, `STRFTIME('%Y-%m', x)` — timestamps are ISO text, so this is cheap and range filters stay prunable), and JSON over text columns (`JSON_EXTRACT(col, '$.a[0]')`, `->>`); `WHERE` (`=`, `!=`, `<`, `>`, `<=`, `>=`, `AND`, `OR`, `NOT`, `IN`, `BETWEEN`, `LIKE`, `IS NULL`), `ORDER BY`, `LIMIT`/`OFFSET`, `GROUP BY` over expressions or aliases (`GROUP BY DATE(createdAt)`) with `COUNT`/`SUM`/`AVG`/`MIN`/`MAX`/`GROUP_CONCAT` (incl. `COUNT(DISTINCT …)`) and `HAVING`, `INNER`/`LEFT JOIN` across any number of tables including self-joins; uncorrelated subqueries (`WHERE id IN (SELECT …)`, scalar comparisons); `INSERT` (multi-row, `RETURNING`) with `ON CONFLICT` upsert; `UPDATE`/`DELETE ... WHERE`; `CREATE`/`DROP TABLE`; additive `ALTER TABLE … ADD COLUMN` (existing rows read the new column as `NULL` — and with a code-first schema, adding a plain column to `defineSchema` auto-migrates at connect).

Not supported: correlated subqueries, derived tables, window functions, `UNION`, `RIGHT`/`FULL`/`CROSS` joins, `DROP COLUMN`/`RENAME`, views, triggers. Every exclusion is rejected **by name, with an alternative**, and near-miss spellings are redirected (`CONCAT` → `||`, `SUBSTRING` → `SUBSTR`, `DATE_TRUNC` → `DATE`/`STRFTIME`).

`UPDATE`/`DELETE` without a `WHERE` clause requires an explicit `{ allowFullTable: true }` — the most common catastrophic agent mistake becomes a specific error instead.

## How it works

A miniaturization of the Delta Lake / Iceberg pattern, sized for object storage you already have:

- Rows live in **immutable chunk blobs**; a single small **manifest** names the current chunk set, the schema, and per-chunk min/max statistics.
- A commit stages new chunks (touching nothing live), then atomically swaps the manifest with a conditional write. Losers rebase if disjoint, re-execute if overlapping — **no lost updates, ever, or the commit fails loudly**. Writers inside one process coalesce into group commits, so same-instance concurrency never contends.
- Old manifests are complete snapshots, which is why time travel is nearly free.

The whole story in three pictures:

**The layers** — SQL goes in at the top; everything below is just files in your object store:

![How LarvaDB works — the layer cake: your app's SQL, LarvaDB the orchestrator, and the object store holding one mutable manifest plus immutable chunks](https://raw.githubusercontent.com/pango07/larva-db/main/docs/how-larva-db-works-1.png)

**Concurrency** — two writers race one compare-and-swap; the loser rebases or re-executes, and nothing is ever lost:

![How LarvaDB works — two writers, one manifest: the CAS race, the 412 loser, rebase vs re-execute recovery, and the zero-lost-updates guarantee](https://raw.githubusercontent.com/pango07/larva-db/main/docs/how-larva-db-works-2.png)

**Growing up** — one command out of Larva, one command into Postgres:

![How LarvaDB works — the escape hatch: export to a pg_dump-shaped .sql file and load it with psql](https://raw.githubusercontent.com/pango07/larva-db/main/docs/how-larva-db-works-3.png)

The full design — including the rejected alternative, the consistency model, and three empirically-discovered object-store behaviors the adapter must handle — is in [LARVA-DESIGN.md](https://github.com/pango07/larva-db/blob/main/LARVA-DESIGN.md).

## Tested where it matters

Correctness risk concentrates in the conflict/retry path, so that's where the tests concentrate — **275 checks across seven suites** run in CI on every push: a concurrent-writer stress gauntlet (zero lost updates, exact version arithmetic), randomized property workloads verified against a model, the full dialect + error catalog live against a real store, transaction/export/vacuum round-trips, and two offline chaos suites that inject 409s and 500s under the storage adapter. Details in [the repo README](https://github.com/pango07/larva-db#the-testing-story).

The stress and property harnesses ship in the package for testing your own setup:

```ts
import { runStress, runProperty } from "@larva-db/core/testing"; // unstable API, test code only
```

## Links

- [Repository](https://github.com/pango07/larva-db) — development, CI, and the browser test lab (SQL console + stress lab you can deploy)
- [Quickstart](https://github.com/pango07/larva-db/blob/main/LARVA-QUICKSTART.md)
- [Design of record](https://github.com/pango07/larva-db/blob/main/LARVA-DESIGN.md)
- [The agent prompt](https://github.com/pango07/larva-db/blob/main/docs/larva-for-agents.md)
- [Contributing](https://github.com/pango07/larva-db/blob/main/CONTRIBUTING.md)

## License

[MIT](https://github.com/pango07/larva-db/blob/main/LICENSE)
