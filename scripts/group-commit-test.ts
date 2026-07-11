/**
 * Group-commit + offline conflict-matrix test, no network or credentials.
 *
 * Runs against an in-process fake S3 (conditional writes honored, ~15ms
 * simulated latency, optional 409/500 chaos) and verifies:
 *   - concurrent writes through one LarvaDb instance coalesce into fewer CAS
 *     swaps than ops, with nothing lost;
 *   - a hot-counter workload stays exact under coalescing;
 *   - one failing member of a batch rejects alone without sinking the batch;
 *   - a same-batch duplicate primary key is caught at planning time;
 *   - a nested write inside a transaction callback does not deadlock the queue;
 *   - two LarvaDb instances contending on one database stay correct with
 *     chaos injection on;
 *   - the property-based conflict harness passes over the chaos store;
 *   - format 4 tier-A appends: durable at one PUT, overlay read-your-writes,
 *     fold visibility + cleanup, the ordered-write barrier, and idempotent
 *     re-folds after a simulated folder crash.
 *
 *   bun scripts/group-commit-test.ts
 */
import { defineSchema, larva, S3Adapter, SqlError, SUPPORTED_FORMAT_VERSION, t } from "@larva-db/core";
import { runProperty } from "@larva-db/core/testing";

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Folds are asynchronous by design (durable at ack, visible at fold) — wait
 * for the condition instead of guessing a fixed delay. */
const waitFor = async (cond: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(100);
  }
  return cond();
};

// ---------- fake S3 (conditional writes + latency + chaos) ----------
interface StoredObject { body: string; etag: string; uploadedAt: string; }
const objects = new Map<string, StoredObject>();
const qlog: string[] = [];
let etagCounter = 0;
let chaos = false;
const LATENCY = 15;

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    await sleep(LATENCY);
    const url = new URL(req.url);
    const [, bucket, ...rest] = url.pathname.split("/").map(decodeURIComponent);
    const key = rest.join("/");
    if (bucket !== "larva-test") return new Response("wrong bucket", { status: 404 });

    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const contents = [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, o]) => `<Contents><Key>${xmlEscape(k)}</Key><LastModified>${o.uploadedAt}</LastModified><ETag>${xmlEscape(o.etag)}</ETag></Contents>`)
        .join("");
      return new Response(
        `<?xml version="1.0"?><ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`,
        { headers: { "content-type": "application/xml" } },
      );
    }
    if (req.method === "GET") {
      if (chaos && Math.random() < 0.05) return new Response("injected chaos", { status: 500 });
      const obj = objects.get(key);
      if (!obj) return new Response("NoSuchKey", { status: 404 });
      return new Response(obj.body, { headers: { etag: obj.etag } });
    }
    if (req.method === "PUT") {
      const ifMatch = req.headers.get("if-match");
      const ifNoneMatch = req.headers.get("if-none-match");
      if (chaos && (ifMatch || ifNoneMatch) && Math.random() < 0.1) {
        return new Response("<Error><Code>ConditionalRequestConflict</Code></Error>", { status: 409 });
      }
      const existing = objects.get(key);
      if (ifMatch && (!existing || existing.etag !== ifMatch)) return new Response("PreconditionFailed", { status: 412 });
      if (ifNoneMatch === "*" && existing) return new Response("PreconditionFailed", { status: 412 });
      const body = await req.text();
      const etag = `"fake-${++etagCounter}"`;
      objects.set(key, { body, etag, uploadedAt: new Date().toISOString() });
      if (key.includes("/queue/") || key.includes("/log/")) qlog.push(`PUT ${key} ${key.includes("/log/") ? (JSON.parse(body) as { folds?: string[] }).folds?.length ?? 0 : ""}`);
      return new Response(null, { status: 200, headers: { etag } });
    }
    if (req.method === "DELETE") {
      if (key.includes("/queue/")) qlog.push(`DEL ${key} ${objects.has(key) ? "hit" : "MISS"}`);
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response("nope", { status: 400 });
  },
});

const store = new S3Adapter({
  bucket: "larva-test",
  endpoint: `http://localhost:${server.port}`,
  region: "auto",
  accessKeyId: "AKIAFAKEFAKEFAKEFAKE",
  secretAccessKey: "fake/secret/for/contract/testing",
});

const schema = defineSchema({
  notes: { id: t.text().primaryKey(), body: t.text(), score: t.integer() },
});

// ---------- 1. concurrent inserts coalesce, nothing lost ----------
{
  const db = larva({ schema, prefix: "gc-insert/", store });
  await db.sql`INSERT INTO notes (id, body, score) VALUES (${"seed"}, ${"seed"}, ${0})`;
  const before = await db.currentVersion();
  const N = 12;
  await Promise.all(
    Array.from({ length: N }, (_, i) => db.sql`INSERT INTO notes (id, body, score) VALUES (${`row${i}`}, ${"x"}, ${i})`),
  );
  const after = await db.currentVersion();
  const rows = await db.sql`SELECT id FROM notes`;
  ok("concurrent inserts all present", rows.length === N + 1, `${rows.length}/${N + 1} rows`);
  ok("inserts coalesced into fewer CAS swaps than ops", after - before < N, `${after - before} version bumps for ${N} inserts`);
}

