import { ConflictError, LarvaProto, Row, RowNotFoundError, ulid } from "./core";
import { VercelBlobAdapter } from "./storage";
import type { Check } from "./stress";

/**
 * Property-based conflict test (Design §14): concurrent writers run random
 * workloads — inserts, updates, and deletes of their own rows plus
 * read-modify-writes of one shared "hot" row — and the final database state is
 * checked against a per-writer sequential model.
 *
 * Loud commit failures (ConflictError after retries) are treated as AMBIGUOUS:
 * the commit may still have landed. Every op stamps its rows with a unique
 * opId and the hot row carries per-writer contribution counters, so the oracle
 * verifies exactly where histories are fully confirmed and by bounds where
 * they are not.
 */

export interface PropertyConfig {
  writers: number;
  opsPerWriter: number;
  maxAttempts: number;
  cleanup: boolean;
}

export const PROPERTY_DEFAULTS: PropertyConfig = {
  writers: 8,
  opsPerWriter: 25,
  maxAttempts: 60,
  cleanup: true,
};

type OpKind = "insert" | "update" | "delete" | "hot";
type Outcome = "confirmed" | "maybe" | "skipped";

interface Op {
  opId: string;
  kind: OpKind;
  writer: number;
  /** ids touched in the `rows` table (empty for hot ops) */
  ids: string[];
  outcome: Outcome;
  version: number | null;
  attempts: number;
}

export interface PropertyReport {
  runId: string;
  config: PropertyConfig;
  pass: boolean;
  checks: Check[];
  ops: Record<OpKind, number>;
  outcomes: Record<Outcome, number>;
  durationMs: number;
  commitsPerSec: number;
}

const randInt = (n: number) => Math.floor(Math.random() * n);

