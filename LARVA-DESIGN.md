# Larva — Design Document

**Package:** `larvadb` · **Status:** Draft v1 · **License:** Open source (TBD)

> Larva is a tiny SQL database that lives entirely inside your Vercel Blob store. You start small. When you outgrow it, you metamorphose — export to SQLite, Turso, or Postgres with one command. The name is the roadmap.

---

## 1. What Larva is

Larva is a TypeScript library that turns Vercel Blob (dumb object storage) into a small, durable, relational database with real SQL. There is no server, no marketplace signup, no connection string to a third party, and no new vendor. If your project is on Vercel, your database credential is the Blob token that Vercel already put in your environment. Install the package, define a schema, and query with SQL strings.

Larva is deliberately not a big database. It is designed for the enormous long tail of small applications: internal dashboards, team tools, hobby apps, prototypes, and agent-built software with a handful to a few thousand users. Within that envelope it promises something most "lightweight" solutions do not: no silently lost writes, atomic multi-statement transactions, point-in-time rollback, and a guaranteed exit path when you grow past it.

The one-line positioning: **grows to gigabytes of storage; outgrown at tens of writes per second or queries that must scan millions of rows.** Section 10 explains those ceilings precisely, because being honest about them is a feature.

## 2. Who it's for

The primary user is a non-engineer (or a very early-stage builder) creating small apps and dashboards with the help of an AI coding agent. This shapes the design in three specific ways.

First, the human does not write SQL — the agent does. Larva therefore supports real SQL query strings rather than a bespoke query-builder API, because SQL is the language every agent already speaks fluently. The supported dialect is a documented subset (Section 7) so an agent's system prompt can state exactly what is available, and the library returns precise, machine-readable errors when a query falls outside the subset so the agent can self-correct.

Second, the human cannot audit the SQL the agent writes. A destructive statement — a `DELETE` without a `WHERE`, a wrong `UPDATE` — will eventually happen and will not be caught by code review, because there is no code reviewer. Larva's answer is not to sandbox SQL (an agent can destroy data on any database, Postgres included) but to make destruction cheaply reversible: every commit produces a new immutable version, and rolling back to the state from ten minutes ago is a single operation (Section 9). This is a stronger safety story than most managed Postgres tiers offer at this price point, and it exists because of the architecture rather than in spite of it.

Third, ease of use is the top-ranked requirement, above performance and above feature count. The entire quickstart must fit on one screen. Zero configuration beyond what Vercel already provides. The API surface is intentionally small: connect, query, transact, export, rollback.

## 3. Why Larva exists — the landscape

Vercel does not offer a first-party Postgres. Postgres on Vercel means the marketplace (Neon, Supabase, Prisma Postgres), which means a second vendor relationship, a second dashboard, a second billing arrangement, and connection-pooling considerations that are alien to the target user.

The strongest existing alternative is Turso, which is in the Vercel marketplace and is genuinely close to Larva's shape: SQLite semantics, real SQL, an experimental package that replicates database pages into the serverless function for local reads. If you are an engineer comfortable with adding a database vendor, Turso is a fine choice and this document will not pretend otherwise. Larva's wedge against it is narrow but real: zero additional vendor (Blob is already in the account), radically simpler mental model (files in a bucket you can see and export), versioned time-travel as a first-class primitive rather than an enterprise feature, and full portability of the storage layer (Section 12). Turso Cloud is also a hosted service with its own pricing and account lifecycle; Larva is a library whose only dependency is object storage you already pay for.

The open-source Turso/libSQL engine embedded directly in a Vercel function does not solve the problem on its own, because Vercel functions have only ephemeral local disk: a SQLite file written to `/tmp` does not survive the invocation. Durable persistence for an embedded engine requires exactly the thing Larva builds — a Blob-backed storage layer. That observation is what makes this project non-redundant, and it framed the central architecture decision in Section 5.