// ---------- 2. hot counter stays exact under coalescing ----------
{
  const db = larva({ schema, prefix: "gc-counter/", store });
  await db.sql`INSERT INTO notes (id, body, score) VALUES (${"ctr"}, ${"counter"}, ${0})`;
  const N = 15;
  await Promise.all(
    Array.from({ length: N }, () => db.sql`UPDATE notes SET score = score + 1 WHERE id = ${"ctr"}`),
  );
  const [ctr] = await db.sql`SELECT score FROM notes WHERE id = ${"ctr"}`;
  ok("hot counter equals concurrent increments", ctr.score === N, `score=${ctr.score}, expected ${N}`);
}

// ---------- 3. one failing batch member rejects alone ----------
{
  const db = larva({ schema, prefix: "gc-isolate/", store });
  await db.sql`INSERT INTO notes (id, body, score) VALUES (${"dup"}, ${"original"}, ${0})`;
  const results = await Promise.allSettled([
    db.sql`INSERT INTO notes (id, body, score) VALUES (${"a"}, ${"good"}, ${1})`,
    db.sql`INSERT INTO notes (id, body, score) VALUES (${"dup"}, ${"conflict"}, ${2})`,
    db.sql`INSERT INTO notes (id, body, score) VALUES (${"b"}, ${"good"}, ${3})`,
  ]);
  const dupResult = results[1];
  ok(
    "duplicate-pk member rejected with PRIMARY_KEY_CONFLICT",
    dupResult.status === "rejected" && dupResult.reason instanceof SqlError && dupResult.reason.code === "PRIMARY_KEY_CONFLICT",
    dupResult.status === "rejected" ? String(dupResult.reason) : "unexpectedly fulfilled",
  );
  ok(
    "healthy members of the same batch land",
    results[0].status === "fulfilled" && results[2].status === "fulfilled",
  );
  const rows = await db.sql`SELECT id, body FROM notes ORDER BY id`;
  const dupRow = rows.find((r) => r.id === "dup");
  ok("failed member left no trace", rows.length === 3 && dupRow?.body === "original", JSON.stringify(rows));
}

// ---------- 4. nested write inside a transaction does not deadlock ----------
{
  const db = larva({ schema, prefix: "gc-nested/", store });
  const nested = (async () => {
    await db.transaction(async (tx) => {
      await db.sql`INSERT INTO notes (id, body, score) VALUES (${"inner"}, ${"nested standalone write"}, ${0})`;
      await tx.sql`INSERT INTO notes (id, body, score) VALUES (${"outer"}, ${"transaction write"}, ${0})`;
    });
    return "done";
  })();
  const outcome = await Promise.race([nested, sleep(30_000).then(() => "deadlock")]);
  ok("nested standalone write inside transaction completes", outcome === "done");
  if (outcome === "done") {
    const rows = await db.sql`SELECT id FROM notes ORDER BY id`;
    ok("both nested and transaction rows present", rows.length === 2, JSON.stringify(rows));
  }
}

// ---------- 5. two instances contending, chaos on ----------
{
  chaos = true;
  const dbA = larva({ schema, prefix: "gc-multi/", store });
  const dbB = larva({ schema, prefix: "gc-multi/", store });
  await dbA.sql`INSERT INTO notes (id, body, score) VALUES (${"ctr"}, ${"counter"}, ${0})`;

  const WRITERS_PER_DB = 4;
  const OPS = 5;
  let inserts = 0;
  let increments = 0;
  const writer = async (db: typeof dbA, name: string) => {
    for (let i = 0; i < OPS; i++) {
      if (i % 2 === 0) {
        await db.sql`INSERT INTO notes (id, body, score) VALUES (${`${name}-${i}`}, ${"w"}, ${i})`;
        inserts++;
      } else {
        await db.sql`UPDATE notes SET score = score + 1 WHERE id = ${"ctr"}`;
        increments++;
      }
    }
  };
  await Promise.all([
    ...Array.from({ length: WRITERS_PER_DB }, (_, w) => writer(dbA, `a${w}`)),
    ...Array.from({ length: WRITERS_PER_DB }, (_, w) => writer(dbB, `b${w}`)),
  ]);
  const rows = await dbA.sql`SELECT id, score FROM notes`;
  const ctr = rows.find((r) => r.id === "ctr");
  ok("cross-instance appends all present under chaos", rows.length === inserts + 1, `${rows.length - 1}/${inserts} rows`);
  ok("cross-instance counter exact under chaos", ctr?.score === increments, `score=${ctr?.score}, expected ${increments}`);
  chaos = false;
}

// ---------- 6. property-based conflict matrix over the chaos store ----------
{
  chaos = true;
  console.log("\nrunning property harness over chaos store (6 writers × 15 ops)...");
  const report = await runProperty({ writers: 6, opsPerWriter: 15 }, () => {}, store);
  for (const c of report.checks) ok(`property: ${c.name}`, c.pass, c.detail);
  ok("property harness passed overall", report.pass);
  chaos = false;
}

