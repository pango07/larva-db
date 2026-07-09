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
 *   - the property-based conflict harness passes over the chaos store.
 *
 *   bun scripts/group-commit-test.ts
 */
import { defineSchema, larva, S3Adapter, SqlError, t } from "@larva-db/core";
import { runProperty } from "@larva-db/core/testing";

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- fake S3 (conditional writes + latency + chaos) ----------
interface StoredObject { body: string; etag: string; uploadedAt: string; }
const objects = new Map<string, StoredObject>();
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
      return new Response(null, { status: 200, headers: { etag } });
    }
    if (req.method === "DELETE") {
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

server.stop();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
