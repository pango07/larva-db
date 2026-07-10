import { AppendIntent, cmpScalar, ConflictError, LarvaProto, Manifest, Row, Scalar, Snapshot, SUPPORTED_FORMAT_VERSION, ulid } from "./core";
import { DatabaseSchema, SchemaError, schemaDrift, TableSchema } from "./schema";
import { InsertStmt } from "./sql/ast";
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
  private foldChain: Promise<void> = Promise.resolve();
  private foldScheduled = false;

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
    const drift = schemaDrift(code, live);
    if (drift.length > 0) {
      throw new SchemaError(
        "SCHEMA_DRIFT",
        `the code-first schema no longer matches the database:\n  - ${drift.join("\n  - ")}\nThe code schema is authoritative — migrate the data or update schema.ts.`,
      );
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
    return (await this.executor.execute(stmt, params, opts)) as T[];
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
    const run = this.foldChain.then(() => this.foldOnce());
    this.foldChain = run.catch(() => {});
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
      const intents = await this.proto.listIntents();
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

        const staged: { table: string; ref: Awaited<ReturnType<LarvaProto["stageChunk"]>>; baseSig: string }[] = [];
        for (const [table, rows] of merged) {
          const ts = schema[table];
          if (!ts || !snap.manifest.tables[table]) continue; // table dropped since the append — rows go with it
          const fresh = await this.dropExisting(snap, table, ts, rows);
          if (fresh.length === 0) continue;
          const ref = await this.proto.stageChunk(table, fresh, { pk: ts.primaryKey, part: ts.partitionColumn });
          staged.push({ table, ref, baseSig: snap.manifest.tables[table].chunks.map((c) => c.id).join(",") });
        }

        return {
          apply: (m) => {
            for (const { table, ref, baseSig } of staged) {
              const t = m.tables[table];
              if (!t) continue;
              // The idempotence check ran against the planning snapshot; any
              // change to the table since (a racing fold, a normal write)
              // forces re-execution so it runs again. Correctness keystone.
              if (t.chunks.map((c) => c.id).join(",") !== baseSig) return null;
              t.chunks.push(ref);
            }
            return m;
          },
          folds: intents.map((i) => i.intent.id),
        };
      });

      for (const { intent } of intents) this.pending.delete(intent.id);
      await this.proto.store.del(intents.map((i) => i.path)).catch(() => {});
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
      tables[table] = await this.proto.readTable(table, snap);
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

    const referenced = new Set<string>();
    for (const t of Object.values(snap.manifest.tables)) for (const c of t.chunks) referenced.add(c.path);
    for (const v of keepVersions) {
      const m = await this.proto.historyManifest(v);
      if (m) for (const t of Object.values(m.tables)) for (const c of t.chunks) referenced.add(c.path);
    }
    // Chunks introduced by retained log entries are reachable by time travel;
    // the raw checkpoint's chunks guard the rare case where its twin history
    // write was lost.
    for (const v of keepEntryVersions) {
      const e = await this.proto.readLogEntry(v);
      if (e) for (const d of Object.values(e.tables)) if (d) for (const c of d.add) referenced.add(c.path);
    }
    const rawCheckpoint = await this.proto.store.get(`${prefix}manifest.json`);
    if (rawCheckpoint) {
      const cp = JSON.parse(rawCheckpoint.body) as Manifest;
      for (const t of Object.values(cp.tables)) for (const c of t.chunks) referenced.add(c.path);
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