// ---------- 7. format-version guard refuses newer stores ----------
{
  const db = larva({ schema, prefix: "gc-format/", store });
  await db.sql`INSERT INTO notes (id, body, score) VALUES (${"pre"}, ${"v1"}, ${0})`;
  const rows = await db.sql`SELECT id FROM notes`;
  ok("format guard: v1 store opens normally", rows.length === 1);

  // simulate a store already upgraded by a future client
  const stored = objects.get("gc-format/manifest.json")!;
  const future = { ...JSON.parse(stored.body), formatVersion: SUPPORTED_FORMAT_VERSION + 1 };
  objects.set("gc-format/manifest.json", { ...stored, body: JSON.stringify(future) });

  const err = await larva({ schema, prefix: "gc-format/", store })
    .sql`SELECT id FROM notes`.then(
      () => null,
      (e: unknown) => e as Error,
    );
  ok("format guard: newer store refused, nothing written", err?.name === "FormatError");
  ok(
    "format guard: error is machine-readable and says how to fix",
    (err?.message ?? "").startsWith("FORMAT_UNSUPPORTED:") && (err?.message ?? "").includes("npm install"),
    err?.message,
  );
}

// ---------- 8. v2 schema features: sequences + composite uniques ----------
{
  const v2schema = defineSchema(
    {
      invoices: { number: t.sequence().primaryKey(), writer: t.text() },
      grants: { id: t.text().primaryKey(), userId: t.text(), feature: t.text() },
    },
    { uniques: { grants: [["userId", "feature"]] } },
  );
  const dbA = larva({ schema: v2schema, prefix: "v2-seq/", store });
  await dbA.sql`SELECT COUNT(*) AS n FROM invoices`; // force init
  const dbB = larva({ schema: v2schema, prefix: "v2-seq/", store });

  // The marquee claim: two processes drawing from one sequence never collide,
  // because claimed ranges are disjoint by CAS construction.
  const N = 20;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      (i % 2 === 0 ? dbA : dbB).sql`INSERT INTO invoices (writer) VALUES (${i % 2 === 0 ? "a" : "b"})`,
    ),
  );
  const rows = await dbA.sql`SELECT number FROM invoices`;
  ok(
    "sequence numbers distinct across two instances",
    rows.length === N && new Set(rows.map((r) => r.number)).size === N && rows.every((r) => Number.isInteger(r.number)),
    `${new Set(rows.map((r) => r.number)).size}/${N} distinct`,
  );

  const stored = JSON.parse(objects.get("v2-seq/manifest.json")!.body) as { formatVersion: number };
  ok("store using v2 features declares formatVersion 2", stored.formatVersion === 2);
  const plain = JSON.parse(objects.get("gc-insert/manifest.json")!.body) as { formatVersion: number };
  ok("plain store still declares formatVersion 1", plain.formatVersion === 1);

  await dbA.sql`INSERT INTO grants (userId, feature) VALUES (${"u"}, ${"exports"})`;
  const err = await dbB.sql`INSERT INTO grants (userId, feature) VALUES (${"u"}, ${"exports"})`.then(
    () => null,
    (e: unknown) => e as SqlError,
  );
  ok("composite unique enforced across instances", err?.code === "UNIQUE_CONFLICT", err?.message);
}

// ---------- 8b. v2 schema features: t.uuid() auto IDs ----------
{
  const uuidSchema = defineSchema({
    orders: { id: t.uuid().primaryKey(), memo: t.text(), ref: t.uuid() },
  });
  const dbA = larva({ schema: uuidSchema, prefix: "v2-uuid/", store });
  await dbA.sql`SELECT COUNT(*) AS n FROM orders`; // force init
  const dbB = larva({ schema: uuidSchema, prefix: "v2-uuid/", store });

  // Contention-free identity: each writer invents its own IDs, so unlike
  // sequences there is no shared state to race on — only the format to check.
  const N = 20;
  await Promise.all(
    Array.from({ length: N }, (_, i) => (i % 2 === 0 ? dbA : dbB).sql`INSERT INTO orders (memo) VALUES (${`m${i}`})`),
  );
  const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const rows = await dbA.sql`SELECT id, ref FROM orders`;
  ok(
    "uuid pk auto-filled with RFC-format UUIDv7 on every insert",
    rows.length === N && rows.every((r) => typeof r.id === "string" && V7.test(r.id as string)),
  );
  ok("uuid values distinct across two instances", new Set(rows.map((r) => r.id)).size === N);
  ok(
    "non-pk uuid columns auto-fill too",
    rows.every((r) => typeof r.ref === "string" && V7.test(r.ref as string)) &&
      new Set(rows.map((r) => r.ref)).size === N,
  );

  const explicit = await dbA.sql`INSERT INTO orders (id, memo) VALUES (${"custom-id"}, ${"explicit"}) RETURNING id`;
  ok("an explicitly supplied id is respected, not overwritten", explicit[0].id === "custom-id");
  const returned = await dbB.sql`INSERT INTO orders (memo) VALUES (${"returned"}) RETURNING id`;
  ok("RETURNING hands back the generated uuid", V7.test(returned[0].id as string));

  const stored = JSON.parse(objects.get("v2-uuid/manifest.json")!.body) as { formatVersion: number };
  ok("store using t.uuid() declares formatVersion 2", stored.formatVersion === 2);
}

