import { AppendIntent, cmpScalar, ConflictError, IndexRef, IntentVerdict, LarvaProto, Manifest, OrderedIntent, Row, Scalar, Snapshot, SUPPORTED_FORMAT_VERSION, ulid } from "./core";
import { ColumnDef, DatabaseSchema, fillAbsentColumns, SchemaError, schemaDrift, TableSchema } from "./schema";
import { hasSubquery, InsertStmt } from "./sql/ast";
import { SqlError } from "./sql/errors";
import { ExecOptions, Executor, PlanOutcome, QueryStats } from "./sql/executor";
import { parse } from "./sql/parser";
import { CasConflictError, StorageAdapter, VercelBlobAdapter } from "./storage";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Internal signal: the transaction callback issued no writes, so skip the CAS. */
class TxNoWrites extends Error {}

interface TxState {
  manifest: Manifest;
  applies: PlanOutcome["apply"][];
}

/**
 * Statement handle inside db.transaction(). Reads see the transaction's own
 * uncommitted writes (a virtual manifest); nothing touches the live database
 * until the single commit CAS at the end.
 */
export class LarvaTx {
  constructor(
    private executor: Executor,
    private state: TxState,
    private baseOpts: ExecOptions,
  ) {}

  sql = <T extends Row = Row>(strings: TemplateStringsArray, ...values: Scalar[]): Promise<T[]> =>
    this.query<T>(strings.join("?"), values);

  async query<T extends Row = Row>(text: string, params: Scalar[] = [], opts: ExecOptions = {}): Promise<T[]> {
    return (await this.executor.executeInTx(
      parse(text),
      params,
      { ...this.baseOpts, ...opts },
      { manifest: this.state.manifest, etag: "" },
      (apply) => {
        const next = apply(structuredClone(this.state.manifest));
        if (!next) throw new SqlError("INTERNAL", "transaction statement failed to apply to its own snapshot");
        this.state.manifest = next;
        this.state.applies.push(apply);
      },
    )) as T[];
  }
}

export interface LarvaOptions {
  /** Code-first schema (Design §8). Authoritative: drift vs. the store is a startup error. */
  schema?: DatabaseSchema;
  /** Blob-path prefix the database lives under. Default "larva/". */
  prefix?: string;
  /** Storage backend. Defaults to Vercel Blob via BLOB_READ_WRITE_TOKEN. */
  store?: StorageAdapter;
  /** Create NEW databases at the current top format (the ordered commit log
   * plus two-tier writes — cheaper conflicts, durable-at-PUT appends).
   * Existing databases are never changed by this flag; flip them explicitly
   * with db.upgrade(). */
  commitLog?: boolean;
}

/** A pinned read-only view of a past database version (Design §9). */
export class LarvaSnapshot {
  constructor(
    private executor: Executor,
    private snap: Snapshot,
  ) {}

  get version(): number {
    return this.snap.manifest.version;
  }

  sql = <T extends Row = Row>(strings: TemplateStringsArray, ...values: Scalar[]): Promise<T[]> =>
    this.query<T>(strings.join("?"), values);

  async query<T extends Row = Row>(text: string, params: Scalar[] = []): Promise<T[]> {
    const stmt = parse(text);
    if (stmt.kind !== "select") {
      throw new SqlError("READ_ONLY", `asOf() snapshots are read-only; run ${stmt.kind.toUpperCase()} against the live database (or rollbackTo this version first)`);
    }
    return (await this.executor.execute(stmt, params, {}, this.snap)) as T[];
  }
}

export class LarvaDb {
  private proto: LarvaProto;
  private executor: Executor;
  private ready?: Promise<void>;
  /** The store's format, learned at connect and raised by our own upgrade().
   * Another process raising it mid-session only means we skip tier A — safe. */
  private format = 1;
  /** This instance's durable-but-not-yet-folded appends (format 4, tier A). */
  private pending = new Map<string, { intent: AppendIntent; path: string }>();
  /** Serializes ALL lease-holding work on this instance (folds and leader
   * passes). Concurrent request handlers share one proto writerId, so
   * tryLease alone cannot distinguish them — without this chain, N waiters
   * would all "renew their own lease" and elect N simultaneous leaders. */
  private leaseChain: Promise<void> = Promise.resolve();
  private foldScheduled = false;
  /** Tier B escalation: while set in the future, ordered single-statement
   * writes queue for a leader instead of racing slots directly. */
  private queueUntil = 0;

  constructor(private opts: LarvaOptions = {}) {
    // Group commit on: concurrent writes through one LarvaDb instance coalesce
    // into a single CAS instead of contending with each other. This matters on
    // Fluid Compute, where one warm function instance serves many concurrent
    // requests — those writers share this instance and stop fighting over the
    // manifest entirely.
    this.proto = new LarvaProto(opts.store ?? new VercelBlobAdapter(), opts.prefix ?? "larva/", undefined, {
      groupCommit: true,
    });
    // Snapshots passing over a fold entry clear the overlays it made obsolete.
    this.proto.onFold = (ids) => ids.forEach((id) => this.pending.delete(id));
    this.executor = new Executor(this.proto);
  }

