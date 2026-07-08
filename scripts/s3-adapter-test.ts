/**
 * S3Adapter contract test against an in-process fake S3 server that honors
 * conditional writes (If-Match / If-None-Match), and randomly injects the
 * failure modes real object stores exhibit: 409s on conditional PUTs and
 * 500s on GETs. The commit protocol must shrug all of it off.
 *
 * Verifies: adapter CAS contract, then the full stress harness and a SQL
 * flow running over the adapter. No network, no credentials.
 *
 *   bun scripts/s3-adapter-test.ts
 */
import { CasConflictError, defineSchema, larva, S3Adapter, t } from "@larva-db/core";
import { runStress } from "@larva-db/core/testing";

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? ` — ${detail}` : ""}`);
};

// ---------- fake S3 ----------
interface StoredObject {
  body: string;
  etag: string;
  uploadedAt: string;
}
const objects = new Map<string, StoredObject>();
let etagCounter = 0;
let sawSigV4 = true;
let chaos = false; // off for the raw contract checks; on for the engine sections

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (!(req.headers.get("authorization") ?? "").startsWith("AWS4-HMAC-SHA256 Credential=")) sawSigV4 = false;
    const [, bucket, ...rest] = url.pathname.split("/").map(decodeURIComponent);
    const key = rest.join("/");
    if (bucket !== "larva-test") return new Response("wrong bucket", { status: 404 });

    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const contents = [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(
          ([k, o]) =>
            `<Contents><Key>${xmlEscape(k)}</Key><LastModified>${o.uploadedAt}</LastModified><ETag>${xmlEscape(o.etag)}</ETag></Contents>`,
        )
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
      return req.text().then((body) => {
        const etag = `"fake-${++etagCounter}"`;
        objects.set(key, { body, etag, uploadedAt: new Date().toISOString() });
        return new Response(null, { status: 200, headers: { etag } });
      });
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

// ---------- adapter contract ----------
ok("get of missing key is null", (await store.get("nope.json")) === null);
const first = await store.put("cas.json", `{"v":1}`, { createOnly: true });
ok("create-only put returns an etag", first.etag.length > 0);
try {
  await store.put("cas.json", `{"v":2}`, { createOnly: true });
  ok("second create-only put conflicts", false);
} catch (err) {
  ok("second create-only put conflicts", err instanceof CasConflictError);
}
const swapped = await store.put("cas.json", `{"v":2}`, { ifMatch: first.etag });
try {
  await store.put("cas.json", `{"v":3}`, { ifMatch: first.etag });
  ok("stale-etag put conflicts", false);
} catch (err) {
  ok("stale-etag put conflicts", err instanceof CasConflictError);
}
const read = await store.get("cas.json");
ok("get returns latest body + etag", read?.body === `{"v":2}` && read.etag === swapped.etag);
const listed = await store.list("cas");
ok("list filters by prefix with uploadedAt", listed.length === 1 && listed[0].uploadedAt instanceof Date);
await store.del(["cas.json"]);
ok("del removes", (await store.get("cas.json")) === null);

// ---------- the stress harness over the adapter (with chaos injection live) ----------
chaos = true;
console.log("\nrunning stress harness over S3Adapter (4 writers × 6 commits, 409/500 chaos on)...");
const report = await runStress({ writers: 4, commitsPerWriter: 6, mode: "mixed" }, () => {}, store);
for (const c of report.checks) ok(`stress: ${c.name}`, c.pass, c.detail);
ok("stress passed overall", report.pass);

// ---------- a SQL flow over the adapter ----------
const db = larva({
  schema: defineSchema({ notes: { id: t.text().primaryKey(), body: t.text(), score: t.integer() } }),
  prefix: "sqlflow/",
  store,
});
await db.sql`INSERT INTO notes (body, score) VALUES (${"hello"}, ${1}), (${"world"}, ${2})`;
const rows = await db.sql`SELECT body FROM notes WHERE score > ${1} ORDER BY body`;
ok("SQL flow over S3Adapter", rows.length === 1 && rows[0].body === "world", JSON.stringify(rows));
await db.transaction(async (tx) => {
  await tx.sql`UPDATE notes SET score = score + 10 WHERE body = ${"hello"}`;
});
const bumped = await db.sql`SELECT score FROM notes WHERE body = ${"hello"}`;
ok("transaction over S3Adapter", bumped[0].score === 11, JSON.stringify(bumped));

ok("every request carried a SigV4 authorization header", sawSigV4);

server.stop();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