// ---------- 9. format 3: upgrade + the ordered commit log ----------
{
  // Born format 1, upgraded mid-life — the migration every existing store takes.
  const db = larva({ schema, prefix: "log-upgrade/", store });
  await db.sql`INSERT INTO notes (id, body, score) VALUES (${"pre"}, ${"before upgrade"}, ${1})`;
  const preVersion = await db.currentVersion();

  const up = await db.upgrade();
  ok("upgrade() flips to the top format", up.formatVersion === SUPPORTED_FORMAT_VERSION);
  ok("upgrade() is idempotent", (await db.upgrade()).version === up.version);

  await db.sql`INSERT INTO notes (id, body, score) VALUES (${"post"}, ${"after upgrade"}, ${2})`;
  const all = await db.sql`SELECT id FROM notes ORDER BY id`;
  ok("reads span the upgrade boundary", all.length === 2);
  ok(
    "post-upgrade commits are log entries, not manifest swaps",
    [...objects.keys()].some((k) => k.startsWith("log-upgrade/log/")),
  );

  // Time travel across the boundary, at log-entry granularity.
  const past = await db.asOf(preVersion);
  ok("asOf() reaches a pre-upgrade version", (await past.sql`SELECT COUNT(*) AS n FROM notes`)[0].n === 1);
  await db.rollbackTo(preVersion);
  const rolled = await db.sql`SELECT id FROM notes`;
  const raw = JSON.parse(objects.get("log-upgrade/manifest.json")!.body) as { formatVersion: number };
  ok("rollback across the boundary restores data", rolled.length === 1 && rolled[0].id === "pre");
  ok("rollback preserves the format version (never re-admits old writers)", raw.formatVersion === SUPPORTED_FORMAT_VERSION);
  const postRollback = await db.asOf((await db.currentVersion()) - 1);
  ok("the rollback itself is rollbackable", (await postRollback.sql`SELECT COUNT(*) AS n FROM notes`)[0].n === 2);
}

// ---------- 10. format 3 under load: cross-instance writers + chaos ----------
{
  chaos = true;
  const dbA = larva({ schema, prefix: "log-load/", store, commitLog: true });
  await dbA.sql`INSERT INTO notes (id, body, score) VALUES (${"ctr"}, ${"counter"}, ${0})`;
  const dbB = larva({ schema, prefix: "log-load/", store });

  const WRITERS_PER_DB = 4;
  const OPS = 5;
  let inserts = 0;
  let increments = 0;
  const writer = async (db: typeof dbA, name: string) => {
    for (let i = 0; i < OPS; i++) {
      if (i % 2 === 0) {
        await db.sql`INSERT INTO notes (id, body, score) VALUES (${`${name}-${i}`}, ${"w"}, ${i})`;
        inserts++;
      } else {
        await db.sql`UPDATE notes SET score = score + 1 WHERE id = ${"ctr"}`;
        increments++;
      }
    }
  };
  await Promise.all([
    ...Array.from({ length: WRITERS_PER_DB }, (_, w) => writer(dbA, `a${w}`)),
    ...Array.from({ length: WRITERS_PER_DB }, (_, w) => writer(dbB, `b${w}`)),
  ]);
  const rows = await dbA.sql`SELECT id, score FROM notes`;
  const ctr = rows.find((r) => r.id === "ctr");
  ok("log mode: cross-instance appends all present under chaos", rows.length === inserts + 1, `${rows.length - 1}/${inserts} rows`);
  ok("log mode: cross-instance counter exact under chaos", ctr?.score === increments, `score=${ctr?.score}, expected ${increments}`);

  const cp = JSON.parse(objects.get("log-load/manifest.json")!.body) as { version: number };
  const tip = await dbA.currentVersion();
  ok(
    "checkpoint advances behind the log tip",
    cp.version > 0 && cp.version % 8 === 0 && cp.version <= tip,
    `checkpoint v${cp.version}, tip v${tip}`,
  );
  chaos = false;
}

// ---------- 11. property-based conflict matrix over the log, chaos on ----------
{
  chaos = true;
  console.log("\nrunning property harness over the commit log + chaos store (6 writers × 15 ops)...");
  const report = await runProperty({ writers: 6, opsPerWriter: 15, commitLog: true }, () => {}, store);
  for (const c of report.checks) ok(`log property: ${c.name}`, c.pass, c.detail);
  ok("log property harness passed overall", report.pass);
  chaos = false;
}