**Why Vercel Edge Config was evaluated and rejected as a substrate.** Edge Config is a read-optimized configuration store: data is actively replicated to every edge region for near-zero-millisecond reads, which sounds attractive until you look at the write path. Writes are slow, globally propagated, and rate-limited; the store has a small total size cap; and Vercel positions it explicitly for feature flags, A/B tests, and redirects. It is deliberately write-hostile. A database's write path cannot be built on it. Edge Config may reappear in Larva's future as an optional read-accelerator for tiny, hot, rarely-written tables (feature-flag-shaped data), but it plays no role in v1. Vercel Blob is the sole substrate.

**What Vercel Blob provides**, verified against current documentation: S3-backed object storage with eleven-nines durability; private stores requiring authentication; a per-store region with a global CDN read cache; and — critically — **conditional writes**: `put()`, `copy()`, and `del()` accept an `ifMatch` ETag, and the operation fails with `BlobPreconditionFailedError` if the object changed since that ETag was issued. This compare-and-swap primitive is the only write-coordination tool Blob offers (there are no locks and no transactions), and it is the single load-bearing fact of Larva's design. Everything in Section 6 is built on it.

*Empirical addendum (verified against `@vercel/blob` 2.6.1, July 2026, via the concurrent-writer stress prototype in this repo). Two substrate behaviors the storage adapter must handle or the commit protocol fails in practice:*

1. **Weak ETags livelock the CAS.** Once a blob's GET response is large enough to be served compression-transformed (the manifest crosses this threshold after a handful of commits), `get()` returns a *weak* ETag (`W/"…"`). A weak ETag passed back as `ifMatch` never matches, so every writer 412s forever — the database wedges permanently while looking like ordinary contention. The opaque value is unchanged; the adapter must normalize to the strong form (strip the `W/` prefix) on every ETag it reads.
2. **Conflicts are not always 412s.** When two conditional operations race *in flight* on the same object, Blob rejects the loser with a `bad_request`-coded error — *"The conditional request cannot succeed due to a conflicting operation against this resource"* — which the SDK throws as a generic `BlobError`, not `BlobPreconditionFailedError`. Both mean the same thing (retry the CAS); the adapter must classify both as conflicts, matching the second by message substring since the SDK gives it no distinct type.

3. **Transient 5xx errors and ambiguous commit outcomes.** Under concurrent load, Blob occasionally answers reads with transient 500s — the adapter retries those (reads are idempotent). Writes cannot be blindly retried: a put that dies with a transient error *may have landed*, and the SDK's own internal retry of a landed conditional put comes back 412 — either way a writer can be told "failure" for a commit that succeeded, and naively retrying would apply it twice. The commit protocol therefore stamps every manifest with a unique `commitId`; after any failed or ambiguous CAS, the writer refetches and, if the live manifest carries its own commitId, knows it won. (This is the same commit-identity reconciliation Iceberg/Delta use for atomic commits on object stores.)

With all three handled, ten concurrent writers sustain roughly one commit per second system-wide with worst-case single-commit retry counts around ten — consistent with this document's stated envelope. Retry budgets must be more generous than a polite 5 (the original default, which measured contention showed losing ~17% of commits loudly at ten writers): the library default is 15, and the stress harness hammers with 50.

## 4. The two candidate architectures

Two fundamentally different designs can put a SQL database on top of Vercel Blob. Both were seriously considered; this section records both, per the project's founding discussion, along with the reasoning for the choice.

### Path A — Embed a real SQLite engine, snapshot the database file to Blob

In this design, Larva would be a thin wrapper around an existing embedded SQL engine (SQLite via WASM, or open-source libSQL). On a cold start, the function downloads the entire database file from Blob into memory or `/tmp` and opens it with the real engine. Queries run against the local copy with the full power of SQLite — every SQL feature, real indexes, a query planner with decades of tuning. On write, the function serializes the modified database file and uploads it back to Blob, using `ifMatch` against the ETag it downloaded so that a concurrent writer's changes are never silently overwritten.

The appeal is enormous: the entire SQL engine — parser, planner, executor, indexing, constraint enforcement — comes for free, battle-tested. Larva's own code would be perhaps a tenth the size.