  /** Pruning stats of the most recent chunk fetch — how many chunks the zone maps skipped. */
  get lastQueryStats(): QueryStats {
    return this.executor.lastStats;
  }

  private ensureReady(): Promise<void> {
    this.ready ??= this.connect();
    return this.ready;
  }

  private async connect(): Promise<void> {
    const code = this.opts.schema;
    let manifest: Manifest;
    try {
      manifest = (await this.proto.snapshot()).manifest;
    } catch {
      // No manifest yet: create the database from the code-first schema.
      try {
        await this.proto.init(Object.keys(code ?? {}), code, { commitLog: this.opts.commitLog });
      } catch (err) {
        if (!(err instanceof CasConflictError)) throw err; // lost the init race — someone else created it
      }
      manifest = (await this.proto.snapshot()).manifest;
    }
    this.format = manifest.formatVersion ?? 1;
    if (!code) return;

    const live = (manifest.schema ?? {}) as DatabaseSchema;
    // Additive drift heals itself (Design §7, §8): a plain new column in code
    // is exactly ALTER TABLE … ADD COLUMN, so apply it instead of failing.
    // Anything that is not additive-safe stays a loud error below.
    const additions: { table: string; col: string; def: ColumnDef }[] = [];
    for (const [table, codeTable] of Object.entries(code)) {
      const liveTable = live[table];
      if (!liveTable) continue; // whole missing tables are created further down
      for (const [col, def] of Object.entries(codeTable.columns)) {
        if (liveTable.columns[col]) continue;
        if (def.primaryKey || def.unique || def.partitionBy) continue; // needs a real migration — leave for the drift error
        additions.push({ table, col, def });
      }
    }
    const virtual = additions.length === 0 ? live : structuredClone(live);
    for (const a of additions) virtual[a.table].columns[a.col] = a.def;

    const drift = schemaDrift(code, virtual);
    if (drift.length > 0) {
      throw new SchemaError(
        "SCHEMA_DRIFT",
        `the code-first schema no longer matches the database:\n  - ${drift.join("\n  - ")}\nThe code schema is authoritative — migrate the data or update schema.ts.`,
      );
    }
    if (additions.length > 0) {
      await this.proto.commit(async () => ({
        apply: (m) => {
          const s = structuredClone((m.schema ?? {}) as DatabaseSchema);
          for (const { table, col, def } of additions) {
            if (s[table] && !s[table].columns[col]) s[table].columns[col] = def;
          }
          m.schema = s;
          return m;
        },
      }));
      // Re-verify: a concurrent process may have added the same column with a
      // different definition between our drift check and our commit — the
      // apply above skips existing columns, so recheck against what actually
      // landed rather than assuming our additions won.
      const landed = ((await this.proto.snapshot()).manifest.schema ?? {}) as DatabaseSchema;
      const post = schemaDrift(code, landed);
      if (post.length > 0) {
        throw new SchemaError(
          "SCHEMA_DRIFT",
          `the code-first schema no longer matches the database:\n  - ${post.join("\n  - ")}\nThe code schema is authoritative — migrate the data or update schema.ts.`,
        );
      }
    }
    // Tables declared in code but missing from the store are created.
    const missing = Object.keys(code).filter((t) => !manifest.tables[t]);
    if (missing.length > 0) {
      await this.proto.commit(async () => ({
        apply: (m) => {
          for (const t of missing) {
            if (!m.tables[t]) {
              m.tables[t] = { chunks: [] };
              m.schema = { ...((m.schema ?? {}) as DatabaseSchema), [t]: code[t] };
            }
          }
          return m;
        },
      }));
    }

    // Indexes are performance metadata, never drift: .index() flags in code
    // are synced to the store in both directions (a create backfills from the
    // existing chunks — bounded by table size, which is small by design).
    // Tables created above embed their flags directly and self-initialize on
    // first write, so only pre-existing tables can disagree.
    const flagsDiffer = Object.entries(code).some(
      ([table, ct]) =>
        live[table] &&
        Object.entries(ct.columns).some(
          ([col, def]) => (def.indexed ?? false) !== (virtual[table]?.columns[col]?.indexed ?? false),
        ),
    );
    if (!flagsDiffer) return;
    const synced = ((await this.proto.snapshot()).manifest.schema ?? {}) as DatabaseSchema;
    for (const [table, codeTable] of Object.entries(code)) {
      if (!live[table]) continue;
      for (const [col, def] of Object.entries(codeTable.columns)) {
        const liveIndexed = synced[table]?.columns[col]?.indexed ?? false;
        if ((def.indexed ?? false) === liveIndexed) continue;
        if (def.indexed) {
          await this.executor.execute({ kind: "createIndex", table, column: col, ifNotExists: true }, [], {});
        } else {
          // Another instance syncing the same schema may have dropped it first.
          await this.executor.execute({ kind: "dropIndex", table, column: col }, [], {}).catch((err) => {
            if (!(err instanceof SqlError && err.code === "INDEX_NOT_FOUND")) throw err;
          });
        }
      }
    }
  }

