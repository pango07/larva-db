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

A Larva database occupies a prefix inside a Vercel Blob store, and every blob is **private by construction** — the adapter writes `access: "private"` on every put, so data can never be publicly readable regardless of the store's default (see Section 11). The layout under that prefix:

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
  log/                              ← format 3 only: the ordered commit log
    000000000043.json               ← one immutable delta per commit; slot number = version
  sequences.json                    ← format 2+: CAS-claimed sequence ranges (off the hot path)
  queue/                            ← format 4 only: per-writer intent queues (Section 6)
    01J2WRITER.../intent-000007.json  ← create-only; one PUT = durable
  lease.json                        ← format 4 only: the compactor/leader lease (performance, never correctness)
```

**Chunks** are the unit of storage and of I/O. A chunk holds a contiguous run of rows from one table — on the order of 1,000 to 5,000 rows or roughly 256 KB compressed, whichever comes first (tunable, not user-facing). Chunks are gzip-compressed JSON in v1 (transparent, debuggable, exportable by hand with `gunzip`; a columnar format is a possible v2 optimization). Chunk pathnames embed a ULID, so names never collide and never need coordination. A chunk, once written, is never modified — updates and deletes to rows in a chunk produce a replacement chunk and retire the old one from the manifest. The old blob stays on disk until vacuumed, which is what makes history free.

**The manifest** is a single JSON object, typically a few KB to a few hundred KB, containing: a format version; a monotonically increasing database version number; the full schema (tables, columns, types, primary keys, declared partition columns); and, per table, the ordered list of live chunks with per-chunk statistics — row count, min and max of the primary key, and min and max of the declared partition column. These min/max statistics are the *zone maps* that make query pruning work (Section 6). The manifest's Blob ETag is the concurrency token for the entire database.

**Format versioning.** The manifest's `formatVersion` is the on-store protocol contract, checked strictly on every manifest read (current and history): a client that encounters a version newer than it supports refuses with a machine-readable `FormatError` (`FORMAT_UNSUPPORTED: … upgrade with npm install @larva-db/core@latest`) and touches nothing. The check exists because a store is shared mutable state between independently deployed clients that will not update in lockstep — and the failure mode of an unguarded old *writer* against a newer store is not an error but a silent violation of the no-lost-writes invariant (it would commit through the old protocol, bypassing whatever the new format's commit point is). Loud refusal is the seatbelt that makes future format evolution safe at all. The compatibility strategy is deliberately simple: one integer, strict comparison, and any future format bump ships with an explicit, atomic (single-CAS), one-way `upgrade()` — no auto-upgrade on library update, and `rollbackTo` across an upgrade boundary must restore data while preserving the store's format version. The rejected alternative is Delta-Lake-style per-feature flags (`requires: {read, write}`), which give finer granularity at the cost of a permanent dual-format read/write matrix; with a young package and a tiny installed base, break-loudly-with-an-upgrade-path is the better trade, revisitable if adoption makes coordinated upgrades genuinely painful.

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

### The ordered commit log (format 3)

Format 3 replaces the commit *point* while keeping the commit *protocol*: instead of CAS-swapping the whole manifest, a commit PUTs an immutable delta entry to `log/<version>.json` with a create-only precondition — the slot number is the version, and first-writer-wins on the slot is the arbiter. `manifest.json` is demoted to a periodic checkpoint (every 8 versions, written best-effort off the commit's latency path, advanced under its own CAS chain so it can never regress); a snapshot is one checkpoint read plus a replay of the log tail, and entries are immutable so every entry but the tip probe comes from cache. The log has no gaps by construction — slot n+1 is only ever attempted by a writer that observed slot n — so the first missing entry is the tip.

What this buys, measured over the same 40 ms fake-S3 harness as everything else: losing a race costs one tiny entry read and a retry at the next slot instead of a full manifest round-trip (mixed-workload p95 under 10-writer contention drops ~25%); commit payloads are deltas, so write cost stops scaling with database size (a 10,000-chunk manifest re-uploaded per commit versus a ~300-byte entry); and rebases reuse staged chunks exactly as before. What it deliberately keeps: the same jittered exponential backoff (measured: near-immediate slot retries starve slow writers — the exponential spread is the fairness mechanism), the same re-execute-on-overlap semantics, and the same loud `ConflictError` (with a 3× attempt budget, because slot attempts are ~3× cheaper and faster than CAS attempts). Throughput at small scale is parity with format 1 — the log's advantages are structural (size independence, cheap conflicts, and the substrate the future cross-process rungs of Section 14 need), not a small-scale speedup, and the docs say so.

Entering format 3 is explicit and atomic: `db.upgrade()` is one final manifest CAS that flips `formatVersion` (older clients then refuse loudly via the Section 5 guard), or `larva({ commitLog: true })` creates new stores in format 3 from birth (retaining v0 as the base-of-time checkpoint). Time travel survives: history checkpoints are sparse (every 8th version) but `manifestAt` reconstructs any retained version by replaying log entries from the nearest base, so `asOf` and `rollbackTo` keep per-version granularity; rollback across the upgrade boundary restores data while preserving the format version. Vacuum treats log entries as history: an entry is dropped only once it is outside the retention window *and* no longer needed to replay from the oldest retained checkpoint.

### Two-tier writes and cross-process group commit (format 4 — shipped)

Format 3 removed contention *inside* an instance (group commit) and made losing a race cheap (log rebases). The residual ceiling is **cross-instance**: two warm function instances still race for the same log slot, and under sustained multi-instance write load the retry budget is spent on coordination rather than work. Format 4 removes that ceiling with two mechanisms that share one substrate — per-writer intent queues — and one insight about honesty:

**The classification insight.** A write can be acknowledged the moment it is *durable* — rather than the moment it is *ordered* — if and only if its outcome is fully determined at the client. A pure `INSERT` into a table whose primary key is auto-generated (`t.uuid()`; a leased `t.sequence()` value also qualifies — it is known before the write leaves the process) and which carries **no other uniqueness constraints** cannot fail ordering: there is no constraint whose verdict depends on what other writers did. Acknowledging such a write at one durable PUT is not optimistic-UI faking — nothing about its result is unknown. Everything else (explicit primary keys, `UNIQUE` columns, composite uniques, upserts, `UPDATE`, `DELETE`, multi-statement transactions) has an outcome that depends on ordering, and must wait for a slot verdict. Classification is automatic, per statement, at plan time; there is no new API surface.

**Tier A — intent appends (constraint-free).** The writer PUTs the rows as a create-only intent blob under its own prefix — `queue/<writerId>/intent-<seq>.json` — and acknowledges the caller. One round-trip, zero contention with anyone, durable at ack: the LSM memtable idea rebuilt from blobs. Visibility is deferred: a lease-elected **compactor** (any live instance; see the lease below) folds pending intents into ordinary log commits in batches. Folding is idempotent *by construction* rather than by ledger: tier-A rows always carry client-generated primary keys, and a fold inserts with skip-on-existing-pk semantics — so a compactor that crashes after writing the log entry but before deleting the folded intents merely causes a harmless re-fold (intent deletion is cleanup, not correctness). The writing instance overlays its own un-folded intents onto query results, so read-your-writes holds where users actually expect it; global visibility lags by the fold cadence (target: sub-second while any writer is live, since a writer with pending intents self-elects when the lease is free). Two honest footnotes the docs must carry: `committedAt`/time-travel granularity for tier-A rows is the *fold* commit, not the intent PUT (give the table a timestamp column if row-level times matter); and if every format-4-capable client exits before folding, intents sit durable-but-invisible until one returns — which is precisely why this is a guarded format bump and not a soft feature (Section 5).

**Tier B — cross-process group commit (constraint-bearing).** Under contention, writers stop racing for slots themselves: they PUT the transaction as an intent (same queue, marked ordered) and await a verdict. The **leaseholder** collects pending ordered intents from all writers, plans them sequentially against a virtual manifest — literally the same planning loop in-process group commit already uses, promoted across process boundaries — and lands the batch as one log slot whose entry embeds per-intent verdicts (`ok` or a precise error). Writers learn their verdict from the log-tail reads they already perform to advance snapshots; the promise the app awaited resolves or rejects accordingly. The **fast path is preserved**: with no lease held and no recent slot losses, a lone writer takes the slot directly exactly as in format 3 — queue-and-wait engages only when contention is detected (consecutive 412s) or a leader is already batching, so uncontended latency does not regress.

**The lease is a performance mechanism, never a correctness one** — this is the design's safety keystone. `lease.json` is CAS-claimed with a TTL and renewed by the holder; anyone may steal it after expiry. Split leadership (two self-believing leaders, clock skew, a zombie holder) wastes work but corrupts nothing, because the create-only log slot remains the sole arbiter: two leaders proposing slot *n* resolve exactly like two format-3 writers racing — one 200, one 412, loser rebases. Every failure mode reduces to cases the format-3 machinery already handles: leader crash → lease expires, another writer self-elects and re-plans the queue (verdict re-derivation is deterministic; a re-planned intent that already landed is recognized by its commitId in the log); compactor crash mid-fold → idempotent re-fold; writer crash after PUTting an ordered intent → the transaction may still commit unobserved, which is the same partition-after-send window every client-server database has.

**What it buys, and the physics it doesn't change.** Tier A: appends cost one PUT round-trip each and parallelize without limit — the event-log/activity-feed/telemetry shape stops touching the ordered path entirely. Tier B under contention: throughput becomes slots-per-second × batch size (envelope: ~100–250 ordered transactions/sec at realistic batching) and tail latency becomes intent-PUT + fold interval + verdict read (~2–4 round-trips) instead of fifteen-attempt backoff storms. Unchanged, on purpose: a *constraint-bearing* synchronous commit can never acknowledge faster than one durable PUT round-trip, because durability cannot be faked — format 4 moves work off the ordered path, it does not cheat the path itself.

Entering format 4 requires format 3 first (`upgrade()` raises straight to the top; `larva({ commitLog: true })` births new stores there); it is one-way, explicit, and guarded like every bump — old clients refuse loudly rather than write around the queue or strand it.

**Shipping status.** Both tiers are shipped and verified. Tier A: classification, the one-PUT append path, the overlay (SELECTs scan pending rows alongside chunks, deduped by pk), the ordered-write barrier (an UPDATE/DELETE/transaction folds this instance's pending appends first, so it can never silently miss a row the caller just wrote), the lease-coordinated fold with pk-idempotence plus re-execution when the folded table changed under the plan (the split-lease double-fold guard), and self-healing cleanup (an orphaned intent blob is re-folded harmlessly and deleted by the next cycle). Tier B: single-statement ordered writes escalate to the queue when the contention heuristic trips (two slot losses in one commit, or a rescue after an exhausted retry budget); any waiting writer that finds the lease free elects itself, batches every pending ordered intent into one slot with per-intent verdicts embedded in the entry, and waiting writers learn their fate from the log-tail reads they already do. A verdict on record makes a leftover intent cleanup, never work — the crashed-leader window closes by construction. One measured harness datapoint: 24 concurrent ordered updates from three instances landed as a single log slot. An implementation subtlety worth recording: concurrent request handlers inside one instance share the proto's writer identity, so lease acquisition alone cannot distinguish them — all lease-holding work (folds and leader passes) serializes through one per-instance chain, or N waiters would each 'renew their own lease' and elect N simultaneous leaders (caught by the harness as a 8× over-applied counter).

### The guarantee, stated honestly

Larva promises: **no silently lost writes, atomic and durable commits, snapshot-isolated reads** — in every format; what changes across formats is the cost of contention, never the guarantee. It does not promise: high write throughput or low write-conflict rates under heavy concurrency. Every commit serializes through one arbitration point — a compare-and-swap on the manifest (formats 1–2) or first-writer-wins on the next log slot (format 3) — so sustained throughput is realistically single-digit commits per second, and heavily concurrent writers will spend time in retry loops (cheaper per retry in format 3, but retries still). This trade was accepted explicitly at design time: for the target workload (small teams, dashboards, agent-built tools) it is invisible; for workloads where it is not invisible, Section 10 tells you to leave, and Section 12 gives you the door. Format 4 raises the envelope: constraint-free appends leave the ordered path entirely (durable at one PUT), and contended ordered commits batch across processes into shared slots (harness-measured: 24 writers' statements in one slot) — but its floor is stated above too: a constraint-bearing synchronous commit is never faster than one durable PUT round-trip.

Cross-statement note: transactions provide atomicity and snapshot reads, and the overlap check at commit time rejects write-write conflicts. This is snapshot isolation, not full serializability — write skew between two transactions reading overlapping data and writing disjoint rows is theoretically possible, exactly as in Postgres's default `READ COMMITTED`/`REPEATABLE READ` modes. This is documented and considered acceptable for v1.

### Caching

Immutability makes caching trivial and safe. Warm function instances keep an in-memory LRU of decoded chunks keyed by chunk pathname; because a pathname is never reused with different content, a cache entry can never be stale. The manifest is the only object requiring freshness, and it is small. Blob's CDN independently caches chunk fetches across cold starts, and CDN hits are free of per-operation charges, so the architecture's read path is cheap as well as correct. Typical warm read: one small manifest round-trip plus zero or more cached chunk hits.

## 7. The SQL dialect

Larva accepts real SQL strings. The dialect is a deliberately small, fully documented subset — small enough that an agent's system prompt can enumerate it, and small enough that the parser can produce precise, correcting error messages ("window functions are not supported in Larva v1; compute windows in application code") rather than generic syntax errors. Agents self-correct well when errors are specific; this is a design feature, not a limitation dressed up.

**Supported.** `SELECT` (optionally `DISTINCT`) with full scalar expressions in the select list — arithmetic, `||` concatenation, `CASE WHEN` (searched and simple forms), `CAST(x AS text/integer/real/boolean)`, and the closed scalar-function set `UPPER`, `LOWER`, `LENGTH`, `TRIM`, `ROUND`, `ABS`, `COALESCE`, `NULLIF`, `IFNULL`, `REPLACE`, `CEIL`, `FLOOR`, `MOD`, `SUBSTR`; date/time helpers `NOW()` / `CURRENT_TIMESTAMP`, `DATE(x)`, and `STRFTIME(fmt, x)` (`%Y %m %d %H %M %S`) — cheap by construction, because timestamps are ISO 8601 text, so `DATE(x)` is a prefix slice and range filters already compare lexicographically; JSON access over text columns with `JSON_EXTRACT(col, '$.a.b[0]')` and the `->>` operator (SQLite json1 semantics; `t.json()` remains reserved — agents store JSON via `t.text()` today, and this makes it queryable); `WHERE` (comparison operators, `AND`/`OR`/`NOT`, `IN`, `BETWEEN`, `LIKE`, `IS NULL`); `ORDER BY` (source columns or select-item aliases), `LIMIT`/`OFFSET`; `GROUP BY` over full expressions or select aliases (`GROUP BY DATE(createdAt)`, `GROUP BY month` — a bare name resolves to the real column first, then to an alias) with the aggregates `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `GROUP_CONCAT(x, sep)` — over arbitrary expressions, with `COUNT(DISTINCT col)` — and `HAVING`, which may reference aggregates or select aliases; `INNER JOIN` and `LEFT JOIN` on equality predicates across **any number of tables, including self-joins** (shipped 2.5) — left-deep hash joins in statement order, each `ON` comparing a column of the joined table with a column of any table already in scope, and the parser requiring a distinct alias per occurrence so columns can always be attributed; and **uncorrelated subqueries** (shipped 2.5) — `WHERE id IN (SELECT …)`, `NOT IN`, and scalar comparisons like `total > (SELECT AVG(total) FROM orders)`, implemented exactly as planned: the inner query executes first against the same snapshot and its node is rewritten into plain literals before the outer plan runs, which means `IN` lists participate in zone-map pruning and a commit retry that re-plans also re-evaluates the subquery on the fresh snapshot; correlated references fail with the original name error plus a pointer at `JOIN`. Two semantics decisions, made deliberately: (a) `NULL`s returned by the subquery are dropped from the `IN` list — Larva is two-valued throughout (comparisons with `NULL` are false, not UNKNOWN), so `NOT IN (SELECT nullable-column …)` returns the rows the author intended instead of inheriting SQL's NULL-poisoning trap, and the agent docs say so; (b) a write whose conflict resolves by **rebase** (the winner touched disjoint data) keeps the values its subqueries read from the planning snapshot — this is ordinary snapshot isolation, identical to a Postgres statement not seeing a mid-statement commit and to Larva transactions (Section 6, write skew accepted); a conflict that overlaps the written table re-executes and re-reads as always. `INSERT` (single and multi-row) with upsert via `ON CONFLICT (col) DO NOTHING` / `DO UPDATE SET col = excluded.col` — the conflict target must be the primary key, a `UNIQUE` column, or (multi-column, e.g. `ON CONFLICT (userId, feature)`) a composite unique constraint declared in the schema, because those are the only places uniqueness is enforced. `UPDATE ... WHERE`, `DELETE ... WHERE`, `CREATE TABLE`, `DROP TABLE`, and **additive `ALTER TABLE … ADD COLUMN`** (shipped 2.5) — a plain nullable column as a schema-only commit; existing chunks are untouched and absent keys read as `NULL` at every read path (query, export), so the feature costs one manifest/log write regardless of table size. `DROP COLUMN` and `RENAME` remain excluded until a migration design that respects time travel exists. Parameterized queries via `?` placeholders and via tagged-template interpolation, which is the strongly documented default (Section 11).