The costs are structural. Persistence is whole-file: a one-row insert into a 200 MB database re-uploads 200 MB. Cold starts pay a full-file download before the first query. Concurrency is brutal: two functions each holding a copy of the file and CAS-ing it back means the loser must re-download the winner's file and replay its own changes against it — replaying arbitrary SQL against a changed database is not generally safe, so in practice the loser's transaction simply fails and retries from scratch, and under any sustained write concurrency the system thrashes. Time-travel requires storing full file copies per version, so history is expensive. And chunk-level query pruning is impossible: the unit of I/O is the whole database.

Path A is the right design for a strictly single-writer system with a small database — for example, a personal tool where one cron job writes and everything else reads. It was rejected as Larva's foundation because the project's hard requirements include safe concurrent writers and cheap versioned history, and Path A is structurally poor at both.

### Path B — A purpose-built query engine over Blob-native chunked storage (chosen)

In this design, Larva does not store "a database file." It stores a table as many small **immutable chunk blobs** plus one small mutable **manifest** blob that describes the current state of the whole database: the schema, every table's chunk list, and lightweight statistics per chunk. A write never modifies an existing chunk; it writes new chunks and then atomically swaps the manifest via compare-and-swap. A query reads the manifest, uses the statistics to skip irrelevant chunks, and fetches only the chunks it needs, in parallel.

The cost is that Larva must implement its own SQL layer — parser, planner, and executor — for a documented subset of SQL. That is real work, but bounded work: the v1 dialect (Section 7) is small, and the target scale (tens of thousands of rows per table, not tens of millions) means the executor can be simple in-memory relational algebra rather than a serious optimizer.

The benefits are exactly the project's requirements. A one-row insert writes one small chunk and one small manifest — I/O proportional to the change, not the database. Concurrent writers conflict only at the manifest swap, and the losing writer can often retry cheaply because chunks are shared. Old manifests are complete, consistent snapshots that cost almost nothing to retain, so time-travel and rollback are nearly free byproducts. And query pruning via chunk statistics gives most real queries I/O proportional to the data they actually touch.

This is not a novel architecture. It is a deliberate miniaturization of the pattern proven at massive scale by Delta Lake, Apache Iceberg, and Apache Hudi: immutable data files in object storage, a manifest describing table state, commits performed by atomic manifest replacement. Those systems have spent a decade solving the correctness problems this design inherits — atomic commits on object stores, snapshot isolation, conflict detection, orphan-file cleanup — and Larva borrows their published solutions rather than inventing its own. Larva's novelty is packaging, not physics: nobody has shipped this pattern as a two-minute drop-in for Vercel Blob aimed at agent-built applications.

**Decision: Path B.** The rest of this document specifies it.

## 5. Storage layout

A Larva database occupies a prefix inside a **private** Vercel Blob store (public stores are refused at connection time; see Section 11). The layout under that prefix:

```
larva/
  manifest.json                     ← the single mutable object; everything hangs off it
  tables/
    users/
      chunk_01H9XKQ2....json.gz     ← immutable, content-addressed chunk blobs
      chunk_01H9XKQ7....json.gz
    orders/
      chunk_01H9XKR1....json.gz
  history/
    manifest.v41.json               ← retained past manifests (time travel)
    manifest.v42.json
```

**Chunks** are the unit of storage and of I/O. A chunk holds a contiguous run of rows from one table — on the order of 1,000 to 5,000 rows or roughly 256 KB compressed, whichever comes first (tunable, not user-facing). Chunks are gzip-compressed JSON in v1 (transparent, debuggable, exportable by hand with `gunzip`; a columnar format is a possible v2 optimization). Chunk pathnames embed a ULID, so names never collide and never need coordination. A chunk, once written, is never modified — updates and deletes to rows in a chunk produce a replacement chunk and retire the old one from the manifest. The old blob stays on disk until vacuumed, which is what makes history free.

**The manifest** is a single JSON object, typically a few KB to a few hundred KB, containing: a format version; a monotonically increasing database version number; the full schema (tables, columns, types, primary keys, declared partition columns); and, per table, the ordered list of live chunks with per-chunk statistics — row count, min and max of the primary key, and min and max of the declared partition column. These min/max statistics are the *zone maps* that make query pruning work (Section 6). The manifest's Blob ETag is the concurrency token for the entire database.

