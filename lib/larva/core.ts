import { CasConflictError, isTransientStorageError, StorageAdapter } from "./storage";

export type Scalar = string | number | boolean | null;
export type Row = Record<string, Scalar>;

/** Zone-map statistics for one chunk (Design §5): min/max of the primary key
 * and, when the table declares one, of the partition column. */
export interface ChunkStats {
  pkMin: Scalar;
  pkMax: Scalar;
  partMin?: Scalar;
  partMax?: Scalar;
}

export interface ChunkRef {
  id: string;
  path: string;
  rows: number;
  stats?: ChunkStats;
}

export interface Manifest {
  formatVersion: 1;
  version: number;
  /** Unique id of the commit that produced this manifest. Lets a writer whose
   * CAS outcome was ambiguous (transient error, SDK-internal retry answered
   * with 412) discover that its own commit actually landed. */
  commitId: string;
  /** ISO timestamp of the commit — the index for asOf() time travel. */
  committedAt: string;
  /** Embedded schema (serialized DatabaseSchema); absent for schemaless
   * prototype databases created via init(). */
  schema?: unknown;
  tables: Record<string, { chunks: ChunkRef[] }>;
}

export interface Snapshot {
  manifest: Manifest;
  etag: string;
}

export interface CommitStats {
  attempts: number;
  casConflicts: number;
  rebases: number;
  reExecutions: number;
  ms: number;
}

export interface CommitResult {
  version: number;
  stats: CommitStats;
}

/** A commit that could not land after exhausting retries. Never silent. */
export class ConflictError extends Error {
  constructor(attempts: number) {
    super(`Commit failed after ${attempts} attempts due to concurrent writers`);
    this.name = "ConflictError";
  }
}

export class RowNotFoundError extends Error {
  constructor(table: string, id: string) {
    super(`No row with id "${id}" in table "${table}"`);
    this.name = "RowNotFoundError";
  }
}

interface CommitPlan {
  /**
   * Try to apply this plan's change to a (possibly fresher) manifest.
   * Receives a private clone it may mutate and return.
   * Return null if the data this plan touched changed underneath it —
   * the commit loop will then re-execute the planner on a fresh snapshot.
   */
  apply(base: Manifest): Manifest | null;
}

/** Stage phase: write new chunk blobs (touching nothing live), return the plan. */
type Planner = (snap: Snapshot) => Promise<CommitPlan>;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Minimal ULID: 10-char Crockford timestamp + 16 random chars. */
export function ulid(): string {
  let ts = Date.now();
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[ts % 32] + time;
    ts = Math.floor(ts / 32);
  }
  const rand = crypto.getRandomValues(new Uint8Array(16));
  let tail = "";
  for (const byte of rand) tail += CROCKFORD[byte % 32];
  return time + tail;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Total order over scalars of one column type; null sorts first. */
export function cmpScalar(a: Scalar, b: Scalar): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** Full-jitter exponential backoff: random in [0, min(50 * 2^attempt, 5000)].
 * The cap is deliberately generous: under N-way contention Blob rejects
 * overlapping in-flight conditional writes outright, so rounds can have no
 * winner at all unless writers spread out in time. */
function backoffMs(attempt: number): number {
  return Math.random() * Math.min(50 * 2 ** attempt, 5000);
}

/**
 * Prototype of the Larva storage engine: manifest + immutable chunks +
 * the Design §6 commit protocol (stage → CAS → rebase/re-execute/backoff).
 * No SQL layer — operations are direct (insert / increment / read).
 */
export class LarvaProto {
  private chunkCache = new Map<string, Row[]>();

  constructor(
    private store: StorageAdapter,
    /** Blob-path prefix this database lives under, e.g. "stress/01H.../". */
    readonly prefix: string,
    /** Optional per-attempt trace hook for debugging the commit loop. */
    private trace?: (msg: string) => void,
  ) {}

  private manifestPath(): string {
    return `${this.prefix}manifest.json`;
  }

  /** Create the empty database. Fails if one already exists at this prefix. */
  async init(tables: string[], schema?: unknown): Promise<void> {
    const manifest: Manifest = {
      formatVersion: 1,
      version: 0,
      commitId: ulid(),
      committedAt: new Date().toISOString(),
      schema,
      tables: Object.fromEntries(tables.map((t) => [t, { chunks: [] }])),
    };
    await this.store.put(this.manifestPath(), JSON.stringify(manifest), {
      createOnly: true,
    });
  }