  /** Primary API: tagged template with automatic parameterization (Design §11).
   * Type rows with InferRow: db.sql<InferRow<typeof schema, "customers">>`...` */
  sql = <T extends Row = Row>(strings: TemplateStringsArray, ...values: Scalar[]): Promise<T[]> =>
    this.query<T>(strings.join("?"), values);

  /** Raw string + positional ? params. Prefer db.sql`...` — it parameterizes for you. */
  async query<T extends Row = Row>(text: string, params: Scalar[] = [], opts: ExecOptions = {}): Promise<T[]> {
    await this.ensureReady();
    const stmt = parse(text);
    // SELECTs scan this instance's un-folded appends alongside chunks, so a
    // caller always reads its own writes regardless of tier.
    if (stmt.kind === "select") {
      return (await this.executor.execute(stmt, params, { ...opts, overlay: this.overlayFor() })) as T[];
    }
    // Tier A (format 4): a write whose outcome is fully client-determined is
    // acknowledged at durability — one create-only PUT — instead of at ordering.
    if (this.format >= 4 && stmt.kind === "insert" && this.appendSchema(stmt)) {
      return (await this.append(stmt, params)) as T[];
    }
    // Ordered writes see prior appends: fold them into the log first, so an
    // UPDATE can never silently miss a row the caller just inserted.
    if (this.pending.size > 0) await this.foldNow();
    // Tier B (format 4): under cross-instance contention, stop racing slots —
    // ship the statement as an ordered intent and await a leader's verdict.
    // The fast path is untouched: with no contention observed, writes go
    // straight to their slot exactly as in format 3.
    if (this.format >= 4 && (stmt.kind === "insert" || stmt.kind === "update" || stmt.kind === "delete")) {
      if (Date.now() < this.queueUntil) return (await this.orderedViaQueue(text, params, opts)) as T[];
      try {
        const rows = (await this.executor.execute(stmt, params, opts)) as T[];
        const stats = this.executor.lastCommitStats;
        if (stats && stats.casConflicts >= 2) this.queueUntil = Date.now() + 10_000;
        return rows;
      } catch (err) {
        if (err instanceof ConflictError) {
          // Rescue: the direct path exhausted its budget — arbitrate via the queue.
          this.queueUntil = Date.now() + 10_000;
          return (await this.orderedViaQueue(text, params, opts)) as T[];
        }
        throw err;
      }
    }
    return (await this.executor.execute(stmt, params, opts)) as T[];
  }

  // ---------- format 4, tier B: ordered intents + leader batching ----------

  /** Ship one constraint-bearing statement to the queue and wait for the slot
   * verdict a leaseholder embeds in a log entry. Any waiting writer that finds
   * the lease free elects itself, so no dedicated leader ever needs to exist. */
  private async orderedViaQueue(sqlText: string, params: Scalar[], opts: ExecOptions): Promise<Row[]> {
    const snap = await this.proto.snapshot();
    const intent: OrderedIntent = {
      kind: "ordered",
      id: ulid(),
      writerId: this.proto.writerId,
      createdAt: new Date().toISOString(),
      baseVersion: snap.manifest.version,
      sql: sqlText,
      params,
      ...(opts.allowFullTable ? { allowFullTable: true } : {}),
    };
    const path = await this.proto.putIntent(intent);

    const deadline = Date.now() + 30_000;
    let scan = intent.baseVersion;
    for (;;) {
      for (;;) {
        const entry = await this.proto.readLogEntry(scan + 1);
        if (!entry) break;
        scan++;
        if (entry.folds?.length) entry.folds.forEach((id) => this.pending.delete(id));
        const v = entry.verdicts?.[intent.id];
        if (v) {
          if (v.ok) return v.rows ?? [];
          throw new SqlError(v.code, v.message);
        }
      }
      if (Date.now() > deadline) {
        // Withdraw best-effort; a leader that already read the blob may still
        // commit it, and the message says so instead of pretending otherwise.
        await this.proto.store.del([path]).catch(() => {});
        throw new SqlError(
          "VERDICT_TIMEOUT",
          "ordered write queued but no verdict arrived in 30s; the write MAY still commit — verify before retrying",
        );
      }
      await this.leadNow(); // elects only when the lease is genuinely free

    }
  }