Rows are JSON objects validated against the schema. v1 column types: `text`, `integer`, `real`, `boolean`, `timestamp` (ISO 8601 string), and `json` (schemaless escape valve per column). Every table has a required primary key; if the schema doesn't declare one, Larva adds an implicit ULID `id` column so that updates and deletes can always address rows.

## 6. The commit protocol and consistency model

This is the heart of the system, and the section any contributor must understand before touching write-path code.

### Reads: snapshot isolation for free

Every query — and every multi-statement transaction — begins by fetching the manifest once. Because chunks are immutable and the manifest names a specific set of them, that single manifest fetch pins a complete, internally consistent snapshot of the entire database. The query then reads only chunks named by that manifest. Concurrent commits landing mid-query are invisible: they produce a *new* manifest pointing at *new* chunks and never disturb the blobs the running query is reading. There are no torn reads, no locks, and no read-write blocking, ever. This is snapshot isolation, and it falls out of the architecture rather than being implemented.

Reads are eventually bounded by Blob's CDN cache behavior; a freshly fetched manifest is always fetched with cache-busting semantics from the origin so a writer sees its own committed writes on the next query from the same or any other function instance (read-your-writes at the database-version level).

### Writes: copy-on-write plus one compare-and-swap

A commit — whether a single `INSERT` or a ten-statement transaction — proceeds in three phases:

1. **Stage.** Read the manifest (version *v*, ETag *e*). Compute the change: which chunks gain rows, which chunks must be rewritten because rows in them were updated or deleted. Write all new chunk blobs. This phase touches nothing live; a crash here leaves only orphaned blobs, cleaned up later by vacuum. Data loss is impossible because nothing existing was modified.

2. **Commit.** Write the new manifest (version *v+1*, referencing the new chunk set) using `put(..., { ifMatch: e })`. This is the single atomic instant of the commit. If it succeeds, every subsequent reader anywhere sees the entire change or none of it — multi-table, multi-statement, all-or-nothing.

3. **Conflict.** If the CAS fails (`BlobPreconditionFailedError`), another writer committed first. Larva re-fetches the fresh manifest and checks whether the two commits touched overlapping data. If they are disjoint (the common case — different tables, or different chunks of the same table), Larva rebases automatically: it re-points its new manifest at the fresh state and retries the CAS, without redoing chunk writes. If they genuinely overlap at the row level, the transaction's statements are re-executed against the fresh snapshot and the commit is retried. Retries use jittered exponential backoff with a configurable cap (default: 15 attempts — measured at 40 ms-latency storage, a cap of 5 loses ~17% of commits loudly at ten mixed writers and a third of them on a hot counter, while 15 keeps loud failures out of ordinary contention), after which the commit fails loudly with a `ConflictError` — never silently.

### Group commit: writers inside one instance never contend

All commits serialize through one CAS, so the classic group-commit trick from write-ahead-logging databases applies directly: commits that arrive while another commit from the same `LarvaDb` instance is in flight are queued, and the whole queued batch lands as a *single* CAS. Each queued member is planned in order against a virtual manifest that includes the members before it (the same read-your-writes machinery transactions use), so a batch has transaction-like internal consistency — a second insert of an existing primary key fails at planning, and one member's error rejects that member alone without sinking its batchmates. A lone commit with an idle queue goes to storage immediately; group commit adds no latency when there is nothing to coalesce.

This matters more than it sounds on Vercel specifically: Fluid Compute serves many concurrent requests from one warm function instance, so concurrent end-users genuinely share a `LarvaDb` instance — and with group commit they stop fighting over the manifest entirely, contending only with *other* instances. Measured over 40 ms-latency storage with ten concurrent writers: ~1.6× sustained throughput, five times fewer storage writes, and worst-case (hot-counter) p95 commit latency collapsing from ~12 s of retry churn to ~1.3 s, with every correctness check intact. The batch path stages one chunk per member; merging a batch's inserts into shared chunks is a known follow-up optimization.