export async function runProperty(
  overrides: Partial<PropertyConfig> = {},
  log: (msg: string) => void = () => {},
): Promise<PropertyReport> {
  const config: PropertyConfig = { ...PROPERTY_DEFAULTS, ...overrides };
  const runId = ulid();
  const prefix = `property/${runId}/`;
  const db = new LarvaProto(new VercelBlobAdapter(), prefix);

  log(`run ${runId}: init db at ${prefix}`);
  await db.init(["rows", "hot"]);
  const hotSeed: Row = { id: "main", rev: 0 };
  for (let w = 0; w < config.writers; w++) hotSeed[`w${w}`] = 0;
  await db.insert("hot", [hotSeed]);

  const started = Date.now();
  const allOps: Op[] = [];
  let done = 0;
  const total = config.writers * config.opsPerWriter;

  const writerLoop = async (w: number): Promise<void> => {
    // ids this writer believes are live (reconciled when evidence says otherwise)
    const live: string[] = [];
    for (let i = 0; i < config.opsPerWriter; i++) {
      const roll = Math.random();
      const kind: OpKind =
        live.length === 0 || roll < 0.4 ? "insert" : roll < 0.65 ? "update" : roll < 0.8 ? "delete" : "hot";
      const opId = ulid();
      const op: Op = { opId, kind, writer: w, ids: [], outcome: "confirmed", version: null, attempts: 0 };

      try {
        if (kind === "insert") {
          const n = 1 + randInt(3);
          op.ids = Array.from({ length: n }, () => ulid());
          const res = await db.insert(
            "rows",
            op.ids.map((id): Row => ({ id, writer: w, rev: 0, lastOp: opId })),
            { maxAttempts: config.maxAttempts },
          );
          op.version = res.version;
          op.attempts = res.stats.attempts;
          live.push(...op.ids);
        } else if (kind === "update" || kind === "delete") {
          const id = live[randInt(live.length)];
          op.ids = [id];
          const res = await db.mutateRow(
            "rows",
            id,
            kind === "update"
              ? (row) => ({ ...row, rev: Number(row.rev) + 1, lastOp: opId, payload: randInt(1e9) })
              : () => null,
            { maxAttempts: config.maxAttempts },
          );
          op.version = res.version;
          op.attempts = res.stats.attempts;
          if (kind === "delete") live.splice(live.indexOf(id), 1);
        } else {
          const res = await db.mutateRow(
            "hot",
            "main",
            (row) => ({ ...row, rev: Number(row.rev) + 1, [`w${w}`]: Number(row[`w${w}`]) + 1, lastOp: opId }),
            { maxAttempts: config.maxAttempts },
          );
          op.version = res.version;
          op.attempts = res.stats.attempts;
        }
      } catch (err) {
        if (err instanceof ConflictError) {
          op.outcome = "maybe"; // may or may not have landed — the oracle tolerates both
          if (kind === "delete") live.splice(live.indexOf(op.ids[0]), 1); // stop touching it either way
        } else if (err instanceof RowNotFoundError) {
          // evidence that an earlier "maybe" delete of this id actually landed
          op.outcome = "skipped";
          live.splice(live.indexOf(op.ids[0]), 1);
        } else {
          throw err;
        }
      }
      allOps.push(op);
      done++;
      if (done % 25 === 0) log(`${done}/${total} ops done`);
    }
  };

  await Promise.all(Array.from({ length: config.writers }, (_, w) => writerLoop(w)));
  const durationMs = Date.now() - started;

  log("verifying final state against the model...");
  const snap = await db.snapshot();
  const finalRows = await db.readTable("rows", snap);
  const [hot] = await db.readTable("hot", snap);

  const checks: Check[] = [];
  const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
  const confirmed = allOps.filter((o) => o.outcome === "confirmed");
  const maybes = allOps.filter((o) => o.outcome === "maybe");

  // --- global row-identity invariants ---
  const byId = new Map<string, Row[]>();
  for (const row of finalRows) {
    const id = String(row.id);
    byId.set(id, [...(byId.get(id) ?? []), row]);
  }
  const dups = [...byId].filter(([, rows]) => rows.length > 1);
  check("no duplicate row ids", dups.length === 0, dups.length === 0 ? `${byId.size} distinct ids` : `${dups.length} duplicated`);

  const issuedIds = new Map<string, number>(); // id -> owning writer
  for (const op of allOps) if (op.kind === "insert") for (const id of op.ids) issuedIds.set(id, op.writer);
  const phantoms = [...byId.keys()].filter((id) => !issuedIds.has(id));
  check("no phantom rows", phantoms.length === 0, phantoms.length === 0 ? "every row traces to an issued insert" : `${phantoms.length} phantoms`);

  // --- per-id history check ---
  // Ops on one id are sequential (single owner), so the final state must be the
  // state after some op at or beyond the last confirmed one.
  const opsById = new Map<string, Op[]>();
  for (const op of allOps) {
    if (op.kind === "hot" || op.outcome === "skipped") continue;
    for (const id of op.ids) opsById.set(id, [...(opsById.get(id) ?? []), op]);
  }
  let idViolations = 0;
  let strictIds = 0;
  const violationDetails: string[] = [];
  for (const [id, ops] of opsById) {
    const lastConfirmed = ops.reduce((acc, op, i) => (op.outcome === "confirmed" ? i : acc), -1);
    const observed = byId.get(id)?.[0];
    const allConfirmed = lastConfirmed === ops.length - 1;
    if (allConfirmed) strictIds++;
    // candidate terminal ops: the last confirmed one, plus every trailing maybe
    const candidates = ops.slice(Math.max(lastConfirmed, 0));
    const validAbsent =
      candidates.some((op) => op.kind === "delete") || (lastConfirmed === -1 && ops[0].kind === "insert");
    const validPresent = new Set(
      candidates.filter((op) => op.kind !== "delete").map((op) => op.opId),
    );
    const ok = observed === undefined ? validAbsent : validPresent.has(String(observed.lastOp));
    if (!ok) {
      idViolations++;
      if (violationDetails.length < 3) {
        violationDetails.push(
          `id ${id}: observed lastOp=${observed ? String(observed.lastOp) : "ABSENT"}, expected ${validAbsent ? "absent or " : ""}one of [${[...validPresent].join(", ")}]`,
        );
      }
    }
  }
  check(
    "every row matches its writer's sequential model",
    idViolations === 0,
    idViolations === 0
      ? `${opsById.size} ids verified (${strictIds} with fully-confirmed histories)`
      : `${idViolations} violations: ${violationDetails.join(" | ")}`,
  );

  // --- commit atomicity: an ambiguous multi-row insert lands whole or not at all ---
  const tornInserts = maybes.filter(
    (op) => op.kind === "insert" && op.ids.length > 1 && new Set(op.ids.map((id) => byId.has(id))).size > 1,
  );
  check(
    "no torn multi-row inserts",
    tornInserts.length === 0,
    tornInserts.length === 0 ? `${maybes.length} ambiguous commits, none torn` : `${tornInserts.length} torn`,
  );

  // --- hot-row accounting (cross-writer lost-update detection) ---
  const contributions = Array.from({ length: config.writers }, (_, w) => Number(hot?.[`w${w}`] ?? NaN));
  const revOk = Number(hot?.rev) === contributions.reduce((a, b) => a + b, 0);
  check(
    "hot row rev == sum of per-writer contributions",
    revOk,
    `rev=${Number(hot?.rev)}, sum=${contributions.reduce((a, b) => a + b, 0)}`,
  );
  let hotViolations = 0;
  for (let w = 0; w < config.writers; w++) {
    const c = allOps.filter((o) => o.kind === "hot" && o.writer === w && o.outcome === "confirmed").length;
    const m = allOps.filter((o) => o.kind === "hot" && o.writer === w && o.outcome === "maybe").length;
    if (contributions[w] < c || contributions[w] > c + m) hotViolations++;
  }
  check(
    "per-writer hot contributions within [confirmed, confirmed+ambiguous]",
    hotViolations === 0,
    hotViolations === 0 ? `${config.writers} writers consistent` : `${hotViolations} writers out of bounds`,
  );

  // --- version arithmetic ---
  const versions = confirmed.map((o) => o.version as number);
  check(
    "confirmed commit versions all distinct",
    new Set(versions).size === versions.length,
    `${versions.length} confirmed commits, ${new Set(versions).size} distinct versions`,
  );
  const base = 1; // init + hot seed
  const lo = base + confirmed.length;
  const hi = base + confirmed.length + maybes.length;
  check(
    "manifest version within [base+confirmed, base+confirmed+ambiguous]",
    snap.manifest.version >= lo && snap.manifest.version <= hi,
    `version=${snap.manifest.version}, bounds=[${lo}, ${hi}]`,
  );

  const pass = checks.every((c) => c.pass);
  const count = (kind: OpKind) => allOps.filter((o) => o.kind === kind).length;
  const outcomeCount = (o: Outcome) => allOps.filter((op) => op.outcome === o).length;

  if (config.cleanup && pass) {
    log("cleaning up run blobs...");
    await db.destroy();
  } else if (!pass) {
    log(`FAILED — keeping blobs at ${prefix} for inspection`);
  }

  return {
    runId,
    config,
    pass,
    checks,
    ops: { insert: count("insert"), update: count("update"), delete: count("delete"), hot: count("hot") },
    outcomes: { confirmed: outcomeCount("confirmed"), maybe: outcomeCount("maybe"), skipped: outcomeCount("skipped") },
    durationMs,
    commitsPerSec: Number((confirmed.length / (durationMs / 1000)).toFixed(2)),
  };
}
