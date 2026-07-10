import { AsyncLocalStorage } from "node:async_hooks";

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

/** Highest on-store format this client can read and write. A manifest
 * declaring a newer version is refused loudly (FormatError) — never opened.
 *
 * Format history:
 *   1 — original layout: manifest + chunks + history.
 *   2 — v2 schema features: sequence columns (CAS-claimed ranges in a
 *       sequences blob), composite unique constraints, and auto-UUID columns
 *       (t.uuid(), writer-generated UUIDv7 — older writers would silently
 *       insert NULL instead). A store only declares 2 when its schema
 *       actually uses one of them, so plain stores stay readable by
 *       format-1 clients.
 *   3 — the ordered commit log: commits are create-only numbered entries
 *       under log/ (slot number = version); manifest.json is demoted to a
 *       periodic checkpoint that snapshots replay the log tail onto. Entered
 *       only by explicit db.upgrade() or larva({ commitLog: true }).
 *   4 — two-tier writes (Design §6): per-writer intent queues under queue/
 *       plus a compactor lease. Constraint-free appends are durable at one
 *       create-only PUT and folded into the log later; log entries may carry
 *       fold metadata. Requires the log; entered by db.upgrade() (and
 *       larva({ commitLog: true }) births new stores here).
 *
 * Note: formatVersion >= 3 is also how clients detect log mode, so a
 * CAS-mode store can only ever declare 1 or 2 — new schema-level features
 * must extend format 2's meaning, and new storage-protocol levels stack
 * above 3. */
export const SUPPORTED_FORMAT_VERSION = 4;

/** The lowest format a store with this schema can declare. Kept minimal so
 * stores that don't use v2 features remain openable by older clients. */
export function requiredFormatVersion(schema: unknown): number {
  const s = (schema ?? {}) as import("./schema").DatabaseSchema;
  for (const table of Object.values(s)) {
    if (table.uniques?.length) return 2;
    for (const col of Object.values(table.columns ?? {})) if (col.sequence || col.uuid) return 2;
  }
  return 1;
}