  /** Leader duty (lease held): batch every pending ordered intent into one log
   * slot, verdicts embedded. Statements are planned sequentially against a
   * virtual manifest — the in-process group-commit machinery promoted across
   * process boundaries. One member's error becomes its verdict alone. */
  private async processOrderedQueue(): Promise<void> {
    const ordered = (await this.proto.listIntents()).filter(
      (i): i is { path: string; intent: OrderedIntent } => i.intent.kind === "ordered",
    );
    if (ordered.length === 0) return;

    // A leader that crashed after its slot landed but before cleanup leaves
    // arbitrated blobs behind: re-executing one would double-apply it, so
    // anything with a verdict on record is cleanup, not work.
    const pending: typeof ordered = [];
    for (const it of ordered) {
      if (await this.findVerdict(it.intent.id, it.intent.baseVersion)) {
        await this.proto.store.del([it.path]).catch(() => {});
      } else {
        pending.push(it);
      }
    }
    if (pending.length === 0) return;
    pending.sort((a, b) => (a.intent.createdAt < b.intent.createdAt ? -1 : a.intent.createdAt > b.intent.createdAt ? 1 : 0));

    await this.proto.commit(async (snap) => {
      const verdicts: Record<string, IntentVerdict> = {};
      let virtual = structuredClone(snap.manifest);
      const applies: PlanOutcome["apply"][] = [];
      for (const { intent } of pending) {
        try {
          const stmt = parse(intent.sql);
          if (stmt.kind === "select") throw new SqlError("INTERNAL", "an ordered intent cannot be a SELECT");
          const rows = await this.executor.executeInTx(
            stmt,
            intent.params,
            { allowFullTable: intent.allowFullTable },
            { manifest: virtual, etag: "" },
            (apply) => {
              const next = apply(structuredClone(virtual));
              if (next === null) throw new SqlError("INTERNAL", "ordered intent failed to apply to its own snapshot");
              virtual = next;
              applies.push(apply);
            },
          );
          verdicts[intent.id] = { ok: true, ...(rows.length ? { rows } : {}) };
        } catch (err) {
          verdicts[intent.id] =
            err instanceof SqlError || err instanceof SchemaError
              ? { ok: false, code: err.code, message: err.message }
              : { ok: false, code: "ORDERED_INTENT_FAILED", message: err instanceof Error ? err.message : String(err) };
        }
      }
      return {
        apply: (m) => {
          let cur: Manifest | null = m;
          for (const a of applies) {
            cur = a(cur);
            if (cur === null) return null;
          }
          return cur;
        },
        verdicts,
      };
    });
    await this.proto.store.del(pending.map((p) => p.path)).catch(() => {});
  }

  /** Scan entries after the intent's version horizon for its verdict. Entries
   * are immutable and cached, so repeat scans are cheap. */
  private async findVerdict(id: string, baseVersion: number): Promise<IntentVerdict | null> {
    for (let v = baseVersion + 1; ; v++) {
      const entry = await this.proto.readLogEntry(v);
      if (!entry) return null;
      const verdict = entry.verdicts?.[id];
      if (verdict) return verdict;
    }
  }

  // ---------- format 4, tier A: durable-at-PUT appends ----------

  /**
   * The classification insight (Design §6): a pure INSERT into a table whose
   * primary key is auto-generated and which carries no other uniqueness
   * constraints cannot fail ordering — nothing about its outcome depends on
   * what other writers did. Returns the table schema when the statement
   * qualifies. Conservative on purpose: code-first schemas only, and any
   * doubt means the ordered path.
   */
  private appendSchema(stmt: InsertStmt): TableSchema | null {
    const table = this.opts.schema?.[stmt.table];
    if (!table) return null;
    if (stmt.onConflict) return null;
    if (stmt.columns.includes(table.primaryKey)) return null;
    if (table.uniques?.length) return null;
    if (Object.values(table.columns).some((c) => c.unique)) return null;
    // A subquery in VALUES reads database state — not client-determined,
    // so it takes the ordered path (where plan-time resolution runs).
    if (stmt.rows.some((r) => r.some(hasSubquery))) return null;
    // A column the code schema doesn't know (e.g. added by a runtime SQL
    // ALTER) must be validated against the live manifest schema — ordered
    // path only; the append path plans from code.
    if (stmt.columns.some((c) => !(c in table.columns))) return null;
    return table;
  }

  private async append(stmt: InsertStmt, params: Scalar[]): Promise<Row[]> {
    const schema = this.appendSchema(stmt)!;
    // Sequences claim locally-leased ranges and auto ids are invented here, so
    // after prepareRows the rows are final — RETURNING needs no round-trip.
    const rows = await this.executor.prepareRows(stmt, params, schema);
    const intent: AppendIntent = {
      kind: "append",
      id: ulid(),
      writerId: this.proto.writerId,
      createdAt: new Date().toISOString(),
      tables: { [stmt.table]: rows },
    };
    const path = await this.proto.putIntent(intent); // ← durable here; this is the ack point
    this.pending.set(intent.id, { intent, path });
    this.scheduleFold();
    return this.executor.projectReturning(rows, stmt.returning, stmt.table);
  }

  private overlayFor(): Record<string, Row[]> | undefined {
    if (this.pending.size === 0) return undefined;
    const out: Record<string, Row[]> = {};
    for (const { intent } of this.pending.values()) {
      for (const [t, rows] of Object.entries(intent.tables)) (out[t] ??= []).push(...rows);
    }
    return out;
  }

  /** Debounced background fold: bursts of appends land as one log commit. A
   * failure here only delays visibility (the intents are durable) — the next
   * append, ordered write, or any other writer's fold picks them up. */
  private scheduleFold(delayMs = 25): void {
    if (this.foldScheduled) return;
    this.foldScheduled = true;
    setTimeout(() => {
      this.foldScheduled = false;
      void this.foldNow().catch(() => {});
    }, delayMs);
  }

  /** Fold every pending intent in the store (ours and anyone's) into one log
   * commit. Serialized per instance; lease-coordinated across instances. */
  private foldNow(): Promise<void> {
    const run = this.leaseChain.then(() => this.foldOnce());
    this.leaseChain = run.catch(() => {});
    return run;
  }

