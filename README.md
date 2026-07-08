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

- `lib/larva/storage.ts` — the four-operation `StorageAdapter` contract + Vercel Blob implementation (`ifMatch` CAS, conflict classification, weak-ETag normalization, transient-error retry)
- `lib/larva/core.ts` — manifest with zone-map chunk statistics, immutable chunks, the stage → CAS → rebase/re-execute/backoff commit loop with ambiguous-outcome reconciliation via `commitId`, and row-level insert/update/delete by chunk replacement
- `lib/larva/schema.ts` — `defineSchema` / `t` code-first schema, validation, drift detection
- `lib/larva/sql/` — lexer, hand-written parser for the v1 dialect (every exclusion rejected by name with an alternative), executor with zone-map pruning
- `lib/larva/db.ts` — the public API: `larva()`, `db.sql` tagged template, `db.query`, `db.transaction`, `asOf`, `rollbackTo`, `export`, `vacuum`
- `lib/larva/stress.ts` / `lib/larva/property.ts` — concurrent-writer stress harness and property-based random-workload test (Design §14)
- `scripts/stress.ts`, `scripts/property.ts`, `scripts/sql-smoke.ts`, `scripts/api-smoke.ts` — CLI runners
- `app/` — Next.js 16 test dashboard ("stress lab") to run and visualize stress tests

## Running

```bash
bun install
vercel env pull .env.local        # needs the linked private Blob store
bun scripts/stress.ts --writers 10 --commits 20 --mode mixed
bun scripts/property.ts --writers 8 --ops 25
```

Modes: `append` (disjoint writes → rebase path), `counter` (every write overlaps → re-execution path), `mixed` (both). Each run creates a throwaway database under `stress/<runId>/` in the Blob store and cleans up on pass; failed runs keep their blobs for inspection.

The dashboard (`bun run dev`, or the deployed URL) runs the same harness from a Vercel function.