export interface Manifest {
  formatVersion: number;
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

/**
 * One commit in a format-3 store: the delta between consecutive manifest
 * versions, written create-only to log/<version>.json. The slot number IS the
 * version — two writers racing the same slot resolve by create-only PUT, and
 * the loser rebases by replaying the winner's entry (no manifest rewrite).
 */
export interface LogEntry {
  version: number;
  commitId: string;
  committedAt: string;
  /** Present only when the commit changed the schema. */
  schema?: unknown;
  /** Present only when the commit raised the store's format. */
  formatVersion?: number;
  /** Per-table chunk delta; null drops the table; an entry with empty
   * add/remove creates it. Untouched tables are absent. */
  tables: Record<string, { add: ChunkRef[]; remove: string[] } | null>;
  /** Intent ids folded into this commit (format 4). Metadata only: writers
   * use it to clear pending overlays and vacuum uses it to sweep processed
   * intent blobs; replay ignores it. */
  folds?: string[];
}

/** One durable-at-PUT append awaiting fold into the log (format 4). Rows are
 * fully validated and id-filled before the intent is written, so its outcome
 * is client-determined — which is exactly what makes early ack honest. */
export interface AppendIntent {
  kind: "append";
  id: string;
  writerId: string;
  createdAt: string;
  tables: Record<string, Row[]>;
}

/** Delta between two manifests (base → next) in LogEntry form. */
function diffManifests(base: Manifest, next: Manifest): LogEntry["tables"] {
  const out: LogEntry["tables"] = {};
  for (const [t, tbl] of Object.entries(next.tables)) {
    const baseTbl = base.tables[t];
    const baseIds = new Set((baseTbl?.chunks ?? []).map((c) => c.id));
    const nextIds = new Set(tbl.chunks.map((c) => c.id));
    const add = tbl.chunks.filter((c) => !baseIds.has(c.id));
    const remove = (baseTbl?.chunks ?? []).filter((c) => !nextIds.has(c.id)).map((c) => c.id);
    if (add.length || remove.length || !baseTbl) out[t] = { add, remove };
  }
  for (const t of Object.keys(base.tables)) if (!next.tables[t]) out[t] = null;
  return out;
}

/** Replay one log entry onto a manifest, in place. Replacement chunks land at
 * the end of the table's list — chunk order is not semantic (rows are sorted
 * within chunks; queries sort explicitly). */
function applyLogEntry(m: Manifest, e: LogEntry): void {
  for (const [t, d] of Object.entries(e.tables)) {
    if (d === null) {
      delete m.tables[t];
      continue;
    }
    const tbl = (m.tables[t] ??= { chunks: [] });
    if (d.remove.length > 0) {
      const gone = new Set(d.remove);
      tbl.chunks = tbl.chunks.filter((c) => !gone.has(c.id));
    }
    tbl.chunks.push(...d.add);
  }
  if (e.schema !== undefined) m.schema = e.schema;
  if (e.formatVersion !== undefined) m.formatVersion = e.formatVersion;
  m.version = e.version;
  m.commitId = e.commitId;
  m.committedAt = e.committedAt;
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
  /** How many queued commits this CAS carried (group commit). Absent when the
   * commit went to storage alone. */
  coalesced?: number;
}

export interface CommitResult {
  version: number;
  stats: CommitStats;
}

/** The store's format is newer than this client understands. Refusing loudly
 * is what protects no-lost-writes during mixed-version rollouts: a writer that
 * ignored this would commit through the old protocol and silently drop other
 * writers' commits made through the new one. */
export class FormatError extends Error {
  constructor(found: number) {
    super(
      `FORMAT_UNSUPPORTED: this database uses format version ${found}; this client ` +
        `supports up to ${SUPPORTED_FORMAT_VERSION} — upgrade with \`npm install @larva-db/core@latest\``,
    );
    this.name = "FormatError";
  }
}

function parseManifest(body: string): Manifest {
  const m = JSON.parse(body) as Manifest;
  if ((m.formatVersion ?? 1) > SUPPORTED_FORMAT_VERSION) throw new FormatError(m.formatVersion);
  return m;
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
  /** Intent ids this commit folds (format 4, log mode only) — recorded on the
   * log entry so writers clear overlays and vacuum sweeps the blobs. */
  folds?: string[];
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

/** RFC 9562 UUIDv7: 48-bit unix-ms timestamp + random tail. Time-ordered like
 * a ULID (new rows cluster in chunk zone maps) but in the canonical UUID
 * format the wider ecosystem expects. Backs t.uuid() columns. */
export function uuidv7(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let ts = Date.now(); // > 2^32, so arithmetic — not 32-bit bitwise ops
  for (let i = 5; i >= 0; i--) {
    b[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  b[6] = 0x70 | (b[6] & 0x0f);
  b[8] = 0x80 | (b[8] & 0x3f);
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
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

/** Default commit retry budget. Measured at 40ms-latency storage: 5 attempts
 * loses ~17% of commits loudly at 10 mixed writers (33% on a hot counter);
 * 15 keeps loud failures out of ordinary contention while still failing fast
 * under deliberate hammering (the stress harness uses 50). */
const DEFAULT_MAX_ATTEMPTS = 15;

/** Sequence values claimed per CAS on the sequences blob. Larger = fewer
 * claims under load; smaller = smaller gaps on crash. */
const SEQ_RANGE_SIZE = 32;

/** In log mode, fold the log into a fresh manifest.json checkpoint (and a
 * retained history snapshot) every this-many versions. Smaller = shorter log
 * tails to replay on snapshot; larger = less checkpoint write amplification. */
const CHECKPOINT_EVERY = 8;

/** Fixed-width so log entries list in version order. */
const padVersion = (v: number): string => String(v).padStart(12, "0");

/** One queued commit awaiting the group-commit drain loop. */
interface QueuedCommit {
  plan: Planner;
  maxAttempts: number;
  resolve: (result: CommitResult) => void;
  reject: (err: unknown) => void;
}

/** Internal signal: every commit in a batch was rejected at planning time. */
class EmptyBatch extends Error {}

/** Tracks whether the current async context is inside a draining planner, so
 * a commit issued from within another commit's planner (e.g. db.sql inside a
 * transaction callback) bypasses the queue instead of deadlocking on it. */
const draining = new AsyncLocalStorage<boolean>();

/**
 * Prototype of the Larva storage engine: manifest + immutable chunks +
 * the Design §6 commit protocol (stage → CAS → rebase/re-execute/backoff).
 * No SQL layer — operations are direct (insert / increment / read).
 */
export class LarvaProto {
  private chunkCache = new Map<string, Row[]>();
  private commitQueue: QueuedCommit[] = [];
  private drainRunning = false;

  constructor(
    readonly store: StorageAdapter,
    /** Blob-path prefix this database lives under, e.g. "stress/01H.../". */
    readonly prefix: string,
    /** Optional per-attempt trace hook for debugging the commit loop. */
    private trace?: (msg: string) => void,
    private opts?: {
      /** Coalesce concurrent commits from this instance into one CAS (group
       * commit). LarvaDb enables it; off by default so the stress/property
       * harnesses keep exercising one CAS per commit. */
      groupCommit?: boolean;
    },
  ) {}

  private manifestPath(): string {
    return `${this.prefix}manifest.json`;
  }

  private logPath(version: number): string {
    return `${this.prefix}log/${padVersion(version)}.json`;
  }

  // ---------- format 4: per-writer intent queues + the compactor lease ----------

  /** Identity of this instance in the queue — its own contention-free prefix. */
  readonly writerId = ulid();
  private intentSeq = 0;
  /** Called with the fold lists of log entries as snapshots pass over them,
   * so LarvaDb can clear pending-intent overlays. */
  onFold?: (intentIds: string[]) => void;

  /** One create-only PUT: durable at return. The path never collides — the
   * writer prefix is ours alone and seq is monotonic per instance. */
  async putIntent(intent: AppendIntent): Promise<string> {
    const path = `${this.prefix}queue/${intent.writerId}/intent-${padVersion(this.intentSeq++)}.json`;
    await this.putCreateOnly(path, JSON.stringify(intent));
    return path;
  }

  /** Every pending intent in the store, all writers. Intent blobs are
   * immutable; they only ever disappear (fold cleanup / vacuum). */
  async listIntents(): Promise<{ path: string; intent: AppendIntent }[]> {
    const objects = await this.store.list(`${this.prefix}queue/`);
    const out: { path: string; intent: AppendIntent }[] = [];
    for (const o of objects) {
      if (!o.path.endsWith(".json")) continue;
      const res = await this.store.get(o.path, { fresh: true });
      if (res) out.push({ path: o.path, intent: JSON.parse(res.body) as AppendIntent });
    }
    return out;
  }

  /**
   * Try to become the compactor. The lease is a PERFORMANCE mechanism, never
   * a correctness one (Design §6): the log slot stays the sole arbiter, so a
   * split lease merely wastes work. TTL is local-clock based on purpose —
   * generous enough that skew only delays a steal.
   */
  async tryLease(ttlMs = 5_000): Promise<boolean> {
    const path = `${this.prefix}lease.json`;
    const body = JSON.stringify({ holder: this.writerId, expiresAt: new Date(Date.now() + ttlMs).toISOString() });
    try {
      const res = await this.store.get(path, { fresh: true });
      if (!res) {
        await this.store.put(path, body, { createOnly: true });
        return true;
      }
      const lease = JSON.parse(res.body) as { holder: string; expiresAt: string };
      if (lease.holder !== this.writerId && lease.expiresAt > new Date().toISOString()) return false;
      await this.store.put(path, body, { ifMatch: res.etag });
      return true;
    } catch (err) {
      if (err instanceof CasConflictError || isTransientStorageError(err)) return false;
      throw err;
    }
  }

  /** Best-effort: let the next writer elect immediately instead of waiting out the TTL. */
  async releaseLease(): Promise<void> {
    try {
      const res = await this.store.get(`${this.prefix}lease.json`, { fresh: true });
      if (!res) return;
      const lease = JSON.parse(res.body) as { holder: string };
      if (lease.holder === this.writerId) await this.store.del([`${this.prefix}lease.json`]);
    } catch {
      // expiry will free it
    }
  }

  /** Create the empty database. Fails if one already exists at this prefix. */
  async init(tables: string[], schema?: unknown, opts?: { commitLog?: boolean }): Promise<void> {
    const manifest: Manifest = {
      // commitLog births at the current top format: the log plus two-tier writes.
      formatVersion: opts?.commitLog ? SUPPORTED_FORMAT_VERSION : requiredFormatVersion(schema),
      version: 0,
      commitId: ulid(),
      committedAt: new Date().toISOString(),
      schema,
      tables: Object.fromEntries(tables.map((t) => [t, { chunks: [] }])),
    };
    await this.putCreateOnly(this.manifestPath(), JSON.stringify(manifest));
    if (opts?.commitLog) {
      // Retain v0 as the base-of-time checkpoint: once maybeCheckpoint
      // advances manifest.json, this is what lets manifestAt reconstruct
      // versions older than the first periodic checkpoint.
      await this.store
        .put(`${this.prefix}history/manifest.v0.json`, JSON.stringify(manifest), { createOnly: true })
        .catch(() => {});
    }
  }

  /** Log entries are immutable once created, so this cache can never be stale. */
  private logCache = new Map<number, LogEntry>();

  /** Read log entry `version`, or null if it does not exist (yet). The
   * existence probe is fetched fresh — a stale 404 would hide committed data. */
  async readLogEntry(version: number): Promise<LogEntry | null> {
    const cached = this.logCache.get(version);
    if (cached) return cached;
    const res = await this.store.get(this.logPath(version), { fresh: true });
    if (!res) return null;
    const entry = JSON.parse(res.body) as LogEntry;
    this.logCache.set(version, entry);
    return entry;
  }

  /**
   * Fetch the manifest fresh from origin. Pins a consistent snapshot.
   * Format 3: the manifest is a checkpoint — replay the log tail onto it.
   * The log has no gaps by construction (slot n+1 is only ever written by a
   * writer that observed slot n), so the first missing entry is the tip.
   */
  async snapshot(): Promise<Snapshot> {
    const res = await this.store.get(this.manifestPath(), { fresh: true });
    if (!res) throw new Error(`No manifest at ${this.manifestPath()} — call init() first`);
    const manifest = parseManifest(res.body);
    if ((manifest.formatVersion ?? 1) >= 3) {
      for (let v = manifest.version + 1; ; v++) {
        const entry = await this.readLogEntry(v);
        if (!entry) break;
        applyLogEntry(manifest, entry);
        if (entry.folds?.length) this.onFold?.(entry.folds);
      }
    }
    return { manifest, etag: res.etag };
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
    await this.putCreateOnly(path, JSON.stringify(rows));
    return { id, path, rows: rows.length, ...(stats ? { stats } : {}) };
  }

  /**
   * Create-only put with retry, for objects whose names are never reused
   * (ULID chunk paths, first manifest at a prefix). A conflict is either a
   * spurious in-flight rejection (retry) or our own earlier attempt having
   * landed (verify content, accept); transient errors retry — createOnly
   * makes re-sending safe.
   */
  private async putCreateOnly(path: string, body: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.store.put(path, body, { createOnly: true });
        return;
      } catch (err) {
        const conflict = err instanceof CasConflictError;
        if (!conflict && !isTransientStorageError(err)) throw err;
        if (conflict) {
          const existing = await this.store.get(path);
          if (existing?.body === body) return;
          if (existing) throw err; // genuinely taken by different content
        }
        if (attempt >= 6) throw err;
        await sleep(backoffMs(attempt));
      }
    }
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
   * Draw `count` values for a sequence (key "table.column"). Values come from
   * an in-memory range claimed via CAS on the sequences blob — off the
   * manifest hot path, so sequence draws never contend with commits. Ranges
   * are disjoint across processes (uniqueness by construction); a crash
   * strands the unclaimed remainder of a range (gaps, like Postgres).
   */
  claimSequence(key: string, count: number): Promise<number[]> {
    const run = this.seqLock.then(() => this.claimSequenceInner(key, count));
    this.seqLock = run.catch(() => {});
    return run;
  }

  private seqRanges = new Map<string, { next: number; end: number }>();
  private seqLock: Promise<unknown> = Promise.resolve();

  private async claimSequenceInner(key: string, count: number): Promise<number[]> {
    const out: number[] = [];
    let range = this.seqRanges.get(key);
    while (out.length < count) {
      if (!range || range.next >= range.end) {
        range = await this.claimRange(key, Math.max(SEQ_RANGE_SIZE, count - out.length));
        this.seqRanges.set(key, range);
      }
      while (range.next < range.end && out.length < count) out.push(range.next++);
    }
    return out;
  }

  private async claimRange(key: string, size: number): Promise<{ next: number; end: number }> {
    const path = `${this.prefix}sequences.json`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.store.get(path, { fresh: true });
      const counters = res ? (JSON.parse(res.body) as Record<string, number>) : {};
      const start = counters[key] ?? 1;
      const body = JSON.stringify({ ...counters, [key]: start + size });
      try {
        // A range is used only after a put observed to succeed, so duplicates
        // are impossible; an ambiguous outcome retries and strands the range.
        if (res) await this.store.put(path, body, { ifMatch: res.etag });
        else await this.store.put(path, body, { createOnly: true });
        return { next: start, end: start + size };
      } catch (err) {
        const conflict = err instanceof CasConflictError;
        if (!conflict && !isTransientStorageError(err)) throw err;
        if (attempt >= DEFAULT_MAX_ATTEMPTS) throw new ConflictError(attempt + 1);
        await sleep(backoffMs(attempt));
      }
    }
  }

  /**
   * The heart of the system — Design §6.
   * 1. Stage: planner writes new chunks against a pinned snapshot.
   * 2. Commit: CAS-swap the manifest on its ETag.
   * 3. Conflict: refetch; rebase if the plan still applies cleanly (disjoint
   *    change), otherwise re-execute the planner on the fresh snapshot.
   *    Jittered exponential backoff; after maxAttempts, throw ConflictError.
   *
   * With groupCommit enabled, concurrent calls from this instance coalesce:
   * commits queue while one is in flight, and the drain loop lands each queued
   * batch as a single CAS (planning each member against a virtual manifest
   * that includes the members before it, so a batch has transaction-like
   * internal consistency). Writers inside one instance then never contend
   * with each other — only with other instances.
   */
  commit(plan: Planner, opts?: { maxAttempts?: number }): Promise<CommitResult> {
    const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    // Nested commit (issued from inside a draining planner): bypass the queue,
    // which is busy running us — waiting on it would deadlock.
    if (!this.opts?.groupCommit || draining.getStore()) return this.commitAlone(plan, maxAttempts);
    return new Promise<CommitResult>((resolve, reject) => {
      this.commitQueue.push({ plan, maxAttempts, resolve, reject });
      void this.drainCommits();
    });
  }

  /** Serialize this instance's queued commits: one batch per CAS, FIFO. */
  private async drainCommits(): Promise<void> {
    if (this.drainRunning) return;
    this.drainRunning = true;
    try {
      while (this.commitQueue.length > 0) {
        const batch = this.commitQueue.splice(0);
        if (batch.length === 1) {
          const { plan, maxAttempts, resolve, reject } = batch[0];
          await draining.run(true, () => this.commitAlone(plan, maxAttempts)).then(resolve, reject);
        } else {
          await this.commitBatch(batch);
        }
      }
    } finally {
      this.drainRunning = false;
    }
  }

  /**
   * Land a batch of queued commits as one CAS. Members are planned in order,
   * each against a virtual manifest carrying the members before it, so
   * intra-batch effects are visible (a second INSERT of the same primary key
   * fails at planning exactly as it would have failed at commit). A member
   * whose planner throws is rejected alone; the rest of the batch proceeds.
   */
  private async commitBatch(batch: QueuedCommit[]): Promise<void> {
    const alive = new Set(batch);
    // Reassigned on every (re)planning pass; the apply below always chains the
    // latest pass's plans, and resolution uses it to know who actually landed.
    let planned: { member: QueuedCommit; plan: CommitPlan }[] = [];

    const combined: Planner = async (snap) => {
      planned = [];
      let virtual = snap.manifest;
      for (const member of [...alive]) {
        try {
          const plan = await member.plan({ manifest: virtual, etag: snap.etag });
          const next = plan.apply(structuredClone(virtual));
          if (next === null) throw new Error("batched plan does not apply to its own snapshot");
          virtual = next;
          planned.push({ member, plan });
        } catch (err) {
          alive.delete(member);
          member.reject(err);
        }
      }
      if (planned.length === 0) throw new EmptyBatch();
      const folds = planned.flatMap(({ plan }) => plan.folds ?? []);
      return {
        apply: (m) => {
          let cur: Manifest | null = m;
          for (const { plan } of planned) {
            cur = plan.apply(cur);
            if (cur === null) return null;
          }
          return cur;
        },
        ...(folds.length ? { folds } : {}),
      };
    };

    try {
      const maxAttempts = batch.reduce((acc, m) => Math.max(acc, m.maxAttempts), 1);
      const result = await draining.run(true, () => this.commitAlone(combined, maxAttempts));
      this.trace?.(`batch of ${planned.length} coalesced into v${result.version}`);
      for (const { member } of planned) {
        member.resolve({ ...result, stats: { ...result.stats, coalesced: planned.length } });
      }
    } catch (err) {
      if (err instanceof EmptyBatch) return; // every member already rejected individually
      for (const member of alive) member.reject(err);
    }
  }

  /** The CAS loop itself — one commit, alone, against storage. */
  private async commitAlone(plan: Planner, maxAttempts: number): Promise<CommitResult> {
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

    // Slot attempts are ~3× cheaper and faster than manifest-CAS attempts (a
    // tiny entry PUT + incremental refetch vs. a full manifest round-trip), so
    // the loud-failure budget calibrates per protocol: same wall-clock
    // patience, more of the cheap attempts. Measured at 40ms-latency storage:
    // 10 synchronized slot writers exhaust 15 but stay comfortably inside 45.
    const budget = (snap.manifest.formatVersion ?? 1) >= 3 ? maxAttempts * 3 : maxAttempts;

    let lastCommitId = "";
    for (let attempt = 1; attempt <= budget; attempt++) {
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
      // A commit that embeds a schema using v2 features raises the store's
      // format so pre-v2 clients refuse it instead of ignoring the features.
      next.formatVersion = Math.max(next.formatVersion ?? 1, requiredFormatVersion(next.schema));

      // The base snapshot's format picks the protocol. The commit that flips a
      // store to format 3 (upgrade) is itself the last manifest CAS; everything
      // after it goes through the log.
      const logMode = (snap.manifest.formatVersion ?? 1) >= 3;

      try {
        if (logMode) {
          // Slot protocol: the version number is the slot; create-only PUT is
          // the arbiter. Losing costs one tiny entry read + a retry at the
          // next slot — no manifest rewrite, staged chunks reused on rebase.
          const entry: LogEntry = {
            version: next.version,
            commitId: next.commitId,
            committedAt: next.committedAt,
            ...(JSON.stringify(snap.manifest.schema) !== JSON.stringify(next.schema) ? { schema: next.schema } : {}),
            ...(next.formatVersion !== snap.manifest.formatVersion ? { formatVersion: next.formatVersion } : {}),
            tables: diffManifests(snap.manifest, next),
            ...(current.folds?.length ? { folds: current.folds } : {}),
          };
          await this.store.put(this.logPath(next.version), JSON.stringify(entry), { createOnly: true });
          this.logCache.set(next.version, entry);
          this.trace?.(`attempt ${attempt}: OK slot v${next.version}`);
          void this.maybeCheckpoint(next, snap.etag); // best-effort, off the commit's latency
          return finish(next.version);
        }
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
        if (logMode) {
          // Slot entries are immutable, so ambiguity resolves by reading our
          // slot directly: our commitId there means we won it.
          const landed = await this.readLogEntry(next.version);
          if (landed?.commitId === next.commitId) {
            this.trace?.(`attempt ${attempt}: ambiguous outcome resolved — our slot landed`);
            void this.maybeCheckpoint(next, snap.etag);
            return finish(next.version);
          }
          // Same jittered backoff as the CAS path — the exponential spread is
          // the fairness mechanism (near-immediate retries starve slow
          // writers; measured: 10 synchronized writers exhaust 15 attempts).
          // The refetch, though, is incremental: replay the winners we just
          // read instead of re-pulling the checkpoint.
          if (attempt < budget) await sleep(backoffMs(attempt));
          snap = await this.advanceSnapshot(snap);
          continue;
        }
        if (attempt < budget) await sleep(backoffMs(attempt));
        snap = await this.snapshot();
        if (snap.manifest.commitId === lastCommitId) {
          this.trace?.(`attempt ${attempt}: ambiguous outcome resolved — our commit landed`);
          return finish(snap.manifest.version);
        }
      }
    }

    stats.ms = Date.now() - started;
    throw new ConflictError(budget);
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

  /**
   * Advance a snapshot by replaying log entries past its version — the cheap
   * refetch after losing a slot race. The winner's entry is already in the
   * cache (the landed-check read it), so this usually costs one 404 probe.
   */
  private async advanceSnapshot(snap: Snapshot): Promise<Snapshot> {
    const manifest = structuredClone(snap.manifest);
    for (let v = manifest.version + 1; ; v++) {
      const entry = await this.readLogEntry(v);
      if (!entry) break;
      applyLogEntry(manifest, entry);
      if (entry.folds?.length) this.onFold?.(entry.folds);
    }
    return { manifest, etag: snap.etag };
  }

  /**
   * Fold the log into a fresh checkpoint every CHECKPOINT_EVERY versions:
   * a retained history snapshot (sparse, for time travel) and an advanced
   * manifest.json (so snapshots replay a short tail). Both best-effort — a
   * missed checkpoint only lengthens replay; the ifMatch chain keeps
   * checkpoint advancement linear, so it can never regress.
   */
  private async maybeCheckpoint(next: Manifest, checkpointEtag: string): Promise<void> {
    if (next.version % CHECKPOINT_EVERY !== 0) return;
    await this.store
      .put(`${this.prefix}history/manifest.v${next.version}.json`, JSON.stringify(next), { createOnly: true })
      .catch(() => {});
    await this.store
      .put(this.manifestPath(), JSON.stringify(next), { ifMatch: checkpointEtag })
      .catch(() => {});
  }

  /** Fetch a retained past manifest (time travel). Null when outside retention
   * or when the history write for that commit was lost (they are best-effort). */
  async historyManifest(version: number): Promise<Manifest | null> {
    const res = await this.store.get(`${this.prefix}history/manifest.v${version}.json`);
    return res ? parseManifest(res.body) : null;
  }

  /**
   * Reconstruct the manifest at `version` (time travel). Format ≤2 stores
   * retain one history file per commit, so the exact lookup hits. Format 3
   * retains sparse checkpoints plus the log: walk down to the nearest
   * retained base at or below `version`, then replay entries up to it.
   * Null when outside retention or a needed entry has been vacuumed.
   */
  async manifestAt(version: number): Promise<Manifest | null> {
    const exact = await this.historyManifest(version);
    if (exact) return exact;

    const cur = await this.store.get(this.manifestPath(), { fresh: true });
    if (!cur) return null;
    const checkpoint = parseManifest(cur.body);
    if ((checkpoint.formatVersion ?? 1) < 3) return null;

    let base: Manifest | null = checkpoint.version <= version ? checkpoint : null;
    for (let m = version - 1, probes = 0; base === null && m >= 0 && probes < 4 * CHECKPOINT_EVERY; m--, probes++) {
      base = await this.historyManifest(m);
    }
    if (base === null) return null;

    for (let v = base.version + 1; v <= version; v++) {
      const entry = await this.readLogEntry(v);
      if (!entry) return null;
      applyLogEntry(base, entry);
    }
    return base.version === version ? base : null;
  }

  /** Delete every blob under this database's prefix. */
  async destroy(): Promise<void> {
    const objects = await this.store.list(this.prefix);
    await this.store.del(objects.map((o) => o.path));
  }
}