  /** One serialized leader pass: acquire the lease, arbitrate the ordered
   * queue, release. Queued behind any in-flight fold/leader work, so a burst
   * of waiters produces one working pass plus cheap no-op passes. */
  private leadNow(): Promise<void> {
    const run = this.leaseChain.then(async () => {
      if (!(await this.proto.tryLease())) {
        await sleep(80); // another instance is arbitrating — let it finish
        return;
      }
      try {
        await this.processOrderedQueue();
      } finally {
        await this.proto.releaseLease();
      }
    });
    this.leaseChain = run.catch(() => {});
    return run;
  }

  private async foldOnce(): Promise<void> {
    if (this.format < 4 || this.pending.size === 0) return;

    // The lease is a performance mechanism, never a correctness one: if we
    // fold concurrently with another leaseholder anyway, the pk-idempotence
    // check plus re-execution-on-changed-table keeps rows from doubling.
    for (let attempt = 0; !(await this.proto.tryLease()); attempt++) {
      if (attempt >= 100) throw new ConflictError(attempt);
      await sleep(150);
      await this.proto.snapshot(); // another folder may have cleared us (onFold)
      if (this.pending.size === 0) return;
    }

    try {
      const intents = (await this.proto.listIntents()).filter(
        (i): i is { path: string; intent: AppendIntent } => i.intent.kind === "append",
      );
      if (intents.length === 0) return;

      await this.proto.commit(async (snap) => {
        const schema = (snap.manifest.schema ?? {}) as DatabaseSchema;
        // Merge every intent's rows per table, deduped by pk within the batch.
        const merged = new Map<string, Row[]>();
        for (const { intent } of intents) {
          for (const [t, rows] of Object.entries(intent.tables)) {
            const bucket = merged.get(t) ?? [];
            const seen = new Set(bucket.map((r) => r[schema[t]?.primaryKey ?? "id"]));
            bucket.push(...rows.filter((r) => !seen.has(r[schema[t]?.primaryKey ?? "id"])));
            merged.set(t, bucket);
          }
        }

        const staged: {
          table: string;
          ref: Awaited<ReturnType<LarvaProto["stageChunk"]>>;
          baseSig: string;
          indexUpdates: Record<string, IndexRef>;
        }[] = [];
        for (const [table, rows] of merged) {
          const ts = schema[table];
          if (!ts || !snap.manifest.tables[table]) continue; // table dropped since the append — rows go with it
          const fresh = await this.dropExisting(snap, table, ts, rows);
          if (fresh.length === 0) continue;
          const ref = await this.proto.stageChunk(table, fresh, { pk: ts.primaryKey, part: ts.partitionColumn });
          const indexUpdates = await this.executor.stageIndexUpdates(snap, table, ts, [], [{ ref, rows: fresh }]);
          staged.push({ table, ref, baseSig: snap.manifest.tables[table].chunks.map((c) => c.id).join(","), indexUpdates });
        }

        return {
          apply: (m) => {
            for (const { table, ref, baseSig, indexUpdates } of staged) {
              const t = m.tables[table];
              if (!t) continue;
              // The idempotence check ran against the planning snapshot; any
              // change to the table since (a racing fold, a normal write)
              // forces re-execution so it runs again. Correctness keystone.
              if (t.chunks.map((c) => c.id).join(",") !== baseSig) return null;
              t.chunks.push(ref);
              for (const [col, r] of Object.entries(indexUpdates)) (t.indexes ??= {})[col] = r;
            }
            return m;
          },
          folds: intents.map((i) => i.intent.id),
        };
      });

      for (const { intent } of intents) this.pending.delete(intent.id);
      await this.proto.store.del(intents.map((i) => i.path)).catch(() => {});
      // While we hold the lease we are the leader — service any ordered
      // intents waiting in the same queue before letting it go.
      await this.processOrderedQueue();
    } finally {
      await this.proto.releaseLease();
    }
  }

  /** Idempotence: drop rows whose pk already exists in the snapshot (a crashed
   * folder's re-fold, a split lease). Zone maps prune the check to the chunks
   * whose pk range could contain time-ordered fresh ids — usually the tail. */
  private async dropExisting(snap: Snapshot, table: string, ts: TableSchema, rows: Row[]): Promise<Row[]> {
    const pks = rows.map((r) => r[ts.primaryKey]);
    const min = pks.reduce((a, b) => (cmpScalar(a, b) <= 0 ? a : b));
    const max = pks.reduce((a, b) => (cmpScalar(a, b) >= 0 ? a : b));
    const candidates = (snap.manifest.tables[table]?.chunks ?? []).filter(
      (c) => !c.stats || !(cmpScalar(c.stats.pkMax, min) < 0 || cmpScalar(c.stats.pkMin, max) > 0),
    );
    if (candidates.length === 0) return rows;
    const existing = new Set(
      (await Promise.all(candidates.map((c) => this.proto.readChunk(c)))).flat().map((r) => r[ts.primaryKey]),
    );
    return rows.filter((r) => !existing.has(r[ts.primaryKey]));
  }