One pruning note: a zone-map filter needs the raw column (`WHERE createdAt >= '2026-07-01'` prunes; `WHERE DATE(createdAt) >= '2026-07-01'` scans, then filters correctly). The error catalog also hints near-miss spellings toward the supported form (`CONCAT` → `||`, `SUBSTRING` → `SUBSTR`, `DATE_TRUNC` → `DATE`/`STRFTIME`).

The dialect started smaller (no `DISTINCT`, `HAVING`, scalar functions, select-list expressions, or upsert). The expansion criterion was empirical, and it is the bar for any future addition: **a construct joins the dialect when agents writing conservative SQL emit it routinely and it executes within the existing engine shape** — in-memory relational algebra after pruning, one manifest CAS per write. `HAVING` cost nothing once grouping already happened in memory; upsert reuses the copy-on-write chunk rewrite that `UPDATE` already needed. Four exclusions were re-judged against the same bar in July 2026 and **shipped in 2.5**: uncorrelated subqueries, joins of three or more tables, self-joins, and additive `ALTER TABLE` — agents emit all of them routinely, and each executes inside the existing shape (an uncorrelated subquery is just a query whose result feeds the outer plan; an N-way join is the same hash join, folded; `ADD COLUMN` is a schema-only commit). Constructs that would change the engine shape (window functions, correlated subqueries) stay out regardless of demand.