  /** Fetch the manifest fresh from origin. Pins a consistent snapshot. */
  async snapshot(): Promise<Snapshot> {
    const res = await this.store.get(this.manifestPath(), { fresh: true });
    if (!res) throw new Error(`No manifest at ${this.manifestPath()} — call init() first`);
    return { manifest: JSON.parse(res.body) as Manifest, etag: res.etag };
  }

  /** Stage one immutable chunk. When statsCols is given, rows are sorted by
   * pk and zone-map min/max recorded for pruning. */
  async stageChunk(
    table: string,
    rows: Row[],
    statsCols?: { pk: string; part?: string },
  ): Promise<ChunkRef> {
    const id = ulid();
    const path = `${this.prefix}tables/${table}/chunk_${id}.json`;
    let stats: ChunkStats | undefined;
    if (statsCols && rows.length > 0) {
      const sorted = [...rows].sort((a, b) =>
        cmpScalar(a[statsCols.pk], b[statsCols.pk]),
      );
      rows = sorted;
      stats = { pkMin: sorted[0][statsCols.pk], pkMax: sorted[sorted.length - 1][statsCols.pk] };
      if (statsCols.part) {
        const parts = sorted.map((r) => r[statsCols.part as string]).filter((v) => v !== null);
        if (parts.length > 0) {
          stats.partMin = parts.reduce((a, b) => (cmpScalar(a, b) <= 0 ? a : b));
          stats.partMax = parts.reduce((a, b) => (cmpScalar(a, b) >= 0 ? a : b));
        }
      }
    }
    await this.store.put(path, JSON.stringify(rows), { createOnly: true });
    return { id, path, rows: rows.length, ...(stats ? { stats } : {}) };
  }

  /** Chunks are immutable, so the cache can never be stale. */
  async readChunk(ref: ChunkRef): Promise<Row[]> {
    const cached = this.chunkCache.get(ref.path);
    if (cached) return cached;
    const res = await this.store.get(ref.path);
    if (!res) throw new Error(`Missing chunk ${ref.path}`);
    const rows = JSON.parse(res.body) as Row[];
    this.chunkCache.set(ref.path, rows);
    return rows;
  }

  async readTable(table: string, snap?: Snapshot): Promise<Row[]> {
    const s = snap ?? (await this.snapshot());
    const refs = s.manifest.tables[table]?.chunks ?? [];
    const chunks = await Promise.all(refs.map((r) => this.readChunk(r)));
    return chunks.flat();
  }

  /**
   * The heart of the system — Design §6.
   * 1. Stage: planner writes new chunks against a pinned snapshot.
   * 2. Commit: CAS-swap the manifest on its ETag.
   * 3. Conflict: refetch; rebase if the plan still applies cleanly (disjoint
   *    change), otherwise re-execute the planner on the fresh snapshot.
   *    Jittered exponential backoff; after maxAttempts, throw ConflictError.
   */
  async commit(plan: Planner, opts?: { maxAttempts?: number }): Promise<CommitResult> {
    const maxAttempts = opts?.maxAttempts ?? 5;
    const started = Date.now();
    const stats: CommitStats = {
      attempts: 0,
      casConflicts: 0,
      rebases: 0,
      reExecutions: 0,
      ms: 0,
    };

    let snap = await this.snapshot();
    let current = await plan(snap);

    const finish = (version: number): CommitResult => {
      stats.ms = Date.now() - started;
      return { version, stats };
    };

    let lastCommitId = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      stats.attempts = attempt;

      let next = current.apply(structuredClone(snap.manifest));
      if (next === null) {
        // Overlapping change landed underneath us: re-execute against the fresh snapshot.
        stats.reExecutions++;
        current = await plan(snap);
        next = current.apply(structuredClone(snap.manifest));
        if (next === null) throw new Error("plan does not apply to its own snapshot");
      } else if (attempt > 1) {
        stats.rebases++;
      }
      next.version = snap.manifest.version + 1;
      next.commitId = lastCommitId = ulid();
      next.committedAt = new Date().toISOString();

      try {
        await this.store.put(this.manifestPath(), JSON.stringify(next), {
          ifMatch: snap.etag,
        });
        this.trace?.(`attempt ${attempt}: OK v${snap.manifest.version} -> v${next.version}`);
        // Retain the past version for time travel (best-effort; vacuum's problem if it fails).
        await this.store
          .put(`${this.prefix}history/manifest.v${next.version}.json`, JSON.stringify(next), {
            createOnly: true,
          })
          .catch(() => {});
        return finish(next.version);
      } catch (err) {
        // A CAS loss and a transient write error are handled identically:
        // refetch, then check whether our commit actually landed (an SDK-internal
        // retry of a successful put answers 412; a 5xx may have written).
        const conflict = err instanceof CasConflictError;
        if (!conflict && !isTransientStorageError(err)) throw err;
        if (conflict) stats.casConflicts++;
        this.trace?.(
          `attempt ${attempt}: ${conflict ? "412" : "transient error"} (based v${snap.manifest.version} etag ${snap.etag.slice(0, 12)})`,
        );
        if (attempt < maxAttempts) await sleep(backoffMs(attempt));
        snap = await this.snapshot();
        if (snap.manifest.commitId === lastCommitId) {
          this.trace?.(`attempt ${attempt}: ambiguous outcome resolved — our commit landed`);
          return finish(snap.manifest.version);
        }
      }
    }