  /**
   * All-or-nothing multi-statement transaction (Design §6, §13): the callback
   * runs against one pinned snapshot with read-your-writes, and everything it
   * wrote lands in a single manifest CAS. On conflict, the commit protocol
   * rebases if the changes were disjoint (staged chunks reused) or re-runs the
   * whole callback against a fresh snapshot if they overlapped.
   */
  async transaction<T>(fn: (tx: LarvaTx) => Promise<T>, opts: ExecOptions = {}): Promise<T> {
    await this.ensureReady();
    // Transactions are ordered by definition: fold our pending appends first
    // so the callback's snapshot contains everything this instance wrote.
    if (this.pending.size > 0) await this.foldNow();
    let result!: T;
    try {
      await this.proto.commit(async (snap) => {
        const state: TxState = { manifest: structuredClone(snap.manifest), applies: [] };
        result = await fn(new LarvaTx(this.executor, state, opts));
        if (state.applies.length === 0) throw new TxNoWrites();
        const applies = state.applies;
        return {
          apply: (m) => {
            let cur: Manifest | null = m;
            for (const a of applies) {
              cur = a(cur);
              if (cur === null) return null; // some statement's data changed — re-run the callback
            }
            return cur;
          },
        };
      }, opts);
    } catch (err) {
      if (!(err instanceof TxNoWrites)) throw err;
    }
    return result;
  }