**Not supported.** Correlated subqueries, derived tables (subqueries in `FROM`), window functions, views, triggers, `UNION`, `RIGHT`/`FULL`/`CROSS` joins, `DROP COLUMN`/`RENAME`, nested aggregates, and `WHERE` on `DO UPDATE` — each rejected by name with a workaround: rarely emitted by agents writing conservative SQL, expressible in application code at Larva's scale, or (for column drops/renames) waiting on a migration design that respects time travel.

One mixed-version caveat, accepted deliberately: a store that has been `ALTER`ed contains chunks whose rows lack the added column's key. Clients from 2.5 on fill those as `NULL` at read time; a pre-2.5 client reading such a store fails **loudly** (`UNKNOWN_COLUMN`) if a query touches the added column in an old chunk — never silently wrong. A format bump could not express this anyway (Section 5: `formatVersion >= 3` is the log-mode discriminator, so CAS-mode stores cap at 2), and the failure mode is loud-and-partial rather than corrupting, which is inside the no-silently-lost-writes promise.

Execution is straightforward relational algebra: the planner extracts predicates on the primary key and partition column to prune chunks via the manifest's zone maps, fetches surviving chunks in parallel, and filters, joins, aggregates, and sorts in memory. At the target scale (a 30,000-row table is ten to thirty chunks, a couple of MB) this is sub-second even for a full-table scan; the planner's job is to make the common case touch far less than the full table.

