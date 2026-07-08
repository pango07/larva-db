import { CommitStats, ConflictError, LarvaProto, Row, ulid } from "./core";
import { VercelBlobAdapter } from "./storage";

export interface StressConfig {
  writers: number;
  commitsPerWriter: number;
  rowsPerCommit: number;
  /** append = disjoint writes (rebase path); counter = overlapping writes
   * (re-execution path); mixed = even writers append, odd writers increment. */
  mode: "append" | "counter" | "mixed";
  maxAttempts: number;
  /** Delete the run's blobs afterwards. Failed runs are always kept for inspection. */
  cleanup: boolean;
}

export const DEFAULTS: StressConfig = {
  writers: 10,
  commitsPerWriter: 20,
  rowsPerCommit: 5,
  mode: "mixed",
  maxAttempts: 50,
  cleanup: true,
};

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface StressReport {
  runId: string;
  prefix: string;
  config: StressConfig;
  pass: boolean;
  checks: Check[];
  commits: {
    attempted: number;
    succeeded: number;
    failedLoudly: number;
    appendCommits: number;
    incrementCommits: number;
  };
  contention: {
    casConflicts: number;
    rebases: number;
    reExecutions: number;
    retriedCommits: number;
    maxAttemptsSeen: number;
    attemptsHistogram: Record<string, number>;
  };
  durationMs: number;
  commitsPerSec: number;
  errors: string[];
}

interface WriterOutcome {
  writer: number;
  seq: number;
  kind: "append" | "increment";
  version: number | null; // null = failed loudly
  stats: CommitStats | null;
  error?: string;
}

