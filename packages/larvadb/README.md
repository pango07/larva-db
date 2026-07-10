<p align="center">
  <img src="https://raw.githubusercontent.com/pango07/larva-db/main/docs/larvadb.png" alt="larvadb" width="340">
</p>

**A tiny SQL database that lives inside your Vercel Blob store.** No signup, no new vendor, no server, no connection string. When your app grows up, export to a bigger database with one command — that's why it's called Larva.

[![CI](https://github.com/pango07/larva-db/actions/workflows/ci.yml/badge.svg)](https://github.com/pango07/larva-db/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40larva-db%2Fcore)](https://www.npmjs.com/package/@larva-db/core)
[![types](https://img.shields.io/badge/types-included-blue)](https://github.com/pango07/larva-db/blob/main/packages/larvadb/src/index.ts)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/pango07/larva-db/blob/main/LICENSE)

Real SQL (time series, upserts, JSON), atomic transactions, time travel, and a guaranteed exit path to SQLite *or* Postgres.

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

Real SQL — the dialect covers ~90% of the queries small apps actually write, and every line below is the whole program (each one verified against a live store):

```ts
// the everyday stuff
await db.sql`INSERT INTO customers (name, email) VALUES (${"Ada"}, ${"ada@example.com"}) RETURNING *`;
await db.sql`SELECT name, email FROM customers WHERE createdAt >= ${"2026-06-01"} ORDER BY name LIMIT 10`;

// dashboards: dates, grouping, joins
await db.sql`SELECT DATE(createdAt) AS day, SUM(total) AS revenue FROM orders GROUP BY day ORDER BY day`;
await db.sql`SELECT customers.name, SUM(orders.total) AS spent FROM orders
  INNER JOIN customers ON orders.customerId = customers.id
  GROUP BY customers.name HAVING spent > ${100}`;

// upserts and JSON
await db.sql`INSERT INTO counters (slug, count) VALUES (${"visits"}, ${1})
  ON CONFLICT (slug) DO UPDATE SET count = count + ${1}`;
await db.sql`SELECT JSON_EXTRACT(payload, ${"$.user.name"}) AS who FROM events`;
```

`CASE WHEN`, `CAST`, `DISTINCT`, `BETWEEN`, `LIKE`, scalar functions, `STRFTIME` buckets — [the full dialect](#sql-dialect) is below, and everything outside it is rejected by name with what to do instead.

### Transactions, time travel, auto-numbering

```ts
await db.transaction(async (tx) => {          // several statements, one atomic commit
  await tx.sql`INSERT INTO orders (customerId, total) VALUES (${id}, ${99.5})`;
  await tx.sql`UPDATE inventory SET count = count - 1 WHERE sku = ${"widget"}`;
});

const past = await db.asOf(new Date(Date.now() - 600_000));
await db.rollbackTo(past.version);            // the undo button: 10 minutes ago, restored

await db.sql`INSERT INTO invoices (customer) VALUES (${"ada"}) RETURNING number`;
// → [{ number: 42 }] — t.sequence() columns auto-number, unique across concurrent writers
```

### The escape hatch

```ts
await db.export({ format: "postgres" });      // pg_dump-shaped .sql → psql $DATABASE_URL < export.sql
await db.export({ format: "sqlite" });        // a genuine .db file → Turso, D1, anywhere
```

Your data is never trapped — that's a promise, not a feature. CSV and JSON too, and `db.vacuum()` reclaims storage outside retention.

### The CLI

The whole API is also a shell command — `npx larva` works wherever `@larva-db/core` is installed:

```bash
npx larva sql "SELECT name, email FROM customers LIMIT 5"
npx larva export --format postgres --out export.sql
npx larva rollback 41
```

Credentials auto-load from `.env.local`. Full reference — every command, flag, and troubleshooting — in [docs/cli.md](https://github.com/pango07/larva-db/blob/main/docs/cli.md).

### And the rest, in one breath

```ts
const rows = await db.sql<InferRow<typeof schema, "customers">>`SELECT * FROM customers`; // typed rows
defineSchema(spec, { uniques: { grants: [["userId", "feature"]] } }); // composite uniques (upsert-targetable)
larva({ schema, store: new S3Adapter({ bucket, accessKeyId, secretAccessKey }) }); // AWS S3 / R2, same database
await db.upgrade(); // format 3, the ordered commit log — cheaper conflicts as you grow
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
UNSUPPORTED_FEATURE: subqueries are not supported in Larva v1 (found one in IN);
run the inner query first and interpolate its result
```

## Who it's for — and honest limits

Larva is for the enormous long tail of **small applications**: dashboards, internal tools, hobby apps, prototypes, and anything an AI agent is building for you. Within that envelope it promises what most "lightweight" solutions don't: **no silently lost writes, atomic multi-statement transactions, snapshot-isolated reads, and point-in-time rollback.**

The limits, stated plainly (they're physics, not configuration):

- **Storage** grows to gigabytes — that axis never runs out.
- **Writes**: every commit serializes through one compare-and-swap. Sustained throughput is roughly one commit per second (concurrent writers in the same process coalesce into shared commits); five people editing a dashboard will never notice, fifty writes per second will hit a wall.
- **Reads**: queries pull data to the compute. Filters on the primary key or the `.partitionBy()` column prune aggressively; anything else scans the table — fine at tens of thousands of rows, untenable at millions.

When you get there, congratulations: run the export and graduate — `psql $DATABASE_URL < export.sql` and you're on Postgres.

## SQL dialect

Real SQL strings, deliberately scoped: `SELECT` (with `DISTINCT`) over full expressions — arithmetic, `||` concatenation, `CASE WHEN`, `CAST`, scalar functions (`UPPER`, `LOWER`, `LENGTH`, `TRIM`, `ROUND`, `ABS`, `COALESCE`, `NULLIF`, `IFNULL`, `REPLACE`, `CEIL`, `FLOOR`, `MOD`, `SUBSTR`), date helpers (`NOW()`/`CURRENT_TIMESTAMP`, `DATE(x)`, `STRFTIME('%Y-%m', x)` — timestamps are ISO text, so this is cheap and range filters stay prunable), and JSON over text columns (`JSON_EXTRACT(col, '$.a[0]')`, `->>`); `WHERE` (`=`, `!=`, `<`, `>`, `<=`, `>=`, `AND`, `OR`, `NOT`, `IN`, `BETWEEN`, `LIKE`, `IS NULL`), `ORDER BY`, `LIMIT`/`OFFSET`, `GROUP BY` over expressions or aliases (`GROUP BY DATE(createdAt)`) with `COUNT`/`SUM`/`AVG`/`MIN`/`MAX`/`GROUP_CONCAT` (incl. `COUNT(DISTINCT …)`) and `HAVING`, two-table `INNER`/`LEFT JOIN`; `INSERT` (multi-row, `RETURNING`) with `ON CONFLICT` upsert; `UPDATE`/`DELETE ... WHERE`; `CREATE`/`DROP TABLE`.

Not supported: subqueries, window functions, `UNION`, self-joins, 3+ table joins, `ALTER TABLE`, views, triggers. Every exclusion is rejected **by name, with an alternative**, and near-miss spellings are redirected (`CONCAT` → `||`, `SUBSTRING` → `SUBSTR`, `DATE_TRUNC` → `DATE`/`STRFTIME`).

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

Correctness risk concentrates in the conflict/retry path, so that's where the tests concentrate — **213 checks across seven suites** run in CI on every push: a concurrent-writer stress gauntlet (zero lost updates, exact version arithmetic), randomized property workloads verified against a model, the full dialect + error catalog live against a real store, transaction/export/vacuum round-trips, and two offline chaos suites that inject 409s and 500s under the storage adapter. Details in [the repo README](https://github.com/pango07/larva-db#the-testing-story).

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