## 8. Schema definition

Larva is code-first with a SQL door. The canonical schema is a TypeScript object checked into the repository:

```ts
import { defineSchema, t } from "@larva-db/core";

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

This choice is driven by the agent-first audience: a schema file in the repo is *in the agent's context window*, which means the agent writes correct SQL against real column names instead of hallucinating them, and typed row results flow through the application. `CREATE TABLE` / `DROP TABLE` statements are also accepted at runtime (agents doing interactive setup use this), and are reconciled into the manifest schema; when a code-first schema is present it is authoritative, and drift between code and manifest is surfaced as a clear startup error rather than silently ignored — with one healing exception (2.5): drift that is exactly a **plain nullable column added in code** is additive `ALTER TABLE … ADD COLUMN`, so connect applies it as a schema commit instead of failing. Add a column to `defineSchema`, redeploy, and it just works; anything needing a real migration (type changes, drops, primary-key/unique/partition changes) still fails loudly.

Three schema features require format 2 (Section 5) because pre-v2 writers would mishandle them, and a store only declares format 2 when its schema actually uses one:

- **Auto-UUID columns** — `t.uuid()` is a text column auto-filled with a time-ordered UUIDv7 on `INSERT` when omitted (an explicit value is respected). The writer invents the value, so identity assignment is contention-free — nothing to coordinate, no shared state, unlike sequences — and time-ordering keeps new rows clustered in chunk zone maps so primary-key pruning stays effective where a random UUIDv4 would scatter. The preferred identity column; `t.sequence()` exists for human-facing small numbers.
- **Sequence columns** — `t.sequence()` is an integer column auto-assigned on `INSERT` when omitted. Values come from ranges claimed by CAS on a small `sequences.json` blob *off the manifest hot path*, so drawing numbers never contends with commits; ranges are disjoint across processes, making values unique across concurrent writers by construction. The contract is exactly a Postgres sequence: monotonic-ish, unique, and **gappy** — a crash or a re-executed commit strands unclaimed numbers, on purpose (a gap-free ordered assignment would reintroduce the serialized-CAS hot spot the feature exists to avoid).
- **Composite unique constraints** — `defineSchema(spec, { uniques: { orders: [["customerId", "sku"]] } })`. Enforced on `INSERT` and upsert with the same machinery as single-column `.unique()` (a constraint key containing a SQL `NULL` never conflicts), and addressable as a multi-column conflict target: `ON CONFLICT (customerId, sku) DO UPDATE …`. Like single-column uniques, enforcement happens where inserts are planned and re-planned — the re-execute-on-overlap commit path is what makes it hold under concurrency.

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

**Private storage only.** Every blob Larva writes carries `access: "private"` — enforced in the storage adapter on every put, not checked once at connect time — because public blobs are readable by anyone holding the URL, and blob URLs leak and get indexed. Every read and write is authenticated with the store's token via the standard `@vercel/blob` SDK (OIDC or read-write token from the Vercel environment). Larva never generates public URLs for data blobs.

**The token is the perimeter.** Anyone with the Blob read-write token has full read-write on the database — Larva adds no user-level access control, and says so plainly. Row-level security, multi-tenant isolation within one database, and per-user permissions are application concerns (or reasons to graduate to Postgres). The threat model v1 defends: network attackers (everything is authenticated HTTPS), blob-URL leakage (private store), concurrent-writer corruption (commit protocol), and accidental destruction (time travel).

**SQL injection.** Agent-generated code interpolating user input into query strings is a certainty, so the primary API is a tagged template that makes parameterization the path of least resistance — `db.sql\`SELECT * FROM users WHERE email = ${email}\`` produces a parameterized query, never string concatenation. A raw-string API exists (`db.query(sqlString, params)`) and the documentation for it leads with placeholders. The parser additionally rejects multiple statements per string, closing the classic `'; DROP TABLE` stacking vector outside explicit transactions.