### The guarantee, stated honestly

Larva promises: **no silently lost writes, atomic and durable commits, snapshot-isolated reads.** It does not promise: high write throughput or low write-conflict rates under heavy concurrency. All commits serialize through one compare-and-swap on one object; sustained throughput is realistically single-digit commits per second, and heavily concurrent writers will spend time in retry loops. This trade was accepted explicitly at design time: for the target workload (small teams, dashboards, agent-built tools) it is invisible; for workloads where it is not invisible, Section 10 tells you to leave, and Section 12 gives you the door.

Cross-statement note: transactions provide atomicity and snapshot reads, and the overlap check at commit time rejects write-write conflicts. This is snapshot isolation, not full serializability — write skew between two transactions reading overlapping data and writing disjoint rows is theoretically possible, exactly as in Postgres's default `READ COMMITTED`/`REPEATABLE READ` modes. This is documented and considered acceptable for v1.

### Caching

Immutability makes caching trivial and safe. Warm function instances keep an in-memory LRU of decoded chunks keyed by chunk pathname; because a pathname is never reused with different content, a cache entry can never be stale. The manifest is the only object requiring freshness, and it is small. Blob's CDN independently caches chunk fetches across cold starts, and CDN hits are free of per-operation charges, so the architecture's read path is cheap as well as correct. Typical warm read: one small manifest round-trip plus zero or more cached chunk hits.

## 7. The SQL dialect

Larva accepts real SQL strings. The dialect is a deliberately small, fully documented subset — small enough that an agent's system prompt can enumerate it, and small enough that the parser can produce precise, correcting error messages ("subqueries are not supported in Larva v1; run the inner query first and interpolate its result") rather than generic syntax errors. Agents self-correct well when errors are specific; this is a design feature, not a limitation dressed up.

**Supported.** `SELECT` (optionally `DISTINCT`) with full scalar expressions in the select list — arithmetic, `||` concatenation, `CASE WHEN` (searched and simple forms), `CAST(x AS text/integer/real/boolean)`, and the closed scalar-function set `UPPER`, `LOWER`, `LENGTH`, `TRIM`, `ROUND`, `ABS`, `COALESCE`, `NULLIF`, `IFNULL`, `REPLACE`, `CEIL`, `FLOOR`, `MOD`, `SUBSTR`; date/time helpers `NOW()` / `CURRENT_TIMESTAMP`, `DATE(x)`, and `STRFTIME(fmt, x)` (`%Y %m %d %H %M %S`) — cheap by construction, because timestamps are ISO 8601 text, so `DATE(x)` is a prefix slice and range filters already compare lexicographically; JSON access over text columns with `JSON_EXTRACT(col, '$.a.b[0]')` and the `->>` operator (SQLite json1 semantics; `t.json()` remains reserved — agents store JSON via `t.text()` today, and this makes it queryable); `WHERE` (comparison operators, `AND`/`OR`/`NOT`, `IN`, `BETWEEN`, `LIKE`, `IS NULL`); `ORDER BY` (source columns or select-item aliases), `LIMIT`/`OFFSET`; `GROUP BY` over full expressions or select aliases (`GROUP BY DATE(createdAt)`, `GROUP BY month` — a bare name resolves to the real column first, then to an alias) with the aggregates `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `GROUP_CONCAT(x, sep)` — over arbitrary expressions, with `COUNT(DISTINCT col)` — and `HAVING`, which may reference aggregates or select aliases; and two-table `INNER JOIN` and `LEFT JOIN` on equality predicates. `INSERT` (single and multi-row) with upsert via `ON CONFLICT (col) DO NOTHING` / `DO UPDATE SET col = excluded.col` — the conflict target must be the primary key or a `UNIQUE` column, because those are the only places uniqueness is enforced. `UPDATE ... WHERE`, `DELETE ... WHERE`, `CREATE TABLE`, `DROP TABLE`. Parameterized queries via `?` placeholders and via tagged-template interpolation, which is the strongly documented default (Section 11).

One pruning note: a zone-map filter needs the raw column (`WHERE createdAt >= '2026-07-01'` prunes; `WHERE DATE(createdAt) >= '2026-07-01'` scans, then filters correctly). The error catalog also hints near-miss spellings toward the supported form (`CONCAT` → `||`, `SUBSTRING` → `SUBSTR`, `DATE_TRUNC` → `DATE`/`STRFTIME`).

The dialect started smaller (no `DISTINCT`, `HAVING`, scalar functions, select-list expressions, or upsert). The expansion criterion was empirical, and it is the bar for any future addition: **a construct joins the dialect when agents writing conservative SQL emit it routinely and it executes within the existing engine shape** — in-memory relational algebra after pruning, one manifest CAS per write. `HAVING` cost nothing once grouping already happened in memory; upsert reuses the copy-on-write chunk rewrite that `UPDATE` already needed. Constructs that would change the engine shape (subqueries, window functions) stay out regardless of demand.

**Explicitly not supported.** Subqueries, window functions, self-joins, joins of three or more tables, `ALTER TABLE`, views, triggers, `UNION`, nested aggregates, multi-column conflict targets, `WHERE` on `DO UPDATE`. Each exclusion is either rarely emitted by agents writing conservative SQL, expressible in application code at Larva's scale, or (in `ALTER TABLE`'s case) deferred to a v1.x schema-migration design that must interact carefully with time travel.

Execution is straightforward relational algebra: the planner extracts predicates on the primary key and partition column to prune chunks via the manifest's zone maps, fetches surviving chunks in parallel, and filters, joins, aggregates, and sorts in memory. At the target scale (a 30,000-row table is ten to thirty chunks, a couple of MB) this is sub-second even for a full-table scan; the planner's job is to make the common case touch far less than the full table.

## 8. Schema definition

Larva is code-first with a SQL door. The canonical schema is a TypeScript object checked into the repository:

```ts
import { defineSchema, t } from "larvadb";

