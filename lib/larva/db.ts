import { LarvaProto, Manifest, Row, Scalar, Snapshot } from "./core";
import { DatabaseSchema, SchemaError, schemaDrift } from "./schema";
import { SqlError } from "./sql/errors";
import { ExecOptions, Executor, QueryStats } from "./sql/executor";
import { parse } from "./sql/parser";
import { CasConflictError, StorageAdapter, VercelBlobAdapter } from "./storage";

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

  sql = (strings: TemplateStringsArray, ...values: Scalar[]): Promise<Row[]> =>
    this.query(strings.join("?"), values);

  async query(text: string, params: Scalar[] = []): Promise<Row[]> {
    const stmt = parse(text);
    if (stmt.kind !== "select") {
      throw new SqlError("READ_ONLY", `asOf() snapshots are read-only; run ${stmt.kind.toUpperCase()} against the live database (or rollbackTo this version first)`);
    }
    return this.executor.execute(stmt, params, {}, this.snap);
  }
}

export class LarvaDb {
  private proto: LarvaProto;
  private executor: Executor;
  private ready?: Promise<void>;

  constructor(private opts: LarvaOptions = {}) {
    this.proto = new LarvaProto(opts.store ?? new VercelBlobAdapter(), opts.prefix ?? "larva/");
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

  /** Primary API: tagged template with automatic parameterization (Design §11). */
  sql = (strings: TemplateStringsArray, ...values: Scalar[]): Promise<Row[]> =>
    this.query(strings.join("?"), values);

  /** Raw string + positional ? params. Prefer db.sql`...` — it parameterizes for you. */
  async query(text: string, params: Scalar[] = [], opts: ExecOptions = {}): Promise<Row[]> {
    await this.ensureReady();
    return this.executor.execute(parse(text), params, opts);
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