// ---------- 12. format 4: tier-A appends — durable at one PUT ----------
{
  chaos = false;
  const f4schema = defineSchema({
    events: { id: t.uuid().primaryKey(), kind: t.text(), at: t.timestamp() },
    tickets: { num: t.sequence().primaryKey(), note: t.text() },
  });
  const dbA = larva({ schema: f4schema, prefix: "f4-append/", store, commitLog: true });
  await dbA.sql`SELECT COUNT(*) AS n FROM events`; // force init
  const born = JSON.parse(objects.get("f4-append/manifest.json")!.body) as { formatVersion: number };
  ok("commitLog:true births stores at the top format", born.formatVersion === SUPPORTED_FORMAT_VERSION);

  // The ack point: RETURNING resolves while the write is still only an intent.
  const [ev] = await dbA.sql`INSERT INTO events (kind, at) VALUES (${"signup"}, ${"2026-07-10T00:00:00Z"}) RETURNING id`;
  const queuedAtAck = [...objects.keys()].some((k) => k.startsWith("f4-append/queue/"));
  ok("append acks with a generated id while still queued (durable at one PUT)", queuedAtAck && typeof ev.id === "string");

  // Read-your-writes before the fold: the overlay feeds the scan, so filters
  // and aggregates treat pending rows exactly like chunk rows.
  const seen = await dbA.sql`SELECT COUNT(*) AS n FROM events WHERE kind = ${"signup"}`;
  ok("overlay read-your-writes: aggregate sees the un-folded append", seen[0].n === 1);

  // Folds are background work: wait for visibility instead of a fixed delay.
  const dbB = larva({ schema: f4schema, prefix: "f4-append/", store, commitLog: true });
  await waitFor(async () => (await dbB.sql`SELECT COUNT(*) AS n FROM events`)[0].n === 1);
  ok("cross-instance visibility after the fold", (await dbB.sql`SELECT COUNT(*) AS n FROM events`)[0].n === 1);
  await waitFor(async () => ![...objects.keys()].some((k) => k.startsWith("f4-append/queue/")));
  ok("folded intents are deleted from the queue", ![...objects.keys()].some((k) => k.startsWith("f4-append/queue/")));
  const foldEntry = [...objects.entries()].find(
    ([k, o]) => k.startsWith("f4-append/log/") && (JSON.parse(o.body) as { folds?: string[] }).folds?.length,
  );
  ok("the folding log entry records which intents it folded", foldEntry !== undefined);

  // An explicit pk means the outcome depends on ordering — never an append.
  await dbA.sql`INSERT INTO events (id, kind, at) VALUES (${"explicit-1"}, ${"import"}, ${"2026-07-10T00:00:00Z"})`;
  ok("explicit-pk INSERT takes the ordered path, not the queue", ![...objects.keys()].some((k) => k.startsWith("f4-append/queue/")));

  // A subquery in VALUES reads database state — not client-determined, so it
  // takes the ordered path too (only there does plan-time resolution run).
  const [sq] = await dbA.sql`INSERT INTO events (kind, at) VALUES ((SELECT kind FROM events WHERE id = ${"explicit-1"}), ${"2026-07-10T02:00:00Z"}) RETURNING kind`;
  ok(
    "subquery INSERT takes the ordered path and resolves",
    sq.kind === "import" && ![...objects.keys()].some((k) => k.startsWith("f4-append/queue/")),
    JSON.stringify(sq),
  );

  // A column added by runtime SQL ALTER is unknown to the code schema, so the
  // insert must skip tier A and validate against the live manifest schema.
  await dbA.sql`ALTER TABLE events ADD COLUMN src text`;
  const [withSrc] = await dbA.sql`INSERT INTO events (kind, at, src) VALUES (${"webhook"}, ${"2026-07-10T03:00:00Z"}, ${"stripe"}) RETURNING src`;
  ok("INSERT into a SQL-ALTERed column bypasses tier A and succeeds", withSrc.src === "stripe", JSON.stringify(withSrc));

  // Sequences stay unique across instances even when both sides append.
  const N = 10;
  await Promise.all(
    Array.from({ length: N }, (_, i) => (i % 2 ? dbA : dbB).sql`INSERT INTO tickets (note) VALUES (${`t${i}`})`),
  );
  // Two instances' folds serialize behind one lease — wait for both to land.
  await waitFor(async () => (await dbB.sql`SELECT num FROM tickets`).length === N);
  const nums = await dbB.sql`SELECT num FROM tickets`;
  ok(
    "appended sequence values distinct across two instances",
    nums.length === N && new Set(nums.map((r) => r.num)).size === N,
    `${new Set(nums.map((r) => r.num)).size}/${N} distinct`,
  );
  if (process.env.LARVA_DBG && (nums.length !== N || new Set(nums.map((r) => r.num)).size !== N)) {
    console.log("DBG rows:", JSON.stringify(nums.map((r) => r.num).sort((x, y) => Number(x) - Number(y))));
    console.log("DBG queue:", [...objects.keys()].filter((k) => k.startsWith("f4-append/queue/")));
    console.log("DBG qlog:\n" + qlog.filter((l) => l.includes("f4-append")).join("\n"));
    for (const [k, o] of objects.entries()) {
      if (!k.startsWith("f4-append/log/")) continue;
      const e = JSON.parse(o.body) as { version: number; folds?: string[]; tables: Record<string, { add: { rows: number; path: string }[]; remove: string[] } | null> };
      console.log(`DBG entry v${e.version}: folds=${e.folds?.length ?? 0}`, JSON.stringify(Object.entries(e.tables).map(([t, d]) => [t, d ? { add: d.add.map((c) => c.rows), rm: d.remove.length } : null])));
    }
    for (const [k, o] of objects.entries()) {
      if (k.startsWith("f4-append/tables/tickets/")) console.log(`DBG chunk ${k.slice(-20)}:`, JSON.stringify((JSON.parse(o.body) as { num: number }[]).map((r) => r.num)));
    }
  }

  // The ordered-write barrier: an UPDATE right after an append must see it.
  await dbA.sql`INSERT INTO events (kind, at) VALUES (${"pending"}, ${"2026-07-10T01:00:00Z"})`;
  await dbA.sql`UPDATE events SET kind = ${"processed"} WHERE kind = ${"pending"}`;
  const processed = await dbA.sql`SELECT COUNT(*) AS n FROM events WHERE kind = ${"processed"}`;
  ok("ordered writes fold pending appends first (the barrier)", processed[0].n === 1);
}