export const schema = defineSchema({
  users: {
    id: t.text().primaryKey(),          // ULIDs by default
    email: t.text().unique(),
    name: t.text(),
    createdAt: t.timestamp().partitionBy(), // ← declares the pruning column
  },
  orders: {
    id: t.text().primaryKey(),
    userId: t.text().references("users.id"),
    total: t.real(),
    status: t.text(),
    createdAt: t.timestamp().partitionBy(),
  },
});
```

This choice is driven by the agent-first audience: a schema file in the repo is *in the agent's context window*, which means the agent writes correct SQL against real column names instead of hallucinating them, and typed row results flow through the application. `CREATE TABLE` / `DROP TABLE` statements are also accepted at runtime (agents doing interactive setup use this), and are reconciled into the manifest schema; when a code-first schema is present it is authoritative, and drift between code and manifest is surfaced as a clear startup error rather than silently ignored.

Each table is stored chunk-sorted by primary key. Declaring `partitionBy()` on one column (almost always a timestamp or a tenant/user id) additionally maintains zone-map statistics for that column, making range and equality filters on it prune aggressively. Queries filtering on any other column simply scan the table — acceptable at this scale by design, and the docs say so plainly. Secondary indexes (an index is just another blob committed in the same atomic manifest swap) are on the roadmap, not in v1.

## 9. Durability, time travel, and vacuum

Durability of committed bytes is delegated to Blob's S3 substrate (eleven nines). Larva's own contribution to durability is the commit protocol: a crash at any point before the manifest CAS leaves the database bit-for-bit untouched; a crash after leaves the commit complete. There is no in-between state.

Because every commit produces a new manifest and never destroys chunks, **every past version of the database continues to exist** until garbage-collected. Larva exposes this as a first-class feature rather than an implementation accident:

```ts
const past = await db.asOf(new Date(Date.now() - 10 * 60 * 1000)); // 10 min ago
await past.sql`SELECT * FROM users`;   // query the past, read-only
await db.rollbackTo(past.version);     // one CAS; current state becomes past state
```

`rollbackTo` is itself a commit (a new manifest version pointing at old chunks), so a rollback is non-destructive and can itself be rolled back. This is the project's answer to the agent-safety problem: when an agent-authored `DELETE` goes wrong, recovery is one line and ten seconds, which is a materially better story than "restore from last night's backup."

Retention defaults to **7 days of history or the last 50 versions, whichever is larger**, configurable. `db.vacuum()` deletes manifests outside the retention window and then deletes any chunk referenced by no retained manifest. Vacuum is safe to run concurrently with readers and writers: it only ever deletes objects no retained snapshot can name, and it runs manually or on a Vercel cron. Orphans from crashed commits (staged chunks whose commit never landed) are collected by the same sweep after a grace period.

## 10. The performance envelope — how you outgrow Larva

Storage is the one axis that never runs out: Blob will hold terabytes and the manifest scales to it. Users outgrow Larva on three other axes, and the documentation states them on the front page, because a tool for non-experts must do the expertise of knowing its own limits for them.

**Write throughput.** Every commit serializes through one compare-and-swap, each costing a few round-trips to Blob. Sustained throughput is single-digit commits per second, degrading under contention as concurrent writers retry. Five people editing a dashboard will never notice. Fifty writes per second will hit a wall that no configuration fixes — that workload needs a database with a real lock manager, and the export path exists for exactly this moment.

**Per-query scan volume — the subtle ceiling.** The database may be huge, but the function executing a query is small. Blob has no compute; every row a query examines crosses the network into a serverless function with bounded memory and a bounded execution time. A well-pruned query is fine at any total database size. A full scan on an unindexed, unpartitioned column scales linearly: sub-second at thirty thousand rows, and untenable at three million, where a single query would pull hundreds of megabytes into a lambda. Real databases move the query to the data; Larva moves the data to the query. That inversion is the fundamental trade, and it is why the honest ceiling is per-query touched data, not stored data.

**Latency floor and per-query cost.** A cold query pays a manifest fetch plus chunk fetches — tens to low hundreds of milliseconds. Warm-cache reads are fast but never sub-millisecond. Each cache-missing query is metered Blob operations and transfer; at high query volume, a flat-fee hosted database becomes cheaper than per-operation object storage. Larva is priced (by physics) for modest traffic.

The resulting front-page sentence: *Larva grows to gigabytes of storage; you have outgrown it at tens of writes per second, or when queries must scan millions of rows, or at sustained high query volume. When that day comes, run `larva export` and graduate.*

## 11. Security posture

**Private storage only.** Larva refuses to initialize against a public Blob store, because public blobs are readable by anyone holding the URL and blob URLs can leak and be indexed. All data blobs live in a private store; every read and write is authenticated with the store's token via the standard `@vercel/blob` SDK (OIDC or read-write token from the Vercel environment). Larva never generates public URLs for data blobs.

**The token is the perimeter.** Anyone with the Blob read-write token has full read-write on the database — Larva adds no user-level access control, and says so plainly. Row-level security, multi-tenant isolation within one database, and per-user permissions are application concerns (or reasons to graduate to Postgres). The threat model v1 defends: network attackers (everything is authenticated HTTPS), blob-URL leakage (private store), concurrent-writer corruption (commit protocol), and accidental destruction (time travel).

**SQL injection.** Agent-generated code interpolating user input into query strings is a certainty, so the primary API is a tagged template that makes parameterization the path of least resistance — `db.sql\`SELECT * FROM users WHERE email = ${email}\`` produces a parameterized query, never string concatenation. A raw-string API exists (`db.query(sqlString, params)`) and the documentation for it leads with placeholders. The parser additionally rejects multiple statements per string, closing the classic `'; DROP TABLE` stacking vector outside explicit transactions.

