@AGENTS.md

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

This repo contains **Larva** (`larvadb`) — a TypeScript library that turns Vercel Blob into a small, durable SQL database — plus a Next.js 16 starter with a test dashboard used to prototype it. `LARVA-DESIGN.md` is the authoritative spec (Draft v1) and `LARVA-QUICKSTART.md` is the user-facing quickstart. Read `LARVA-DESIGN.md` before making any design or implementation decision; it records not just the chosen design but the rejected alternatives and why. The commit protocol (Design §6) is implemented and validated under concurrency (stress + property tests in `lib/larva/`); the SQL layer (schema API, §7-dialect parser, pruning executor, `larva()` public API in `lib/larva/sql/` and `lib/larva/db.ts`) sits on top of it. §3 of the design doc records three empirically-discovered Blob substrate behaviors the storage adapter must handle — read that before touching `storage.ts`.

## Commands

- `bun install` — bun is the package manager (workspace root; the library lives in `packages/larvadb`, imported as `larvadb` via tsconfig paths)
- `bun run lint` — eslint
- `bunx tsc --noEmit` — typecheck (includes `scripts/type-tests.ts`, the compile-only inference tests)
- `bun scripts/stress.ts` — commit-protocol stress test against the real Blob store (requires `BLOB_READ_WRITE_TOKEN` in `.env.local`; pull with `vercel env pull .env.local`)
- `bun scripts/property.ts` — property-based random-workload conflict test (same token requirement)
- `bun scripts/sql-smoke.ts` — full v1 dialect walkthrough (parser error catalog offline, then live queries, pruning, time travel)
- `bun scripts/api-smoke.ts` — transaction atomicity + concurrent re-execution, export (json/csv/sqlite), vacuum retention
- `bun scripts/s3-adapter-test.ts` — S3Adapter contract + stress harness over an in-process fake S3 with 409/500 chaos injection (no credentials needed)
- `bun run --cwd packages/larvadb build` — build the npm package (bundle + d.ts); `npm pack --dry-run` there to inspect the tarball. Do not `npm publish` without the user's explicit go-ahead.
- Deploy: `vercel deploy --prod --yes` (project `attentive/larva-db`, direct upload; GitHub repo is `pango07/larva-db` but is not connected to Vercel)

## Architecture (Path B — chunked storage, chosen over embedded SQLite)

Larva is a deliberate miniaturization of the Delta Lake / Iceberg pattern on top of Vercel Blob:

- **Immutable chunk blobs** hold rows (~1,000–5,000 rows or ~256 KB gzipped JSON each, ULID-named, content never modified). Updates/deletes produce replacement chunks; old ones stay until vacuum.
- **One mutable `manifest.json`** describes the entire database: schema, per-table ordered chunk lists, and per-chunk zone-map statistics (row count, min/max of primary key and partition column). The manifest's Blob ETag is the concurrency token for the whole database.
- **Commit protocol** (Design §6 — the heart of the system; understand it before touching write-path code): stage new chunks (touches nothing live) → CAS-swap the manifest via `put(..., { ifMatch: etag })` → on `BlobPreconditionFailedError`, rebase if disjoint, re-execute if overlapping, jittered backoff up to 5 attempts, then throw `ConflictError` loudly.
- **Snapshot isolation falls out of the architecture**: one manifest fetch pins a consistent snapshot; concurrent commits are invisible to running queries. Not full serializability — write skew is accepted and documented for v1.
- **Time travel is a byproduct**: old manifests in `history/` are complete snapshots. `rollbackTo` is itself a new commit (non-destructive, itself rollbackable). Retention: 7 days or 50 versions, whichever is larger.
- **Caching**: chunks are immutable so cache entries keyed by pathname can never be stale; only the manifest needs freshness (always fetched with cache-busting).

## Hard invariants — do not violate

- A chunk blob, once written, is never modified. All mutation is copy-on-write plus one manifest CAS.
- No silently lost writes, ever. Conflicts fail loudly after retries.
- Private Blob stores only; refuse public stores at connect time. Larva never generates public URLs for data blobs.
- The SQL dialect is a closed, documented subset (Design §7). Precise, machine-readable error messages for unsupported SQL are a design feature — agents self-correct from specific errors. Do not quietly accept SQL outside the subset.
- `UPDATE`/`DELETE` without `WHERE` requires explicit `{ allowFullTable: true }`.
- The parser rejects multiple statements per string (injection stacking vector).
- The v1 public API surface (Design §13) must fit on one screen: `larva()`, `db.sql` tagged template (primary API), `db.query(str, params)`, `db.transaction`, `db.asOf`, `db.rollbackTo`, `db.export`, `db.vacuum`. Resist growing it.
- Export (SQLite/JSON/CSV) is a v1 feature, not an afterthought — the escape hatch is part of the product promise.
- Only Vercel-specific code should be the storage adapter; the `StorageAdapter` contract is exactly four operations: get, put-with-CAS, delete, list-by-prefix.

## Design constraints that shape implementation

- **Audience**: non-engineers building with AI agents. Ease of use outranks performance and features. Agents write the SQL, so error-message quality is a first-class concern (hence the lean toward a hand-written Pratt parser).
- **Performance envelope is stated honestly, on purpose**: single-digit commits/sec (all commits serialize through one CAS), per-query cost proportional to chunks touched, pruning only on primary key and the one `partitionBy()` column. Don't add complexity to push past these ceilings — the answer to outgrowing Larva is `larva export`.
- **Explicitly not in v1**: subqueries, `HAVING`, window functions, `UNION`, self-joins, 3+ table joins, `ALTER TABLE`, views, triggers, secondary indexes. Each exclusion is deliberate (Design §7, §14).
- **Correctness risk concentrates in the conflict/retry matrix**; the plan is property-based testing (concurrent random writers, assert no lost updates).

Keep `LARVA-DESIGN.md` in sync with any design decisions made during implementation — it is the spec of record, and §14 lists the open questions (parser approach, chunk sizing, `RETURNING`, CI strategy for conflict testing).