**Destructive SQL.** Larva deliberately does not restrict what SQL an authenticated caller may run — an agent can empty a table on any database, and pretending otherwise breeds false confidence. The mitigation is recoverability (Section 9), plus one guardrail cheap enough to justify itself: `UPDATE` and `DELETE` without a `WHERE` clause require an explicit `{ allowFullTable: true }` option, converting the most common catastrophic agent mistake into a specific error message the agent reads and reconsiders.

## 12. The escape hatch and portability

**Export is a v1 feature, not an afterthought.** A tool aimed at people who cannot rescue themselves must never trap them. `db.export()` (and `npx larva export`) produces, from a single manifest snapshot with zero locking — consistency is free because the snapshot is immutable:

- a genuine SQLite `.db` file, which makes graduation to Turso, Cloudflare D1, litestream, or plain SQLite a file-import rather than a migration project;
- a single Postgres `.sql` file in `pg_dump`'s shape — `CREATE TABLE` statements with mapped types (`text`→`text`, `integer`→`bigint`, `real`→`double precision`, `boolean`→`boolean`, `timestamp`→`timestamptz`, since ISO 8601 strings parse directly), data as `COPY ... FROM stdin` blocks (far faster to load than INSERTs), and `.references()` declarations emitted as real `FOREIGN KEY` constraints — meaning the exported database is *more* rigorously constrained than the Larva original. One deliberate decision: the FK constraints are added by `ALTER TABLE` at the end of the file, after all data (as `pg_dump` does), so table load order never has to satisfy references and no topological sort is needed. The entire migration is `psql $DATABASE_URL < export.sql`;
- per-table JSON and CSV, for spreadsheets.