**Destructive SQL.** Larva deliberately does not restrict what SQL an authenticated caller may run — an agent can empty a table on any database, and pretending otherwise breeds false confidence. The mitigation is recoverability (Section 9), plus one guardrail cheap enough to justify itself: `UPDATE` and `DELETE` without a `WHERE` clause require an explicit `{ allowFullTable: true }` option, converting the most common catastrophic agent mistake into a specific error message the agent reads and reconsiders.

## 12. The escape hatch and portability

**Export is a v1 feature, not an afterthought.** A tool aimed at people who cannot rescue themselves must never trap them. `db.export()` (and `npx larva export`) produces, from a single manifest snapshot with zero locking — consistency is free because the snapshot is immutable:

- a genuine SQLite `.db` file, which makes graduation to Turso, Cloudflare D1, litestream, or plain SQLite a file-import rather than a migration project;
- per-table JSON and CSV, for spreadsheets and for Postgres `COPY`.

The documented graduation path is: export to SQLite, import into the destination, point the app's data layer at the new database. Because Larva speaks a subset of standard SQL, application queries move with minimal translation.

**Beyond Vercel.** Nothing in the architecture is Vercel-specific except roughly two hundred lines of storage adapter. The required storage contract is exactly four operations: get, put-with-CAS (ifMatch/precondition), delete, and list-by-prefix. Amazon S3 (conditional writes), Azure Blob Storage (If-Match), Google Cloud Storage (generation preconditions), and Cloudflare R2 all provide it. v1 ships the Vercel Blob adapter and defines the `StorageAdapter` interface publicly; community adapters make Larva "SQL over any blob store," which is the project's long-term ambition and the reason the name contains no vendor.