// ---------- 13. format 4: fold idempotence — a crashed folder re-folds harmlessly ----------
{
  const f4schema = defineSchema({ items: { id: t.uuid().primaryKey(), label: t.text() } });
  const db = larva({ schema: f4schema, prefix: "f4-refold/", store, commitLog: true });
  await db.sql`INSERT INTO items (label) VALUES (${"only-once"})`;
  await waitFor(async () => ![...objects.keys()].some((k) => k.startsWith("f4-refold/queue/"))); // fold + cleanup done

  // Simulate the crash window: the log entry landed but the intent blob
  // survived. Re-plant an identical intent and let the next fold find it.
  const rows = await db.sql`SELECT id, label FROM items`;
  const replant = {
    kind: "append",
    id: "01REPLANTEDINTENT0000000AA",
    writerId: "01CRASHEDWRITER0000000000A",
    createdAt: new Date().toISOString(),
    tables: { items: rows.map((r) => ({ id: r.id, label: r.label })) },
  };
  objects.set("f4-refold/queue/01CRASHEDWRITER0000000000A/intent-000000000000.json", {
    body: JSON.stringify(replant),
    etag: `"replant-${++etagCounter}"`,
    uploadedAt: new Date().toISOString(),
  });
  // Any new append triggers a fold, which must skip the replanted rows by pk.
  await db.sql`INSERT INTO items (label) VALUES (${"second"})`;
  await waitFor(async () => ![...objects.keys()].some((k) => k.startsWith("f4-refold/queue/")));
  const after = await db.sql`SELECT label FROM items ORDER BY label`;
  ok(
    "re-folding a crashed folder's intent adds no duplicate rows",
    after.length === 2 && after.filter((r) => r.label === "only-once").length === 1,
    JSON.stringify(after.map((r) => r.label)),
  );
  ok("the replanted intent was cleaned up by the healing fold", ![...objects.keys()].some((k) => k.startsWith("f4-refold/queue/")));
}

// ---------- 14. format 4 tier B: ordered intents, verdicts, leader batching ----------
{
  const f4schema = defineSchema({ counters: { id: t.text().primaryKey(), n: t.integer() } });
  const mk = () => larva({ schema: f4schema, prefix: "f4-ordered/", store, commitLog: true });
  const dbs = [mk(), mk(), mk()];
  const [dbA, dbB, dbC] = dbs;
  await dbA.sql`INSERT INTO counters (id, n) VALUES (${"hot"}, ${0})`;

  // Force queue mode (normally entered by the contention heuristic) so the
  // whole tier-B machinery runs deterministically.
  for (const db of dbs) (db as unknown as { queueUntil: number }).queueUntil = Date.now() + 120_000;

  const PER = 8;
  await Promise.all(
    dbs.flatMap((db) => Array.from({ length: PER }, () => db.sql`UPDATE counters SET n = n + 1 WHERE id = ${"hot"}`)),
  );
  const [hot] = await dbA.sql`SELECT n FROM counters WHERE id = ${"hot"}`;
  ok("queued hot counter exact across 3 instances", hot.n === 3 * PER, `n=${hot.n}, expected ${3 * PER}`);

  const verdictEntries = [...objects.entries()]
    .filter(([k]) => k.startsWith("f4-ordered/log/"))
    .map(([, o]) => JSON.parse(o.body) as { verdicts?: Record<string, unknown> })
    .filter((e) => e.verdicts);
  ok("verdicts are embedded in log entries", verdictEntries.length > 0, `${verdictEntries.length} verdict entries`);
  ok(
    "a leader batched several writers' intents into one slot",
    verdictEntries.some((e) => Object.keys(e.verdicts!).length > 1),
    `batch sizes: ${verdictEntries.map((e) => Object.keys(e.verdicts!).length).join(",")}`,
  );
  ok("the ordered queue drained after arbitration", ![...objects.keys()].some((k) => k.startsWith("f4-ordered/queue/")));

  // A failing statement becomes its verdict alone — the precise error travels
  // back to the writer that queued it, and batchmates are unaffected.
  const dup = await dbB.sql`INSERT INTO counters (id, n) VALUES (${"hot"}, ${9})`.then(
    () => null,
    (e: unknown) => e as SqlError,
  );
  ok("an error verdict propagates to the queued writer", dup?.code === "PRIMARY_KEY_CONFLICT", dup?.message);

  // Crashed-leader window: a verdict on record with the blob left behind.
  // Re-processing must treat it as cleanup, never as work (no double-apply).
  const planted = {
    kind: "ordered",
    id: "01CRASHEDORDEREDINTENT000A",
    writerId: "01ZOMBIEWRITER00000000000A",
    createdAt: new Date().toISOString(),
    baseVersion: 0,
    sql: "UPDATE counters SET n = n + 1 WHERE id = 'hot'",
    params: [],
  };
  const plantPath = "f4-ordered/queue/01ZOMBIEWRITER00000000000A/intent-000000000000.json";
  const plant = () =>
    objects.set(plantPath, { body: JSON.stringify(planted), etag: `"plant-${++etagCounter}"`, uploadedAt: new Date().toISOString() });

  plant();
  await dbC.sql`UPDATE counters SET n = n + 1 WHERE id = ${"hot"}`; // leader run executes the planted intent once
  const [afterFirst] = await dbC.sql`SELECT n FROM counters WHERE id = ${"hot"}`;
  ok("a planted ordered intent executes exactly once", afterFirst.n === 3 * PER + 2, `n=${afterFirst.n}`);

  plant(); // the same intent id again — its verdict is already in the log
  await dbC.sql`UPDATE counters SET n = n + 1 WHERE id = ${"hot"}`;
  const [afterSecond] = await dbC.sql`SELECT n FROM counters WHERE id = ${"hot"}`;
  ok(
    "a re-planted arbitrated intent is cleanup, not work (no double-apply)",
    afterSecond.n === 3 * PER + 3,
    `n=${afterSecond.n}, expected ${3 * PER + 3}`,
  );
  ok("the re-planted blob was swept", !objects.has(plantPath));
}

