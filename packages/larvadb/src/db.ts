import { LarvaProto, Manifest, Row, Scalar, Snapshot } from "./core";
import { DatabaseSchema, SchemaError, schemaDrift } from "./schema";
import { SqlError } from "./sql/errors";
import { ExecOptions, Executor, PlanOutcome, QueryStats } from "./sql/executor";
import { parse } from "./sql/parser";
import { CasConflictError, StorageAdapter, VercelBlobAdapter } from "./storage";

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

  constructor(private opts: LarvaOptions = {}) {
    // Group commit on: concurrent writes through one LarvaDb instance coalesce
    // into a single CAS instead of contending with each other. This matters on
    // Fluid Compute, where one warm function instance serves many concurrent
    // requests — those writers share this instance and stop fighting over the
    // manifest entirely.
    this.proto = new LarvaProto(opts.store ?? new VercelBlobAdapter(), opts.prefix ?? "larva/", undefined, {
      groupCommit: true,
    });
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
        await this.proto.init(Object.keys(code ?? {}), code);
      } catch (err) {
        if (!(err instanceof CasConflictError)) throw err; // lost the init race — someone else created it
      }
      manifest = (await this.proto.snapshot()).manifest;
    }
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
    return (await this.executor.execute(parse(text), params, opts)) as T[];
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

    const referenced = new Set<string>();
    for (const t of Object.values(snap.manifest.tables)) for (const c of t.chunks) referenced.add(c.path);
    for (const v of keepVersions) {
      const m = await this.proto.historyManifest(v);
      if (m) for (const t of Object.values(m.tables)) for (const c of t.chunks) referenced.add(c.path);
    }

    const dropChunks = objects
      .filter(
        (o) =>
          o.path.startsWith(`${prefix}tables/`) &&
          !referenced.has(o.path) &&
          o.uploadedAt.getTime() < graceCutoff,
      )
      .map((o) => o.path);

    await this.proto.store.del([...dropHistory, ...dropChunks]);
    return { historyDeleted: dropHistory.length, chunksDeleted: dropChunks.length, retainedVersions: keepVersions.size };
  }

  /** Read-only snapshot of the database as of a past version or moment (Design §9). */
  async asOf(target: number | Date): Promise<LarvaSnapshot> {
    await this.ensureReady();
    const current = await this.proto.snapshot();
    let manifest: Manifest | null;
    if (typeof target === "number") {
      manifest = target === current.manifest.version ? current.manifest : await this.proto.historyManifest(target);
      if (!manifest) {
        throw new SqlError("VERSION_NOT_FOUND", `version ${target} is not in retained history (current version: ${current.manifest.version})`);
      }
    } else {
      const cutoff = target.toISOString();
      manifest = current.manifest.committedAt <= cutoff ? current.manifest : null;
      for (let v = current.manifest.version - 1; manifest === null && v >= 1; v--) {
        const h = await this.proto.historyManifest(v);
        if (h && h.committedAt <= cutoff) manifest = h;
        if (!h && v < current.manifest.version - 1) break; // walked past retention
      }
      if (!manifest) {
        throw new SqlError("VERSION_NOT_FOUND", `no retained version exists at or before ${cutoff}`);
      }
    }
    return new LarvaSnapshot(this.executor, { manifest, etag: "" });
  }

  /** Restore a past version. Itself a commit — non-destructive and rollbackable (Design §9). */
  async rollbackTo(version: number): Promise<{ version: number }> {
    await this.ensureReady();
    const past = await this.proto.historyManifest(version);
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
