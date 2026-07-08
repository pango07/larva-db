# 🐛 larvadb

**A tiny SQL database that lives inside your Vercel Blob store.** No signup, no new vendor, no server, no connection string. When your app grows up, export to a bigger database with one command — that's why it's called Larva.

[![CI](https://github.com/pango07/larva-db/actions/workflows/ci.yml/badge.svg)](https://github.com/pango07/larva-db/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/larvadb)](https://www.npmjs.com/package/larvadb)
[![test checks](https://img.shields.io/badge/test_checks-95_passing-brightgreen)](#the-testing-story)
[![types](https://img.shields.io/badge/types-included-blue)](packages/larvadb/src/index.ts)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

```ts
import { defineSchema, larva, t } from "larvadb";

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

That's the whole setup. Real SQL from there:

```ts
// ${...} values are parameterized automatically — never string-concatenated
await db.sql`INSERT INTO customers (name, email, createdAt)
             VALUES (${"Ada"}, ${"ada@example.com"}, ${"2026-06-01T00:00:00Z"})
             RETURNING *`;

await db.sql`SELECT customers.name, SUM(orders.total) AS revenue
             FROM orders
             INNER JOIN customers ON orders.customerId = customers.id
             WHERE orders.createdAt > ${"2026-06-01"}
             GROUP BY customers.name
             ORDER BY revenue DESC
             LIMIT 10`;

// several statements, one atomic commit
await db.transaction(async (tx) => {
  const [order] = await tx.sql`INSERT INTO orders (customerId, total)
                               VALUES (${id}, ${99.5}) RETURNING *`;
  await tx.sql`UPDATE inventory SET count = count - 1 WHERE sku = ${sku}`;
});
```

### The undo button

Every commit is a new immutable version. When something goes wrong — say an AI agent deleted the wrong rows — recovery is one line:

```ts
const past = await db.asOf(new Date(Date.now() - 10 * 60 * 1000)); // 10 min ago
await past.sql`SELECT COUNT(*) FROM customers`;  // peek at the past, read-only
await db.rollbackTo(past.version);               // restore it (itself undoable)
```

### The escape hatch

Your data is never trapped. That's a promise, not a feature:

```ts
await db.export({ format: "sqlite" }); // a genuine .db file → Turso, D1, anywhere
await db.export({ format: "csv" });    // spreadsheets, Postgres COPY
await db.vacuum();                     // reclaim storage outside retention
```

### Typed rows

```ts
import type { InferRow } from "larvadb";

type Customer = InferRow<typeof schema, "customers">;
// { id: string; name: string | null; email: string | null; createdAt: string | null }

const rows = await db.sql<Customer>`SELECT * FROM customers`;
```

### Any S3-compatible store

Vercel Blob is the default, but the storage contract is four operations, so the same database runs on AWS S3 or Cloudflare R2 — zero extra dependencies:

```ts
import { larva, S3Adapter } from "larvadb";

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

## Who it's for — and honest limits

Larva is for the enormous long tail of **small applications**: dashboards, internal tools, hobby apps, prototypes, and anything an AI agent is building for you. Within that envelope it promises what most "lightweight" solutions don't: **no silently lost writes, atomic multi-statement transactions, snapshot-isolated reads, and point-in-time rollback.**

The limits, stated plainly (they're physics, not configuration):

- **Storage** grows to gigabytes — that axis never runs out.
- **Writes**: every commit serializes through one compare-and-swap. Sustained throughput is roughly one commit per second; five people editing a dashboard will never notice, fifty writes per second will hit a wall.
- **Reads**: queries pull data to the compute. Filters on the primary key or the `.partitionBy()` column prune aggressively; anything else scans the table — fine at tens of thousands of rows, untenable at millions.

When you get there, congratulations: run the export and graduate.

## SQL dialect

Real SQL strings, deliberately scoped: `SELECT` with `WHERE` (`=`, `!=`, `<`, `>`, `<=`, `>=`, `AND`, `OR`, `NOT`, `IN`, `BETWEEN`, `LIKE`, `IS NULL`), `ORDER BY`, `LIMIT`/`OFFSET`, `GROUP BY` with `COUNT`/`SUM`/`AVG`/`MIN`/`MAX`, two-table `INNER`/`LEFT JOIN`, basic arithmetic; `INSERT` (multi-row, `RETURNING`), `UPDATE`/`DELETE ... WHERE`, `CREATE`/`DROP TABLE`.

Not in v1: subqueries, `HAVING`, window functions, `UNION`, self-joins, 3+ table joins, `ALTER TABLE`, views, triggers. Every exclusion is rejected **by name, with an alternative** — because agents self-correct from specific errors:

```
UNSUPPORTED_FEATURE: HAVING is not supported in Larva v1; filter the grouped
results in application code, or restructure with WHERE before grouping
```

`UPDATE`/`DELETE` without a `WHERE` clause requires an explicit `{ allowFullTable: true }` — the most common catastrophic agent mistake becomes a specific error instead.

## How it works

A miniaturization of the Delta Lake / Iceberg pattern, sized for object storage you already have:

- Rows live in **immutable chunk blobs**; a single small **manifest** names the current chunk set, the schema, and per-chunk min/max statistics.
- A commit stages new chunks (touching nothing live), then atomically swaps the manifest with a conditional write. Losers rebase if disjoint, re-execute if overlapping — **no lost updates, ever, or the commit fails loudly**.
- Old manifests are complete snapshots, which is why time travel is nearly free.

The full design — including the rejected alternative, the consistency model, and three empirically-discovered object-store behaviors the adapter must handle — is in [LARVA-DESIGN.md](LARVA-DESIGN.md).

## The testing story

Correctness risk concentrates in the conflict/retry path, so that's where the tests concentrate — **95 checks across five suites**, all run in CI on every push:

| Suite | What it proves |
|---|---|
| `scripts/stress.ts` | 10 concurrent writers, 200 commits against a real store: zero lost updates, zero duplicates, exact version arithmetic |
| `scripts/property.ts` | randomized insert/update/delete workloads verified against a per-writer sequential model, tolerant of ambiguous commit outcomes |
| `scripts/sql-smoke.ts` | the full dialect + the machine-readable error catalog + pruning + time travel, live |
| `scripts/api-smoke.ts` | transaction atomicity, concurrent read-modify-write transactions, export round-trip through a real SQLite engine, vacuum retention |
| `scripts/s3-adapter-test.ts` | the S3 adapter under an in-process fake S3 with injected 409s and 500s — chaos the engine must absorb |

CI publishes to npm on every `main` push: a new `package.json` version ships as `latest`; every other commit ships a unique `canary`.

## Try it in a browser

The repo doubles as a test lab — a Next.js dashboard with a SQL console over a seeded demo database (with JSON/CSV export) and a commit-protocol stress lab. Deploy it to your own Vercel account:

```bash
git clone https://github.com/pango07/larva-db && cd larva-db
bun install
vercel link && vercel blob store add my-larva-store --access private --yes
bun run dev
```

## Contributing

Contributions are welcome — this is early, and the honest-limits philosophy applies to the code too.

**Setup**

```bash
bun install
vercel env pull .env.local   # a private Vercel Blob store token, for the live suites
```

**Before you open a PR**

```bash
bunx tsc --noEmit            # includes compile-only type-inference tests
bun run lint
bun scripts/s3-adapter-test.ts   # offline, no credentials needed
bun scripts/sql-smoke.ts         # these three need BLOB_READ_WRITE_TOKEN
bun scripts/api-smoke.ts
bun scripts/stress.ts --writers 4 --commits 6
```

CI runs all of it on every PR; green CI is the bar.

**Ground rules**

- Read [LARVA-DESIGN.md](LARVA-DESIGN.md) §6 before touching anything in the write path — the commit protocol is the heart of the system, and the stress/property suites are the referee.
- Chunks are immutable, conflicts fail loudly, and the public API stays small enough to fit on one screen. PRs that grow the API surface need a design-doc update in the same PR.
- New SQL features need three things: parser + executor + a named, helpful rejection message for whatever adjacent thing is still unsupported.
- Keep `LARVA-DESIGN.md` in sync — it's the spec of record, and it documents *why*, not just *what*.

**Good first issues**: additional storage adapters (Azure Blob, GCS — the contract is four operations, ~200 lines), columnar chunk format, secondary index blobs, `ALTER TABLE` with a time-travel-safe migration story.

## License

[MIT](LICENSE)
