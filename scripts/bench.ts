/**
 * Write-throughput benchmark: the commit protocol over an in-process fake S3
 * with simulated per-request latency, no network or credentials.
 *
 * Compares the same workload with writers spread across many LarvaDb
 * instances (every commit is its own CAS — the pre-group-commit worst case,
 * and the cross-function contention case) against writers sharing instances
 * (group commit coalesces concurrent commits into one CAS per batch).
 *
 *   bun scripts/bench.ts [--latency 40] [--writers 10] [--ops 20]
 */
import { defineSchema, larva, LarvaDb, S3Adapter, t, ulid } from "@larva-db/core";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}
const LATENCY = arg("latency", 40);
const WRITERS = arg("writers", 10);
const OPS = arg("ops", 20);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- fake S3 with per-request latency ----------
interface StoredObject { body: string; etag: string; uploadedAt: string; }
const objects = new Map<string, StoredObject>();
let etagCounter = 0;

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    await sleep(LATENCY + Math.random() * (LATENCY / 4));
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
      const obj = objects.get(key);
      if (!obj) return new Response("NoSuchKey", { status: 404 });
      return new Response(obj.body, { headers: { etag: obj.etag } });
    }
    if (req.method === "PUT") {
      const ifMatch = req.headers.get("if-match");
      const ifNoneMatch = req.headers.get("if-none-match");
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
  secretAccessKey: "fake/secret/for/benchmarking",
});

const schema = defineSchema({
  events: { id: t.text().primaryKey(), writer: t.integer(), seq: t.integer() },
  counters: { id: t.text().primaryKey(), value: t.integer() },
});

const percentile = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function scenario(label: string, instances: number, mode: "mixed" | "counter"): Promise<void> {
  const prefix = `bench/${ulid()}/`;
  const dbs: LarvaDb[] = Array.from({ length: instances }, () => larva({ schema, prefix, store }));
  await dbs[0].sql`INSERT INTO counters (id, value) VALUES (${"main"}, ${0})`;
  const versionBefore = await dbs[0].currentVersion();

  const latencies: number[] = [];
  let increments = 0;
  let inserts = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: WRITERS }, (_, w) => {
      const db = dbs[w % instances];
      const isAppend = mode === "mixed" && w % 2 === 0;
      return (async () => {
        for (let seq = 0; seq < OPS; seq++) {
          const t0 = performance.now();
          if (isAppend) {
            await db.sql`INSERT INTO events (writer, seq) VALUES (${w}, ${seq})`;
            inserts++;
          } else {
            await db.sql`UPDATE counters SET value = value + 1 WHERE id = ${"main"}`;
            increments++;
          }
          latencies.push(performance.now() - t0);
        }
      })();
    }),
  );
  const durationMs = performance.now() - started;
  const versionAfter = await dbs[0].currentVersion();

  const [ctr] = await dbs[0].sql`SELECT value FROM counters WHERE id = ${"main"}`;
  const events = await dbs[0].sql`SELECT id FROM events`;
  const verify = ctr.value === increments && events.length === inserts ? "OK" : `MISMATCH ctr=${ctr.value}/${increments} rows=${events.length}/${inserts}`;

  console.log(
    `${label.padEnd(42)} ${((WRITERS * OPS) / (durationMs / 1000)).toFixed(2).padStart(7)} ops/s  ` +
      `p50 ${percentile(latencies, 50).toFixed(0).padStart(5)}ms  p95 ${percentile(latencies, 95).toFixed(0).padStart(6)}ms  ` +
      `CAS swaps ${String(versionAfter - versionBefore).padStart(4)}/${WRITERS * OPS} ops  verify ${verify}`,
  );
}

console.log(`latency ${LATENCY}ms/request, ${WRITERS} writers × ${OPS} ops\n`);
await scenario(`mixed    ${WRITERS} instances (no coalescing)`, WRITERS, "mixed");
await scenario(`mixed    2 instances`, 2, "mixed");
await scenario(`mixed    1 instance  (full coalescing)`, 1, "mixed");
await scenario(`counter  ${WRITERS} instances (no coalescing)`, WRITERS, "counter");
await scenario(`counter  1 instance  (full coalescing)`, 1, "counter");

server.stop();