// ---------- 15. format 4 tier B: the contention heuristic escalates on its own ----------
{
  chaos = false;
  const f4schema = defineSchema({ counters: { id: t.text().primaryKey(), n: t.integer() } });
  const mk = () => larva({ schema: f4schema, prefix: "f4-escalate/", store, commitLog: true });
  const dbs = [mk(), mk(), mk(), mk()];
  await dbs[0].sql`INSERT INTO counters (id, n) VALUES (${"hot"}, ${0})`;
  const PER = 6;
  await Promise.all(
    dbs.flatMap((db) => Array.from({ length: PER }, () => db.sql`UPDATE counters SET n = n + 1 WHERE id = ${"hot"}`)),
  );
  const [hot] = await dbs[0].sql`SELECT n FROM counters WHERE id = ${"hot"}`;
  ok("hot counter exact with the heuristic free to escalate", hot.n === dbs.length * PER, `n=${hot.n}, expected ${dbs.length * PER}`);
  const escalated = dbs.some((db) => (db as unknown as { queueUntil: number }).queueUntil > 0);
  ok("cross-instance contention tripped the escalation heuristic", escalated);
}

// ---------- 16. secondary indexes: prune, maintain, degrade safely ----------
{
  chaos = false;
  const idxSchema = defineSchema({
    logs: { id: t.uuid().primaryKey(), region: t.text().index(), n: t.integer() },
  });
  const db = larva({ schema: idxSchema, prefix: "idx/", store, commitLog: true });
  const REGIONS = ["us", "eu", "ap", "sa"];
  // Explicit pks keep these on the ordered path: one chunk per statement,
  // so each region's rows land in their own chunk and pruning is observable.
  for (const [i, r] of REGIONS.entries()) {
    await db.sql`INSERT INTO logs (id, region, n) VALUES
      (${`${r}-1`}, ${r}, ${i * 10 + 1}), (${`${r}-2`}, ${r}, ${i * 10 + 2}), (${`${r}-3`}, ${r}, ${i * 10 + 3})`;
  }

  const eu = await db.sql`SELECT id FROM logs WHERE region = ${"eu"}`;
  let stats = db.lastQueryStats;
  ok("indexed equality prunes to the matching chunk", eu.length === 3 && stats.chunksFetched === 1 && stats.chunksTotal === 4, `fetched ${stats.chunksFetched}/${stats.chunksTotal}`);
  const inList = await db.sql`SELECT COUNT(*) AS c FROM logs WHERE region IN (${"us"}, ${"ap"})`;
  stats = db.lastQueryStats;
  ok("IN list prunes via the index", inList[0].c === 6 && stats.chunksFetched === 2, `fetched ${stats.chunksFetched}/${stats.chunksTotal}`);
  const range = await db.sql`SELECT COUNT(*) AS c FROM logs WHERE region BETWEEN ${"e"} AND ${"f"}`;
  stats = db.lastQueryStats;
  ok("range predicate prunes via the index", range[0].c === 3 && stats.chunksFetched === 1, `fetched ${stats.chunksFetched}/${stats.chunksTotal}`);

  // Maintenance: an UPDATE that moves a value re-points the index atomically.
  await db.sql`UPDATE logs SET region = ${"mars"} WHERE id = ${"eu-2"}`;
  const mars = await db.sql`SELECT id FROM logs WHERE region = ${"mars"}`;
  ok("update: moved value found through the index", mars.length === 1 && db.lastQueryStats.chunksFetched === 1);
  const euAfter = await db.sql`SELECT COUNT(*) AS c FROM logs WHERE region = ${"eu"}`;
  ok("update: the rewritten chunk is re-indexed", euAfter[0].c === 2);

  // A deleted chunk's entry goes with it — the lookup then touches nothing.
  await db.sql`DELETE FROM logs WHERE region = ${"sa"}`;
  const sa = await db.sql`SELECT COUNT(*) AS c FROM logs WHERE region = ${"sa"}`;
  ok("delete: zero chunks fetched for the vanished value", sa[0].c === 0 && db.lastQueryStats.chunksFetched === 0);

  // Staleness safety: a proto-level insert is exactly a pre-index client —
  // it adds a chunk without touching the index. Absent = always fetched.
  const proto = (db as unknown as { proto: { insert(table: string, rows: Record<string, string | number | boolean | null>[]): Promise<unknown> } }).proto;
  await proto.insert("logs", [{ id: "legacy-1", region: "eu", n: 99 }]);
  const euStale = await db.sql`SELECT id FROM logs WHERE region = ${"eu"}`;
  ok("a chunk unknown to the index is always fetched (stale-safe)", euStale.length === 3 && euStale.some((r) => r.id === "legacy-1"), JSON.stringify(euStale));

  // An open-ended range (`> z`) has no upper bound: the internal MAX marker
  // must be identity-checked, not compared — a value sorting above it would
  // otherwise be wrongly pruned out of the result.
  await db.sql`INSERT INTO logs (id, region, n) VALUES (${"weird-1"}, ${"￿￿￿￿beyond"}, ${0})`;
  const beyond = await db.sql`SELECT id FROM logs WHERE region > ${"z"}`;
  ok("open-ended range keeps values above the internal sentinel", beyond.length === 1 && beyond[0].id === "weird-1", JSON.stringify(beyond));

  // A missing blob (an older client's vacuum) degrades to a scan, never an error.
  const blobKeys = [...objects.keys()].filter((k) => k.startsWith("idx/tables/logs/index_"));
  for (const k of blobKeys) objects.delete(k);
  const db2 = larva({ schema: idxSchema, prefix: "idx/", store, commitLog: true }); // fresh instance — no warm index cache
  const degraded = await db2.sql`SELECT COUNT(*) AS c FROM logs WHERE region = ${"eu"}`;
  ok(
    "a vacuumed index blob degrades to a full scan, results intact",
    blobKeys.length > 0 && degraded[0].c === 3 && db2.lastQueryStats.chunksFetched === db2.lastQueryStats.chunksTotal,
    `fetched ${db2.lastQueryStats.chunksFetched}/${db2.lastQueryStats.chunksTotal}`,
  );

  // Connect syncs .index() flags both ways: dropped from code → dropped from
  // the store; added back → rebuilt with a backfill over existing chunks.
  const noIdxSchema = defineSchema({ logs: { id: t.uuid().primaryKey(), region: t.text(), n: t.integer() } });
  const db3 = larva({ schema: noIdxSchema, prefix: "idx/", store, commitLog: true });
  const scan = await db3.sql`SELECT COUNT(*) AS c FROM logs WHERE region = ${"eu"}`;
  ok("connect auto-drops an index removed from code", scan[0].c === 3 && db3.lastQueryStats.chunksFetched === db3.lastQueryStats.chunksTotal);
  const db4 = larva({ schema: idxSchema, prefix: "idx/", store, commitLog: true });
  const rebuilt = await db4.sql`SELECT COUNT(*) AS c FROM logs WHERE region = ${"eu"}`;
  ok(
    "connect auto-creates with backfill (covers pre-index chunks)",
    rebuilt[0].c === 3 && db4.lastQueryStats.chunksFetched < db4.lastQueryStats.chunksTotal,
    `fetched ${db4.lastQueryStats.chunksFetched}/${db4.lastQueryStats.chunksTotal}`,
  );

  // Tier-A appends are indexed at fold time.
  const dbA = larva({ schema: idxSchema, prefix: "idx3/", store, commitLog: true });
  await dbA.sql`INSERT INTO logs (region, n) VALUES (${"eu"}, ${1}), (${"us"}, ${2})`; // omitted pk → append path
  await waitFor(async () => ![...objects.keys()].some((k) => k.startsWith("idx3/queue/")));
  const foldBlobs = [...objects.entries()].filter(([k]) => k.startsWith("idx3/tables/logs/index_region_"));
  ok("the fold maintains indexes for appended rows", foldBlobs.length > 0 && foldBlobs.some(([, o]) => o.body.includes("eu")));

  // Under chaos + two contending writers, indexed lookups must match a full
  // scan exactly: index entries can only be wrong by ABSENCE (chunks fetched
  // anyway), never by content — chunk ids are never reused.
  chaos = true;
  const w1 = larva({ schema: idxSchema, prefix: "idx2/", store, commitLog: true });
  const w2 = larva({ schema: idxSchema, prefix: "idx2/", store, commitLog: true });
  await Promise.all(
    Array.from({ length: 12 }, (_, i) => (i % 2 ? w1 : w2).sql`INSERT INTO logs (id, region, n) VALUES (${`r${i}`}, ${REGIONS[i % 4]}, ${i})`),
  );
  chaos = false;
  const viaIndex = (await w1.sql`SELECT id FROM logs WHERE region = ${"eu"}`).map((r) => r.id).sort();
  const all = await w1.sql`SELECT id, region FROM logs`;
  const truth = all.filter((r) => r.region === "eu").map((r) => r.id).sort();
  ok(
    "indexed lookup matches the full scan after chaos + contention",
    truth.length === 3 && JSON.stringify(viaIndex) === JSON.stringify(truth),
    `index=${JSON.stringify(viaIndex)} truth=${JSON.stringify(truth)}`,
  );
}

server.stop();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