    stats.ms = Date.now() - started;
    throw new ConflictError(maxAttempts);
  }

  /**
   * Append rows as one new chunk. Appends are disjoint by construction,
   * so conflicts always resolve by rebase (never re-execution).
   */
  insert(table: string, rows: Row[], opts?: { maxAttempts?: number }): Promise<CommitResult> {
    return this.commit(async () => {
      const ref = await this.stageChunk(table, rows);
      return {
        apply: (m) => {
          const t = m.tables[table];
          if (!t) return null;
          t.chunks.push(ref);
          return m;
        },
      };
    }, opts);
  }

  /**
   * Read-modify-write of one row by id — the Design §5 chunk-replacement path:
   * the chunk holding the row is retired and a rewritten copy staged in its
   * place (updates and deletes never modify a chunk). mutate returning null
   * deletes the row; a chunk left empty is dropped from the manifest.
   * Concurrent mutations of rows in the same chunk overlap and force the
   * re-execution path — the classic lost-update scenario.
   */
  mutateRow(
    table: string,
    id: string,
    mutate: (row: Row) => Row | null,
    opts?: { maxAttempts?: number },
  ): Promise<CommitResult> {
    return this.commit(async (snap) => {
      const refs = snap.manifest.tables[table]?.chunks ?? [];
      let retired: ChunkRef | undefined;
      let oldRows: Row[] | undefined;
      for (const ref of refs) {
        const rows = await this.readChunk(ref);
        if (rows.some((r) => r.id === id)) {
          retired = ref;
          oldRows = rows;
          break;
        }
      }
      if (!retired || !oldRows) throw new RowNotFoundError(table, id);

      const next = mutate(oldRows.find((r) => r.id === id) as Row);
      const newRows =
        next === null ? oldRows.filter((r) => r.id !== id) : oldRows.map((r) => (r.id === id ? next : r));
      const replacement = newRows.length > 0 ? await this.stageChunk(table, newRows) : null;

      return {
        apply: (m) => {
          const t = m.tables[table];
          const idx = t?.chunks.findIndex((c) => c.id === retired.id) ?? -1;
          if (!t || idx < 0) return null; // chunk was replaced underneath us — re-execute
          if (replacement) t.chunks[idx] = replacement;
          else t.chunks.splice(idx, 1);
          return m;
        },
      };
    }, opts);
  }

  /** Increment a counter row's value — a mutateRow convenience used by the stress harness. */
  increment(table: string, by = 1, opts?: { maxAttempts?: number }): Promise<CommitResult> {
    return this.mutateRow(table, "main", (row) => ({ ...row, value: Number(row.value) + by }), opts);
  }

  /** Fetch a retained past manifest (time travel). Null when outside retention
   * or when the history write for that commit was lost (they are best-effort). */
  async historyManifest(version: number): Promise<Manifest | null> {
    const res = await this.store.get(`${this.prefix}history/manifest.v${version}.json`);
    return res ? (JSON.parse(res.body) as Manifest) : null;
  }

  /** Delete every blob under this database's prefix. */
  async destroy(): Promise<void> {
    const paths = await this.store.list(this.prefix);
    await this.store.del(paths);
  }
}
