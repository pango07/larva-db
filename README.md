# larva-db

Prototype repo for **Larva** (`larvadb`) — a tiny SQL database that lives inside Vercel Blob. See [`LARVA-DESIGN.md`](./LARVA-DESIGN.md) for the full design and [`LARVA-QUICKSTART.md`](./LARVA-QUICKSTART.md) for the product vision.

## What's here now

The highest-risk piece was prototyped first, in isolation: the **commit protocol** (Design §6) — copy-on-write chunks plus one compare-and-swap on the manifest, with rebase/re-execute conflict handling — validated by adversarial stress tests and property-based random workloads against a real Blob store. On top of it sits the **SQL layer** (code-first schema API, hand-written parser for the full §7 dialect with machine-readable errors, executor with zone-map chunk pruning) and the complete **§13 API surface**: `db.sql`, `db.query`, `db.transaction` (multi-statement, one CAS, read-your-writes), `asOf`/`rollbackTo` time travel, `db.export` (JSON/CSV/SQLite), and `db.vacuum` (retention + orphan sweep).

```ts
import { defineSchema, larva, t } from "./lib/larva";

const db = larva({ schema });
await db.sql`INSERT INTO customers (name, email) VALUES (${"Ada"}, ${"ada@example.com"}) RETURNING *`;
await db.sql`SELECT customers.name, SUM(orders.total) AS revenue
             FROM orders INNER JOIN customers ON orders.customerId = customers.id
             GROUP BY customers.name ORDER BY revenue DESC LIMIT 10`;
const past = await db.asOf(new Date(Date.now() - 600_000));
await db.rollbackTo(past.version);

await db.transaction(async (tx) => {
  const [order] = await tx.sql`INSERT INTO orders (customerId, total) VALUES (${uid}, ${total}) RETURNING *`;
  await tx.sql`UPDATE inventory SET count = count - 1 WHERE sku = ${sku}`;
});
await db.export({ format: "sqlite" }); // the escape hatch
await db.vacuum();                     // reclaim storage outside retention
```

- `packages/larvadb/` — **the `larvadb` npm package** (bun workspace; builds to a 35 kB tarball with full type declarations)
  - `src/storage.ts` — the four-operation `StorageAdapter` contract + Vercel Blob implementation (`ifMatch` CAS, conflict classification, weak-ETag normalization, transient-error retry)
  - `src/adapters/s3.ts` — `S3Adapter` for AWS S3 / Cloudflare R2: zero-dependency SigV4 signing, conditional writes (`If-Match` / `If-None-Match: *`), 412/409 conflict mapping
  - `src/core.ts` — manifest with zone-map chunk statistics, immutable chunks, the stage → CAS → rebase/re-execute/backoff commit loop with ambiguous-outcome reconciliation via `commitId`, row-level mutation by chunk replacement
  - `src/schema.ts` — `defineSchema` / `t` code-first schema with **typed row inference** (`InferRow<typeof schema, "customers">`), validation, drift detection
  - `src/sql/` — lexer, hand-written parser for the v1 dialect (every exclusion rejected by name with an alternative), executor with zone-map pruning
  - `src/db.ts` — the §13 public API: `larva()`, `db.sql`, `db.query`, `db.transaction`, `asOf`, `rollbackTo`, `export`, `vacuum`
  - `src/testing/` — stress + property harnesses, published as `larvadb/testing`
- `scripts/` — CLI runners: `stress`, `property`, `sql-smoke`, `api-smoke`, `s3-adapter-test` (fake S3 with chaos injection), `type-tests` (compile-only)
- `app/` — Next.js 16 test dashboard: SQL console over a seeded demo database (with JSON/CSV export) + the commit-protocol stress lab

## Running

```bash
bun install
vercel env pull .env.local        # needs the linked private Blob store
bun scripts/stress.ts --writers 10 --commits 20 --mode mixed
bun scripts/property.ts --writers 8 --ops 25
```

Modes: `append` (disjoint writes → rebase path), `counter` (every write overlaps → re-execution path), `mixed` (both). Each run creates a throwaway database under `stress/<runId>/` in the Blob store and cleans up on pass; failed runs keep their blobs for inspection.

The dashboard (`bun run dev`, or the deployed URL) runs the same harness from a Vercel function.
