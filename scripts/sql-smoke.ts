/**
 * Full v1 dialect walkthrough against a real Blob store, plus the parser's
 * error catalog (which needs no network and runs first).
 *
 *   bun scripts/sql-smoke.ts
 */
import { ulid } from "larvadb";
import { defineSchema, larva, SqlError, t } from "larvadb";
import { parse } from "larvadb";

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail && !cond ? ` — ${detail}` : ""}`);
};
const fmt = (v: unknown) => JSON.stringify(v);

async function expectSqlError(name: string, fn: () => unknown | Promise<unknown>, code: string, includes?: string) {
  try {
    await fn();
    ok(name, false, `expected ${code}, no error thrown`);
  } catch (err) {
    const e = err as SqlError;
    ok(
      name,
      e instanceof Error && (e as SqlError).code === code && (!includes || e.message.includes(includes)),
      `expected ${code}${includes ? ` containing "${includes}"` : ""}, got ${(e as SqlError).code ?? e.name}: ${e.message}`,
    );
  }
}

// ---------- Part A: parser error catalog (offline) ----------
console.log("--- parser error catalog ---");
await expectSqlError("HAVING is rejected by name", () => parse("SELECT status, COUNT(*) FROM orders GROUP BY status HAVING COUNT(*) > 1"), "UNSUPPORTED_FEATURE", "HAVING");
await expectSqlError("subquery in IN", () => parse("SELECT * FROM a WHERE id IN (SELECT id FROM b)"), "UNSUPPORTED_FEATURE", "subqueries");
await expectSqlError("subquery in FROM", () => parse("SELECT * FROM (SELECT * FROM a)"), "UNSUPPORTED_FEATURE", "subqueries");
await expectSqlError("UNION", () => parse("SELECT * FROM a UNION SELECT * FROM b"), "UNSUPPORTED_FEATURE", "UNION");
await expectSqlError("window function", () => parse("SELECT SUM(x) OVER () FROM a"), "UNSUPPORTED_FEATURE", "window");
await expectSqlError("three-table join", () => parse("SELECT * FROM a JOIN b ON a.x = b.x JOIN c ON b.y = c.y"), "UNSUPPORTED_FEATURE", "at most two tables");
await expectSqlError("self-join", () => parse("SELECT * FROM a JOIN a ON a.x = a.y"), "UNSUPPORTED_FEATURE", "self-joins");
await expectSqlError("RIGHT JOIN", () => parse("SELECT * FROM a RIGHT JOIN b ON a.x = b.x"), "UNSUPPORTED_FEATURE", "RIGHT");
await expectSqlError("ALTER TABLE", () => parse("ALTER TABLE a ADD COLUMN x text"), "UNSUPPORTED_FEATURE", "ALTER");
await expectSqlError("CREATE VIEW", () => parse("CREATE VIEW v AS SELECT 1"), "UNSUPPORTED_FEATURE", "views");
await expectSqlError("CREATE TRIGGER", () => parse("CREATE TRIGGER trg"), "UNSUPPORTED_FEATURE", "triggers");
await expectSqlError("CREATE INDEX", () => parse("CREATE INDEX idx ON a (x)"), "UNSUPPORTED_FEATURE", "indexes");
await expectSqlError("stacked statements", () => parse("SELECT * FROM a; DROP TABLE a"), "MULTIPLE_STATEMENTS", "injection");
await expectSqlError("DISTINCT", () => parse("SELECT DISTINCT x FROM a"), "UNSUPPORTED_FEATURE", "deduplicate");
await expectSqlError("unknown function", () => parse("SELECT COALESCE(x, 1) FROM a"), "UNKNOWN_FUNCTION", "COUNT, SUM, AVG, MIN, MAX");
ok("trailing semicolon is fine", parse("SELECT * FROM a;").kind === "select");
ok("arithmetic parses", parse("UPDATE inv SET count = count - 1 WHERE sku = ?").kind === "update");

// ---------- Part B: live walkthrough ----------
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN is not set. Run: vercel env pull .env.local");
  process.exit(1);
}
console.log("\n--- live dialect walkthrough ---");

const schema = defineSchema({
  customers: {
    id: t.text().primaryKey(),
    name: t.text(),
    email: t.text().unique(),
    createdAt: t.timestamp().partitionBy(),
  },
  orders: {
    id: t.text().primaryKey(),
    customerId: t.text().references("customers.id"),
    total: t.real(),
    status: t.text(),
    createdAt: t.timestamp().partitionBy(),
  },
});

const prefix = `sqltest/${ulid()}/`;
const db = larva({ schema, prefix });
console.log(`  database at ${prefix}`);

// INSERT ... RETURNING
const ada = (
  await db.sql`INSERT INTO customers (name, email, createdAt) VALUES (${"Ada"}, ${"ada@example.com"}, ${"2026-06-01T00:00:00Z"}) RETURNING *`
)[0];
ok("INSERT RETURNING * yields the row with generated pk", typeof ada.id === "string" && ada.name === "Ada");

const [grace, alan] = await db.sql`INSERT INTO customers (name, email, createdAt) VALUES
  (${"Grace"}, ${"grace@example.com"}, ${"2026-06-02T00:00:00Z"}),
  (${"Alan"}, ${"alan@example.com"}, ${"2026-06-03T00:00:00Z"}) RETURNING id, name`;
ok("multi-row INSERT with RETURNING columns", grace.name === "Grace" && typeof alan.id === "string");

// orders across two months for join/group/pruning work
const june = ["2026-06-05", "2026-06-10", "2026-06-15"];
const july = ["2026-07-01", "2026-07-03"];
for (const [i, d] of [...june, ...july].entries()) {
  await db.sql`INSERT INTO orders (customerId, total, status, createdAt) VALUES (${i < 3 ? String(ada.id) : String(grace.id)}, ${100 + i * 10}, ${i % 2 === 0 ? "paid" : "pending"}, ${d + "T12:00:00Z"})`;
}

// SELECT basics
const byEmail = await db.sql`SELECT name FROM customers WHERE email = ${"grace@example.com"}`;
ok("WHERE = param", byEmail.length === 1 && byEmail[0].name === "Grace");
const top = await db.sql`SELECT total FROM orders ORDER BY total DESC LIMIT 2 OFFSET 1`;
ok("ORDER BY DESC LIMIT OFFSET", fmt(top.map((r) => r.total)) === "[130,120]", fmt(top));
const like = await db.sql`SELECT name FROM customers WHERE email LIKE ${"%@example.com"} AND name IN (${"Ada"}, ${"Alan"}) ORDER BY name`;
ok("LIKE + IN + AND", fmt(like.map((r) => r.name)) === '["Ada","Alan"]', fmt(like));
const between = await db.sql`SELECT COUNT(*) AS n FROM orders WHERE createdAt BETWEEN ${"2026-06-01"} AND ${"2026-06-30"}`;
ok("BETWEEN + COUNT(*)", between[0].n === 3, fmt(between));

// JOINs
const joined = await db.sql`
  SELECT customers.name, orders.total FROM orders
  INNER JOIN customers ON orders.customerId = customers.id
  WHERE orders.status = ${"paid"} ORDER BY orders.total DESC`;
ok("INNER JOIN (quickstart shape)", joined.length === 3 && joined.every((r) => typeof r.name === "string"), fmt(joined));
const left = await db.sql`
  SELECT customers.name, orders.id AS orderId FROM customers
  LEFT JOIN orders ON orders.customerId = customers.id
  WHERE orders.id IS NULL`;
ok("LEFT JOIN finds customer with no orders", left.length === 1 && left[0].name === "Alan", fmt(left));

// GROUP BY + aggregates
const grouped = await db.sql`
  SELECT customerId, COUNT(*) AS n, SUM(total) AS revenue, AVG(total) AS avg
  FROM orders GROUP BY customerId ORDER BY revenue DESC`;
ok("GROUP BY with COUNT/SUM/AVG", grouped.length === 2 && Number(grouped[0].revenue) > Number(grouped[1].revenue), fmt(grouped));
await expectSqlError("ungrouped column is caught", () => db.sql`SELECT status, COUNT(*) FROM orders GROUP BY customerId`, "NOT_GROUPED", "status");

// arithmetic in SET, read-modify-write style
await db.sql`UPDATE orders SET total = total * 2 WHERE customerId = ${String(ada.id)}`;
const doubled = await db.sql`SELECT SUM(total) AS s FROM orders WHERE customerId = ${String(ada.id)}`;
ok("UPDATE SET total = total * 2", doubled[0].s === (100 + 110 + 120) * 2, fmt(doubled));

// guards and conflicts
await expectSqlError("UPDATE without WHERE is guarded", () => db.sql`UPDATE orders SET status = ${"void"}`, "MISSING_WHERE", "allowFullTable");
await db.query("UPDATE orders SET status = ?", ["archived"], { allowFullTable: true });
const archived = await db.sql`SELECT COUNT(*) AS n FROM orders WHERE status = ${"archived"}`;
ok("allowFullTable full-table UPDATE", archived[0].n === 5, fmt(archived));
await expectSqlError("duplicate pk rejected", () => db.sql`INSERT INTO customers (id, name, email, createdAt) VALUES (${String(ada.id)}, ${"Imposter"}, ${"x@example.com"}, ${"2026-06-04T00:00:00Z"})`, "PRIMARY_KEY_CONFLICT");
await expectSqlError("unique column enforced", () => db.sql`INSERT INTO customers (name, email, createdAt) VALUES (${"Ada2"}, ${"ada@example.com"}, ${"2026-06-04T00:00:00Z"})`, "UNIQUE_CONFLICT", "email");
await expectSqlError("unknown column names the table's columns", () => db.sql`SELECT nam FROM customers`, "UNKNOWN_COLUMN", "nam");
await expectSqlError("unknown table lists tables", () => db.sql`SELECT * FROM customer`, "UNKNOWN_TABLE", "customers");

// time travel
const before = await db.currentVersion();
await db.sql`DELETE FROM orders WHERE status = ${"archived"}`;
ok("DELETE removed all", (await db.sql`SELECT COUNT(*) AS n FROM orders`)[0].n === 0);
const past = await db.asOf(before);
ok("asOf(version) sees pre-delete state", (await past.sql`SELECT COUNT(*) AS n FROM orders`)[0].n === 5);
await expectSqlError("asOf snapshot is read-only", () => past.sql`DELETE FROM orders WHERE status = ${"archived"}`, "READ_ONLY");
await db.rollbackTo(before);
ok("rollbackTo restores the rows", (await db.sql`SELECT COUNT(*) AS n FROM orders`)[0].n === 5);
const dateSnap = await db.asOf(new Date());
ok("asOf(Date) resolves a version", dateSnap.version > 0);

// runtime DDL
await db.sql`CREATE TABLE notes (id text PRIMARY KEY, body text, score integer)`;
await db.sql`INSERT INTO notes (body, score) VALUES (${"hello"}, ${1 + 1})`;
ok("CREATE TABLE + INSERT with arithmetic", (await db.sql`SELECT body, score FROM notes`)[0].score === 2);
await db.sql`DROP TABLE notes`;
await expectSqlError("dropped table is gone", () => db.sql`SELECT * FROM notes`, "UNKNOWN_TABLE");

// zone-map pruning: each insert above made one chunk; a narrow date filter must skip most
const chunks = await db.sql`SELECT COUNT(*) AS n FROM orders WHERE createdAt BETWEEN ${"2026-07-01"} AND ${"2026-07-31"}`;
const stats = db.lastQueryStats;
ok("partition pruning skips chunks", chunks[0].n === 2 && stats.chunksFetched < stats.chunksTotal, `fetched ${stats.chunksFetched}/${stats.chunksTotal}`);
console.log(`  pruning: fetched ${stats.chunksFetched} of ${stats.chunksTotal} chunks for the July query`);
await db.sql`SELECT name FROM customers WHERE id = ${String(grace.id)}`;
const pkStats = db.lastQueryStats;
ok("pk pruning skips chunks", pkStats.chunksFetched < pkStats.chunksTotal, `fetched ${pkStats.chunksFetched}/${pkStats.chunksTotal}`);

// schema drift detection
const drifted = larva({
  prefix,
  schema: defineSchema({
    customers: { id: t.text().primaryKey(), name: t.integer(), email: t.text().unique(), createdAt: t.timestamp().partitionBy() },
    orders: schemaTableClone(),
  }),
});
await expectSqlError("schema drift is a loud startup error", () => drifted.sql`SELECT * FROM customers`, "SCHEMA_DRIFT", "code says integer");

function schemaTableClone() {
  return {
    id: t.text().primaryKey(),
    customerId: t.text().references("customers.id"),
    total: t.real(),
    status: t.text(),
    createdAt: t.timestamp().partitionBy(),
  };
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed === 0) await db.destroy();
else console.log(`keeping ${prefix} for inspection`);
process.exit(failed === 0 ? 0 : 1);