export async function runStress(
  overrides: Partial<StressConfig> = {},
  log: (msg: string) => void = () => {},
): Promise<StressReport> {
  const config: StressConfig = { ...DEFAULTS, ...overrides };
  const runId = ulid();
  const prefix = `stress/${runId}/`;
  const db = new LarvaProto(new VercelBlobAdapter(), prefix);

  log(`run ${runId}: init db at ${prefix}`);
  await db.init(["events", "counters"]);
  await db.insert("counters", [{ id: "main", value: 0 }]);
  const baseVersion = 1; // v0 init + v1 counter seed

  const writerKind = (w: number): "append" | "increment" =>
    config.mode === "append" ? "append" : config.mode === "counter" ? "increment" : w % 2 === 0 ? "append" : "increment";

  const started = Date.now();
  let done = 0;
  const total = config.writers * config.commitsPerWriter;

  const writerLoop = async (w: number): Promise<WriterOutcome[]> => {
    const kind = writerKind(w);
    const outcomes: WriterOutcome[] = [];
    for (let seq = 0; seq < config.commitsPerWriter; seq++) {
      const outcome: WriterOutcome = { writer: w, seq, kind, version: null, stats: null };
      try {
        const result =
          kind === "append"
            ? await db.insert(
                "events",
                Array.from({ length: config.rowsPerCommit }, (_, r): Row => ({
                  id: ulid(),
                  writer: w,
                  seq,
                  row: r,
                })),
                { maxAttempts: config.maxAttempts },
              )
            : await db.increment("counters", 1, { maxAttempts: config.maxAttempts });
        outcome.version = result.version;
        outcome.stats = result.stats;
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        outcome.error = err.message; // failed loudly — allowed, but must not have landed
      }
      outcomes.push(outcome);
      done++;
      if (done % 25 === 0) log(`${done}/${total} commits done`);
    }
    return outcomes;
  };

  const outcomes = (
    await Promise.all(Array.from({ length: config.writers }, (_, w) => writerLoop(w)))
  ).flat();
  const durationMs = Date.now() - started;

  // ---- Verification: read final state fresh and hunt for lost updates ----
  log("verifying final state...");
  const snap = await db.snapshot();
  const events = await db.readTable("events", snap);
  const counterRows = await db.readTable("counters", snap);

  const succeeded = outcomes.filter((o) => o.version !== null);
  const failed = outcomes.filter((o) => o.version === null);
  const appends = succeeded.filter((o) => o.kind === "append");
  const increments = succeeded.filter((o) => o.kind === "increment");

  const checks: Check[] = [];
  const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  // 1. Every successful append's rows are present exactly once; nothing extra.
  const expectedKeys = new Set(
    appends.flatMap((o) =>
      Array.from({ length: config.rowsPerCommit }, (_, r) => `${o.writer}:${o.seq}:${r}`),
    ),
  );
  const seenKeys = new Map<string, number>();
  for (const row of events) {
    const key = `${row.writer}:${row.seq}:${row.row}`;
    seenKeys.set(key, (seenKeys.get(key) ?? 0) + 1);
  }
  const missing = [...expectedKeys].filter((k) => !seenKeys.has(k));
  const duplicated = [...seenKeys].filter(([, n]) => n > 1).map(([k]) => k);
  const unexpected = [...seenKeys.keys()].filter((k) => !expectedKeys.has(k));
  check(
    "no lost appended rows",
    missing.length === 0,
    missing.length === 0 ? `${expectedKeys.size} rows all present` : `LOST ${missing.length}: ${missing.slice(0, 5).join(", ")}…`,
  );
  check(
    "no duplicated rows (double-applied commits)",
    duplicated.length === 0,
    duplicated.length === 0 ? "no duplicates" : `${duplicated.length} duplicated: ${duplicated.slice(0, 5).join(", ")}…`,
  );
  check(
    "no rows from failed commits",
    unexpected.length === 0,
    unexpected.length === 0 ? "none leaked" : `${unexpected.length} leaked: ${unexpected.slice(0, 5).join(", ")}…`,
  );

  // 2. Counter equals the number of successful increments (the lost-update test).
  const counterValue = Number(counterRows[0]?.value ?? NaN);
  check(
    "counter equals successful increments",
    counterValue === increments.length,
    `counter=${counterValue}, successful increments=${increments.length}` +
      (counterValue === increments.length ? "" : ` → ${increments.length - counterValue} LOST UPDATES`),
  );

  // 3. Manifest version arithmetic: exactly one bump per successful commit.
  const expectedVersion = baseVersion + succeeded.length;
  check(
    "manifest version == base + successful commits",
    snap.manifest.version === expectedVersion,
    `version=${snap.manifest.version}, expected=${expectedVersion}`,
  );

  // 4. Every successful commit got a unique version (no two swaps from one ETag).
  const versions = succeeded.map((o) => o.version as number);
  const uniqueVersions = new Set(versions);
  check(
    "commit versions all distinct",
    uniqueVersions.size === versions.length,
    `${versions.length} commits, ${uniqueVersions.size} distinct versions`,
  );

  // ---- Contention stats ----
  const stats = succeeded.map((o) => o.stats as CommitStats);
  const attemptsHistogram: Record<string, number> = {};
  for (const s of stats) {
    attemptsHistogram[String(s.attempts)] = (attemptsHistogram[String(s.attempts)] ?? 0) + 1;
  }
  const sum = (f: (s: CommitStats) => number) => stats.reduce((acc, s) => acc + f(s), 0);

  const pass = checks.every((c) => c.pass);
  const report: StressReport = {
    runId,
    prefix,
    config,
    pass,
    checks,
    commits: {
      attempted: outcomes.length,
      succeeded: succeeded.length,
      failedLoudly: failed.length,
      appendCommits: appends.length,
      incrementCommits: increments.length,
    },
    contention: {
      casConflicts: sum((s) => s.casConflicts),
      rebases: sum((s) => s.rebases),
      reExecutions: sum((s) => s.reExecutions),
      retriedCommits: stats.filter((s) => s.attempts > 1).length,
      maxAttemptsSeen: stats.reduce((acc, s) => Math.max(acc, s.attempts), 0),
      attemptsHistogram,
    },
    durationMs,
    commitsPerSec: Number((succeeded.length / (durationMs / 1000)).toFixed(2)),
    errors: failed.map((o) => `writer ${o.writer} seq ${o.seq}: ${o.error ?? "unknown"}`),
  };

  if (config.cleanup && pass) {
    log("cleaning up run blobs...");
    await db.destroy();
  } else if (!pass) {
    log(`FAILED — keeping blobs at ${prefix} for inspection`);
  }

  return report;
}