## 13. API surface (complete)

The entire v1 public API, which is also the ease-of-use contract — if this list grows past a screen, something has gone wrong:

```ts
import { larva, defineSchema, t } from "larvadb";

const db = larva({ schema });                    // token auto-discovered from Vercel env

await db.sql`SELECT * FROM users WHERE age > ${21}`;      // tagged template (primary)
await db.query("SELECT * FROM users WHERE age > ?", [21]); // raw string + params

await db.transaction(async (tx) => {                       // all-or-nothing, one CAS
  const [order] = await tx.sql`INSERT INTO orders (userId, total) VALUES (${uid}, ${total}) RETURNING *`;
  await tx.sql`UPDATE inventory SET count = count - 1 WHERE sku = ${sku}`;
});

const past = await db.asOf(timestamp);           // read-only snapshot of the past
await db.rollbackTo(version);                    // recovery in one line
await db.export({ format: "sqlite" });           // the escape hatch
await db.vacuum();                               // reclaim storage outside retention
```

## 14. Roadmap and open questions

v1 ships: the storage engine and commit protocol, the SQL subset of Section 7, code-first schema, transactions, time travel and rollback, vacuum, export to SQLite/JSON/CSV, the Vercel Blob adapter, and the two documents (this spec and the quickstart). Deferred, in rough priority order: secondary index blobs; `ALTER TABLE` with a migration story that respects time travel; a columnar chunk format; S3/R2/GCS/Azure adapters; a tiny read-only web UI for browsing tables (non-engineers love to *see* their data); an optional Edge Config read-accelerator for flag-shaped tables.

Open questions for contributors: whether the SQL parser is written by hand or adapted from an existing JS SQL parser (leaning hand-written Pratt parser for error-message quality over the small dialect — and indeed it is hand-written); exact chunk-size tuning under real Blob latency; whether `RETURNING` stays in v1 (currently yes — agents rely on it heavily); and merging a group-commit batch's inserts into shared chunks (the batch path currently stages one chunk per member). The CI question is settled: the conflict/retry matrix runs offline on every push — the stress and property harnesses (`packages/larvadb/src/testing/`) execute over an in-process fake S3 with injected 409/500 chaos (`scripts/s3-adapter-test.ts`, `scripts/group-commit-test.ts`), and additionally against a live Blob store when the CI secret is configured.

## 15. Prior art and acknowledgments

Larva's storage design is a miniaturization of Delta Lake, Apache Iceberg, and Apache Hudi (immutable files + manifest + atomic swap), and its versioning model echoes Dolt and Fossil. The whole-file alternative (Path A) is essentially Litestream's problem domain approached from the opposite direction. Turso/libSQL defined the "SQLite for the serverless era" category Larva lives next to. Standing on these shoulders is the reason a small library can honestly promise big-database correctness properties.