The documented graduation path is symmetric across the two directions people actually grow: the SQLite family (Turso, D1) is a file-import, and Postgres (Neon, Supabase, RDS) is a one-command load. Because Larva speaks a subset of standard SQL, application queries move with minimal translation. The Postgres output has been validated end-to-end: generated file → `psql` load → row-for-row round-trip including tab/newline/backslash values and NULLs, with the FK constraints verified to enforce.

**Beyond Vercel.** Nothing in the architecture is Vercel-specific except roughly two hundred lines of storage adapter. The required storage contract is exactly four operations: get, put-with-CAS (ifMatch/precondition), delete, and list-by-prefix. Amazon S3 (conditional writes), Azure Blob Storage (If-Match), Google Cloud Storage (generation preconditions), and Cloudflare R2 all provide it. v1 ships the Vercel Blob adapter and defines the `StorageAdapter` interface publicly; community adapters make Larva "SQL over any blob store," which is the project's long-term ambition and the reason the name contains no vendor.

## 13. API surface (complete)

The entire v1 public API, which is also the ease-of-use contract — if this list grows past a screen, something has gone wrong:

```ts
import { larva, defineSchema, t } from "@larva-db/core";

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
await db.upgrade();                              // one-way flip to format 3 (the commit log)
```

The same surface ships as a shell command — the package's `larva` bin (`npx larva sql | export | upgrade | rollback | vacuum | version`, credentials auto-loaded from `.env.local`). One surface, two doors; the CLI is validated end to end by `scripts/cli-smoke.ts`.