  /** The escape hatch (Design §12): a consistent snapshot of every table. */
  async export(opts: { format: "json" }): Promise<Record<string, Row[]>>;
  async export(opts: { format: "csv" }): Promise<Record<string, string>>;
  async export(opts: { format: "sqlite" }): Promise<Uint8Array>;
  async export(opts: { format: "postgres" }): Promise<string>;
  async export(opts: {
    format: "json" | "csv" | "sqlite" | "postgres";
  }): Promise<Record<string, Row[]> | Record<string, string> | Uint8Array | string> {
    await this.ensureReady();
    const snap = await this.proto.snapshot();
    const schema = (snap.manifest.schema ?? {}) as DatabaseSchema;
    const tables: Record<string, Row[]> = {};
    for (const table of Object.keys(snap.manifest.tables)) {
      const rows = await this.proto.readTable(table, snap);
      // Rows written before an ALTER TABLE lack the added columns — export them as NULL.
      tables[table] = schema[table] ? fillAbsentColumns(rows, schema[table]) : rows;
    }
    if (opts.format === "json") return tables;

    const columnsOf = (table: string): string[] =>
      schema[table] ? Object.keys(schema[table].columns) : [...new Set(tables[table].flatMap(Object.keys))];

    if (opts.format === "postgres") return this.exportPostgres(tables, schema, columnsOf);

    if (opts.format === "csv") {
      const cell = (v: Scalar | undefined): string => {
        if (v === null || v === undefined) return "";
        const s = String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const out: Record<string, string> = {};
      for (const [table, rows] of Object.entries(tables)) {
        const cols = columnsOf(table);
        out[table] = [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
      }
      return out;
    }

    // sqlite — a genuine .db file, built with the runtime's SQLite (Bun CLI).
    interface BunSqliteDb {
      exec(sql: string): void;
      prepare(sql: string): { run(...args: (string | number | null)[]): void };
      serialize(): Uint8Array;
    }
    let Database: new (path: string) => BunSqliteDb;
    try {
      ({ Database } = await (Function('return import("bun:sqlite")')() as Promise<{ Database: new (path: string) => BunSqliteDb }>));
    } catch {
      throw new SqlError(
        "EXPORT_UNAVAILABLE",
        "sqlite export needs the Bun runtime (run it via a script: bun scripts/export.ts); json and csv formats work everywhere",
      );
    }
    const SQLITE_TYPE: Record<string, string> = { text: "TEXT", timestamp: "TEXT", integer: "INTEGER", real: "REAL", boolean: "INTEGER" };
    const file = new Database(":memory:");
    for (const [table, rows] of Object.entries(tables)) {
      const cols = columnsOf(table);
      const defs = cols.map((c) => {
        const def = schema[table]?.columns[c];
        return `"${c}" ${SQLITE_TYPE[def?.type ?? "text"]}${def?.primaryKey ? " PRIMARY KEY" : ""}${def?.unique ? " UNIQUE" : ""}`;
      });
      file.exec(`CREATE TABLE "${table}" (${defs.join(", ")})`);
      const stmt = file.prepare(`INSERT INTO "${table}" VALUES (${cols.map(() => "?").join(", ")})`);
      for (const row of rows) {
        stmt.run(...cols.map((c) => {
          const v = row[c] ?? null;
          return typeof v === "boolean" ? (v ? 1 : 0) : v;
        }));
      }
    }
    return file.serialize();
  }

  /**
   * A single .sql file in pg_dump's shape: CREATE TABLE for every table,
   * data as COPY ... FROM stdin blocks (far faster to load than INSERTs),
   * and FOREIGN KEY constraints added at the very end — after all data —
   * so table load order never has to satisfy references. Load with:
   * `psql $DATABASE_URL < export.sql`.
   */
  private exportPostgres(
    tables: Record<string, Row[]>,
    schema: DatabaseSchema,
    columnsOf: (table: string) => string[],
  ): string {
    const PG_TYPE: Record<string, string> = {
      text: "text",
      integer: "bigint",
      real: "double precision",
      boolean: "boolean",
      timestamp: "timestamptz", // ISO 8601 strings parse directly
    };
    const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
    // COPY text format: \N for NULL, backslash-escape the delimiter and line breaks.
    const copyCell = (v: Scalar | undefined): string => {
      if (v === null || v === undefined) return "\\N";
      if (typeof v === "boolean") return v ? "t" : "f";
      return String(v).replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
    };

    const ddl: string[] = [];
    const data: string[] = [];
    const constraints: string[] = [];
    for (const [table, rows] of Object.entries(tables)) {
      const cols = columnsOf(table);
      const defs = cols.map((c) => {
        const def = schema[table]?.columns[c];
        const parts = [q(c), PG_TYPE[def?.type ?? "text"]];
        if (def?.primaryKey) parts.push("PRIMARY KEY");
        if (def?.unique) parts.push("UNIQUE");
        return `  ${parts.join(" ")}`;
      });
      ddl.push(`CREATE TABLE ${q(table)} (\n${defs.join(",\n")}\n);`);

      const lines = rows.map((r) => cols.map((c) => copyCell(r[c])).join("\t"));
      data.push(`COPY ${q(table)} (${cols.map(q).join(", ")}) FROM stdin;\n${lines.map((l) => l + "\n").join("")}\\.`);

      for (const c of cols) {
        const target = schema[table]?.columns[c]?.references;
        if (!target) continue;
        const [refTable, refCol] = target.split(".");
        if (!refTable || !refCol || !(refTable in tables)) continue; // referenced table not in this export
        constraints.push(
          `ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(`${table}_${c}_fkey`)} FOREIGN KEY (${q(c)}) REFERENCES ${q(refTable)} (${q(refCol)});`,
        );
      }
    }

    return [
      "-- Larva export → PostgreSQL",
      `-- Generated ${new Date().toISOString()} by @larva-db/core (Design §12, the escape hatch)`,
      "-- Load with:  psql $DATABASE_URL < export.sql",
      "",
      "BEGIN;",
      "",
      ...ddl,
      "",
      ...data,
      ...(constraints.length ? ["", "-- Foreign keys last, after all data, so load order never matters.", ...constraints] : []),
      "",
      "COMMIT;",
      "",
    ].join("\n");
  }

  /**
   * Reclaim storage (Design §9): drop history manifests outside retention
   * (defaults: 7 days or last 50 versions, whichever keeps more) and delete
   * chunks referenced by no retained manifest. Orphans from crashed commits
   * are collected by the same sweep after the grace period. Safe alongside
   * readers and writers.
   */
  async vacuum(opts: { retainDays?: number; retainVersions?: number; graceMinutes?: number } = {}): Promise<{
    historyDeleted: number;
    chunksDeleted: number;
    retainedVersions: number;
  }> {
    await this.ensureReady();
    const retainDays = opts.retainDays ?? 7;
    const retainVersions = opts.retainVersions ?? 50;
    const graceMinutes = opts.graceMinutes ?? 60;
    const prefix = this.proto.prefix;
    const snap = await this.proto.snapshot();

    const objects = await this.proto.store.list(prefix);
    const historyPrefix = `${prefix}history/manifest.v`;
    const dayCutoff = Date.now() - retainDays * 86_400_000;
    const graceCutoff = Date.now() - graceMinutes * 60_000;

    const keepVersions = new Set<number>();
    const dropHistory: string[] = [];
    for (const o of objects) {
      if (!o.path.startsWith(historyPrefix) || !o.path.endsWith(".json")) continue;
      const version = Number(o.path.slice(historyPrefix.length, -".json".length));
      if (!Number.isInteger(version)) continue;
      // Keep if within the version window OR young enough — whichever is larger wins.
      if (version > snap.manifest.version - retainVersions || o.uploadedAt.getTime() >= dayCutoff) {
        keepVersions.add(version);
      } else {
        dropHistory.push(o.path);
      }
    }

    // Format 3: log entries are history too. An entry is needed while it is
    // inside the retention window OR still required to replay from the oldest
    // retained checkpoint (reconstruction has no other path to those versions).
    const logPrefix = `${prefix}log/`;
    const minKeptHistory = keepVersions.size > 0 ? Math.min(...keepVersions) : 0;
    const keepEntryVersions: number[] = [];
    const dropLog: string[] = [];
    for (const o of objects) {
      if (!o.path.startsWith(logPrefix) || !o.path.endsWith(".json")) continue;
      const version = Number(o.path.slice(logPrefix.length, -".json".length));
      if (!Number.isInteger(version)) continue;
      if (
        version > snap.manifest.version - retainVersions ||
        o.uploadedAt.getTime() >= dayCutoff ||
        version > minKeptHistory
      ) {
        keepEntryVersions.push(version);
      } else {
        dropLog.push(o.path);
      }
    }

    // Index blobs live under tables/ like chunks and are retained by the
    // same reachability rule. (A blob deleted anyway — e.g. by an older
    // client's vacuum — only disables pruning; readIndex degrades to null.)
    const referenced = new Set<string>();
    const referTable = (t: Manifest["tables"][string]): void => {
      for (const c of t.chunks) referenced.add(c.path);
      for (const r of Object.values(t.indexes ?? {})) referenced.add(r.path);
    };
    for (const t of Object.values(snap.manifest.tables)) referTable(t);
    for (const v of keepVersions) {
      const m = await this.proto.historyManifest(v);
      if (m) for (const t of Object.values(m.tables)) referTable(t);
    }
    // Chunks introduced by retained log entries are reachable by time travel;
    // the raw checkpoint's chunks guard the rare case where its twin history
    // write was lost.
    for (const v of keepEntryVersions) {
      const e = await this.proto.readLogEntry(v);
      if (!e) continue;
      for (const d of Object.values(e.tables)) {
        if (!d) continue;
        for (const c of d.add) referenced.add(c.path);
        for (const r of Object.values(d.indexes ?? {})) if (r) referenced.add(r.path);
      }
    }
    const rawCheckpoint = await this.proto.store.get(`${prefix}manifest.json`);
    if (rawCheckpoint) {
      const cp = JSON.parse(rawCheckpoint.body) as Manifest;
      for (const t of Object.values(cp.tables)) referTable(t);
    }

    const dropChunks = objects
      .filter(
        (o) =>
          o.path.startsWith(`${prefix}tables/`) &&
          !referenced.has(o.path) &&
          o.uploadedAt.getTime() < graceCutoff,
      )
      .map((o) => o.path);

    await this.proto.store.del([...dropHistory, ...dropLog, ...dropChunks]);
    return { historyDeleted: dropHistory.length + dropLog.length, chunksDeleted: dropChunks.length, retainedVersions: keepVersions.size };
  }

  /** Read-only snapshot of the database as of a past version or moment (Design §9). */
  async asOf(target: number | Date): Promise<LarvaSnapshot> {
    await this.ensureReady();
    const current = await this.proto.snapshot();
    let manifest: Manifest | null;
    if (typeof target === "number") {
      manifest = target === current.manifest.version ? current.manifest : await this.proto.manifestAt(target);
      if (!manifest) {
        throw new SqlError("VERSION_NOT_FOUND", `version ${target} is not in retained history (current version: ${current.manifest.version})`);
      }
    } else {
      const cutoff = target.toISOString();
      manifest = current.manifest.committedAt <= cutoff ? current.manifest : null;
      for (let v = current.manifest.version - 1; manifest === null && v >= 1; v--) {
        const h = await this.proto.manifestAt(v);
        if (h && h.committedAt <= cutoff) manifest = h;
        if (!h && v < current.manifest.version - 1) break; // walked past retention
      }
      if (!manifest) {
        throw new SqlError("VERSION_NOT_FOUND", `no retained version exists at or before ${cutoff}`);
      }
    }
    return new LarvaSnapshot(this.executor, { manifest, etag: "" });
  }

  /**
   * Flip this database to the current top format (Design §6): the ordered
   * commit log (format 3) plus two-tier writes (format 4 — durable-at-PUT
   * appends). One atomic commit; one-way; clients older than the format then
   * refuse loudly with FormatError instead of writing through the wrong
   * protocol. Data, history, and rollback all survive the flip.
   */
  async upgrade(): Promise<{ version: number; formatVersion: number }> {
    await this.ensureReady();
    const current = await this.proto.snapshot();
    this.format = Math.max(this.format, current.manifest.formatVersion ?? 1);
    if ((current.manifest.formatVersion ?? 1) >= SUPPORTED_FORMAT_VERSION) {
      return { version: current.manifest.version, formatVersion: current.manifest.formatVersion };
    }
    const result = await this.proto.commit(async () => ({
      apply: (m) => {
        m.formatVersion = Math.max(m.formatVersion ?? 1, SUPPORTED_FORMAT_VERSION);
        return m;
      },
    }));
    this.format = SUPPORTED_FORMAT_VERSION;
    return { version: result.version, formatVersion: SUPPORTED_FORMAT_VERSION };
  }

  /** Restore a past version. Itself a commit — non-destructive and rollbackable (Design §9). */
  async rollbackTo(version: number): Promise<{ version: number }> {
    await this.ensureReady();
    const past = await this.proto.manifestAt(version);
    if (!past) {
      throw new SqlError("VERSION_NOT_FOUND", `version ${version} is not in retained history`);
    }
    const result = await this.proto.commit(async () => ({
      apply: (m) => {
        m.tables = structuredClone(past.tables);
        m.schema = structuredClone(past.schema);
        return m;
      },
    }));
    return { version: result.version };
  }

  async currentVersion(): Promise<number> {
    await this.ensureReady();
    return (await this.proto.snapshot()).manifest.version;
  }

  /** Delete the entire database (test helper; not part of the Design §13 surface). */
  async destroy(): Promise<void> {
    await this.proto.destroy();
  }
}

export function larva(opts: LarvaOptions = {}): LarvaDb {
  return new LarvaDb(opts);
}
