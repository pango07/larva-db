/**
 * Smoke test for the rest of the §13 API: transaction (atomicity,
 * read-your-writes, concurrent re-execution), export (json/csv/sqlite),
 * vacuum (retention + orphan sweep).
 *
 *   bun scripts/api-smoke.ts
 */
import { ulid } from "@larva-db/core";
import { defineSchema, larva, SqlError, t } from "@larva-db/core";

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN is not set. Run: vercel env pull .env.local");
  process.exit(1);
}

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? ` — ${detail}` : ""}`);
};

const schema = defineSchema({
  inventory: { sku: t.text().primaryKey(), count: t.integer() },
  orders: { id: t.text().primaryKey(), sku: t.text(), qty: t.integer() },
});
const prefix = `apitest/${ulid()}/`;
const db = larva({ schema, prefix });
console.log(`database at ${prefix}`);

await db.sql`INSERT INTO inventory (sku, count) VALUES (${"widget"}, ${10}), (${"gadget"}, ${100})`;

// --- transaction: atomicity + read-your-writes, exactly one version bump ---
const v0 = await db.currentVersion();
const seen = { insideCount: -1, insideOrder: 0 };
await db.transaction(async (tx) => {
  await tx.sql`INSERT INTO orders (sku, qty) VALUES (${"widget"}, ${1})`;
  await tx.sql`UPDATE inventory SET count = count - 1 WHERE sku = ${"widget"}`;
  seen.insideCount = Number((await tx.sql`SELECT count FROM inventory WHERE sku = ${"widget"}`)[0].count);
  seen.insideOrder = (await tx.sql`SELECT COUNT(*) AS n FROM orders`)[0].n as number;
});
ok("tx sees its own uncommitted writes", seen.insideCount === 9 && seen.insideOrder === 1, JSON.stringify(seen));
ok("3-statement tx = exactly one version bump", (await db.currentVersion()) === v0 + 1);
ok("tx writes are live after commit", Number((await db.sql`SELECT count FROM inventory WHERE sku = ${"widget"}`)[0].count) === 9);

// --- failed tx applies nothing ---
const v1 = await db.currentVersion();
try {
  await db.transaction(async (tx) => {
    await tx.sql`INSERT INTO orders (sku, qty) VALUES (${"widget"}, ${99})`;
    throw new Error("boom");
  });
  ok("failing tx rethrows", false);
} catch (err) {
  ok("failing tx rethrows", (err as Error).message === "boom");
}
ok("failed tx left no version bump", (await db.currentVersion()) === v1);
ok("failed tx left no rows", ((await db.sql`SELECT COUNT(*) AS n FROM orders WHERE qty = ${99}`)[0].n as number) === 0);

// --- read-only tx skips the CAS entirely ---
const readResult = await db.transaction(async (tx) => (await tx.sql`SELECT COUNT(*) AS n FROM orders`)[0].n);
ok("read-only tx returns a value without committing", readResult === 1 && (await db.currentVersion()) === v1);

// --- concurrent RMW transactions: the lost-update gauntlet ---
// Each tx reads the count in app code and writes back read-1, the classic
// stale-read pattern. Chunk-overlap detection must re-run losing callbacks.
const WRITERS = 6;
const TXS = 3;
const v2 = await db.currentVersion();
await Promise.all(
  Array.from({ length: WRITERS }, () =>
    (async () => {
      for (let i = 0; i < TXS; i++) {
        await db.transaction(
          async (tx) => {
            const read = Number((await tx.sql`SELECT count FROM inventory WHERE sku = ${"gadget"}`)[0].count);
            await tx.sql`UPDATE inventory SET count = ${read - 1} WHERE sku = ${"gadget"}`;
          },
          { maxAttempts: 60 },
        );
      }
    })(),
  ),
);
const gadget = Number((await db.sql`SELECT count FROM inventory WHERE sku = ${"gadget"}`)[0].count);
ok(`18 concurrent stale-read decrements lose nothing`, gadget === 100 - WRITERS * TXS, `count=${gadget}, expected ${100 - WRITERS * TXS}`);
// Concurrent txs through one LarvaDb instance coalesce (group commit), so the
// version advances once per batch — anywhere from 1 to one-per-tx.
const vAfter = await db.currentVersion();
ok(
  "concurrent txs advance the version once per coalesced batch",
  vAfter > v2 && vAfter <= v2 + WRITERS * TXS,
  `v=${vAfter}, bounds=(${v2}, ${v2 + WRITERS * TXS}]`,
);

// --- export ---
const json = await db.export({ format: "json" });
ok("json export has both tables", json.inventory?.length === 2 && json.orders?.length === 1);
const csv = await db.export({ format: "csv" });
ok(
  "csv export: header + rows",
  csv.inventory.startsWith("sku,count") && csv.inventory.split("\n").length === 3,
  csv.inventory,
);
const sqliteBytes = await db.export({ format: "sqlite" });
ok("sqlite export is a real SQLite file", new TextDecoder().decode(sqliteBytes.slice(0, 15)) === "SQLite format 3");
const { Database } = (await import("bun:sqlite")) as unknown as {
  Database: { deserialize(bytes: Uint8Array): { prepare(sql: string): { get(): unknown } } };
};
const reopened = Database.deserialize(sqliteBytes);
const backRow = reopened.prepare("SELECT count FROM inventory WHERE sku = 'gadget'").get() as { count: number };
ok("sqlite export round-trips through a real engine", backRow.count === gadget, JSON.stringify(backRow));

// --- vacuum ---
for (let i = 0; i < 12; i++) await db.sql`UPDATE inventory SET count = count + 0 WHERE sku = ${"widget"}`;
const vNow = await db.currentVersion();
const report = await db.vacuum({ retainVersions: 5, retainDays: 0, graceMinutes: 0 });
ok("vacuum dropped old history", report.historyDeleted > 0, JSON.stringify(report));
ok("vacuum collected retired chunks", report.chunksDeleted > 0, JSON.stringify(report));
ok("vacuum kept the retention window", report.retainedVersions <= 5 && report.retainedVersions >= 4, JSON.stringify(report));
ok("live data still reads after vacuum", Number((await db.sql`SELECT count FROM inventory WHERE sku = ${"widget"}`)[0].count) === 9);
const recent = await db.asOf(vNow - 2);
ok("asOf within retention still works", (await recent.sql`SELECT COUNT(*) AS n FROM inventory`)[0].n === 2);
try {
  await db.asOf(2);
  ok("asOf outside retention fails loudly", false);
} catch (err) {
  ok("asOf outside retention fails loudly", (err as SqlError).code === "VERSION_NOT_FOUND", (err as Error).message);
}
await db.rollbackTo(vNow - 1);
ok("rollback to a retained version works after vacuum", (await db.currentVersion()) === vNow + 1);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed === 0) await db.destroy();
else console.log(`keeping ${prefix} for inspection`);
process.exit(failed === 0 ? 0 : 1);