## 14. Roadmap and open questions

v1 ships: the storage engine and commit protocol, the SQL subset of Section 7, code-first schema, transactions, time travel and rollback, vacuum, export to SQLite/JSON/CSV, the Vercel Blob adapter, and the two documents (this spec and the quickstart).

**The committed implementation track (decided July 2026).** The goal it serves: a small app with many concurrent users should not be a graduation reason — only Postgres-shaped needs should be. In order:

1. **Auto-ID columns** — `t.uuid()`: a text column auto-filled with a time-ordered UUID (v7) on `INSERT` when omitted. Contention-free identity — the writer invents the value, so unlike `t.sequence()` there is nothing to coordinate — and time-ordering keeps new rows clustered in chunk zone maps, so primary-key pruning stays effective (a random UUIDv4 scatters). Same agent ergonomics as sequences: omit the column, read it back with `RETURNING`.
2. **Intent queues + lease-elected cross-process group commit** — the ladder's rungs 4–5, **shipped in full as format 4** (Section 6, "Two-tier writes"): tier-A fast appends in 2.3.0, tier-B leader batching with verdicts in 2.4.0. The committed track is complete; the SQL dialect roadmap below is what remains.

**The SQL dialect roadmap (decided July 2026).** Four former exclusions, admitted or re-judged against the Section 7 bar. Three **shipped in 2.5**: additive `ALTER TABLE … ADD COLUMN` (schema-only commit; absent keys read as `NULL` at every read path; additive schema drift auto-migrates at connect — Section 8; renames and drops still wait for a migration design that respects time travel), joins of three or more tables and self-joins (left-deep hash joins in the existing in-memory algebra; distinct alias per occurrence), and uncorrelated subqueries (inner-query-first evaluation rewriting the node into literals, exactly as planned — the result feeds the outer plan and `IN` lists participate in zone-map pruning; correlated subqueries stay out, per Section 7). What remains: **secondary index blobs** (an index is just another immutable blob committed in the same atomic swap — makes non-key lookups prune).

Still deferred, unordered: a columnar chunk format; S3/R2/GCS/Azure adapters (the S3 contract harness already exists); a tiny read-only web UI for browsing tables (non-engineers love to *see* their data); an optional Edge Config read-accelerator for flag-shaped tables.

**The v2 write path.** The v1 ceiling — every logical commit is one CAS on one global manifest — is a protocol choice, not an object-storage limit, and there is a ladder of known techniques for raising it if multi-process operational workloads (several deployments writing steadily, unique-constraint-bearing inserts, sequence assignment) become a target. In rough order of leverage per cost: **sequence range leasing** (shipped — `t.sequence()`, Section 8); **composite unique constraints** (shipped — `defineSchema` `uniques`, Section 8); **an ordered commit log** (shipped — format 3, Section 6: create-only numbered entries, checkpointed manifest, cheap rebases, explicit `upgrade()`); **lease-elected cross-process group commit** (committed — see above; object-storage CAS doubles as a lease primitive; the leaseholder batches every process's transactions into shared log slots — group commit across processes with no server anyone deploys, safe even under split leadership because the log stays the arbiter; needs the intent queues below as its transport, so the two ship together); **a two-tier write API** (committed — see above; constraint-free appends go to per-writer intent prefixes — zero contention, one-PUT-RTT durability, an LSM memtable made of blobs folded in by a lease-elected compactor; constraint-bearing writes go through the ordered log and wait for a deterministic slot verdict, Calvin-style); and **sharded contention domains** (a two-level manifest so unrelated table groups stop sharing one CAS). Each rung ships independently; the format-versioning guard (Section 5) is what makes adopting any of them a loud, upgradeable break instead of silent corruption. The physics no rung changes: sync-commit latency floors at one PUT round-trip, because durability cannot be faked.

Open questions for contributors: whether the SQL parser is written by hand or adapted from an existing JS SQL parser (leaning hand-written Pratt parser for error-message quality over the small dialect — and indeed it is hand-written); exact chunk-size tuning under real Blob latency; whether `RETURNING` stays in v1 (currently yes — agents rely on it heavily); and merging a group-commit batch's inserts into shared chunks (the batch path currently stages one chunk per member). The CI question is settled: the conflict/retry matrix runs offline on every push — the stress and property harnesses (`packages/larvadb/src/testing/`) execute over an in-process fake S3 with injected 409/500 chaos (`scripts/s3-adapter-test.ts`, `scripts/group-commit-test.ts`), and additionally against a live Blob store when the CI secret is configured.

## 15. Prior art and acknowledgments

Larva's storage design is a miniaturization of Delta Lake, Apache Iceberg, and Apache Hudi (immutable files + manifest + atomic swap), and its versioning model echoes Dolt and Fossil. The whole-file alternative (Path A) is essentially Litestream's problem domain approached from the opposite direction. Turso/libSQL defined the "SQLite for the serverless era" category Larva lives next to. Standing on these shoulders is the reason a small library can honestly promise big-database correctness properties.
