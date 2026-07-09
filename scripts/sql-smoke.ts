/**
 * Full v1 dialect walkthrough against a real Blob store, plus the parser's
 * error catalog (which needs no network and runs first).
 *
 *   bun scripts/sql-smoke.ts
 */
import { ulid } from "@larva-db/core";
import { defineSchema, larva, SqlError, t } from "@larva-db/core";
import { parse } from "@larva-db/core";

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
await expectSqlError("unknown function lists the whole catalog", () => parse("SELECT NOW() FROM a"), "UNKNOWN_FUNCTION", "COALESCE");
await expectSqlError("nested aggregates", () => parse("SELECT SUM(COUNT(x)) FROM a"), "UNSUPPORTED_FEATURE", "nested");
await expectSqlError("aggregate in WHERE points to HAVING", () => parse("SELECT * FROM a WHERE COUNT(*) > 1"), "AGGREGATE_IN_WHERE", "HAVING");
await expectSqlError("wrong function arity", () => parse("SELECT ROUND(x, 1, 2) FROM a"), "WRONG_ARGUMENT_COUNT", "ROUND");
await expectSqlError("DO UPDATE needs a conflict target", () => parse("INSERT INTO t (id) VALUES (?) ON CONFLICT DO UPDATE SET n = 1"), "PARSE_ERROR", "conflict target");
await expectSqlError("multi-column conflict targets", () => parse("INSERT INTO t (id) VALUES (?) ON CONFLICT (a, b) DO NOTHING"), "UNSUPPORTED_FEATURE", "multi-column");
await expectSqlError("WHERE on DO UPDATE", () => parse("INSERT INTO t (id) VALUES (?) ON CONFLICT (id) DO UPDATE SET n = 1 WHERE n < 5"), "UNSUPPORTED_FEATURE", "WHERE clause");
ok("trailing semicolon is fine", parse("SELECT * FROM a;").kind === "select");
ok("arithmetic parses", parse("UPDATE inv SET count = count - 1 WHERE sku = ?").kind === "update");
ok("DISTINCT parses", parse("SELECT DISTINCT x FROM a").kind === "select");
ok("HAVING parses", parse("SELECT x, COUNT(*) AS n FROM a GROUP BY x HAVING n > 1").kind === "select");
ok("searched CASE parses", parse("SELECT CASE WHEN x > 1 THEN 'hi' ELSE 'lo' END AS label FROM a").kind === "select");
ok("simple CASE parses", parse("SELECT CASE x WHEN 1 THEN 'one' END AS label FROM a").kind === "select");
ok("nested scalar functions parse", parse("SELECT COALESCE(UPPER(name), '?') FROM a").kind === "select");
ok("|| concatenation parses", parse("SELECT a || b FROM t").kind === "select");
ok("upsert parses", parse("INSERT INTO t (id, n) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET n = excluded.n").kind === "insert");
ok("DO NOTHING parses without a target", parse("INSERT INTO t (id) VALUES (?) ON CONFLICT DO NOTHING").kind === "insert");

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

// expanded dialect: expressions, scalar functions, CASE, DISTINCT, HAVING
// (orders here: Ada 200/220/240, Grace 130/140 — all status "archived")
const exprs = await db.sql`SELECT total * 2 AS double, UPPER(status) AS s FROM orders ORDER BY double DESC LIMIT 1`;
ok("expression in SELECT + ORDER BY alias", exprs[0].double === 480 && exprs[0].s === "ARCHIVED", fmt(exprs));
const concat = await db.sql`SELECT name || ' <' || email || '>' AS display FROM customers WHERE name = ${"Ada"}`;
ok("|| concatenation", concat[0].display === "Ada <ada@example.com>", fmt(concat));
const fns = await db.sql`SELECT LENGTH(name) AS len, SUBSTR(email, 1, 4) AS pre, COALESCE(NULL, name) AS c, ROUND(3.14159, 2) AS pi FROM customers WHERE name = ${"Alan"}`;
ok("LENGTH/SUBSTR/COALESCE/ROUND", fns[0].len === 4 && fns[0].pre === "alan" && fns[0].c === "Alan" && fns[0].pi === 3.14, fmt(fns));
const kase = await db.sql`SELECT name, CASE WHEN name = ${"Ada"} THEN ${"founder"} ELSE ${"member"} END AS role FROM customers ORDER BY name`;
ok("CASE WHEN", fmt(kase.map((r) => r.role)) === '["founder","member","member"]', fmt(kase));
const distinct = await db.sql`SELECT DISTINCT status FROM orders`;
ok("SELECT DISTINCT", distinct.length === 1 && distinct[0].status === "archived", fmt(distinct));
const cd = await db.sql`SELECT COUNT(DISTINCT customerId) AS n FROM orders`;
ok("COUNT(DISTINCT …)", cd[0].n === 2, fmt(cd));
const sumExpr = await db.sql`SELECT SUM(total * 2) AS s FROM orders`;
ok("aggregate over an expression", sumExpr[0].s === 1860, fmt(sumExpr));
const havingAlias = await db.sql`SELECT customerId, SUM(total) AS revenue FROM orders GROUP BY customerId HAVING revenue > ${300}`;
ok("HAVING via select alias", havingAlias.length === 1 && havingAlias[0].revenue === 660, fmt(havingAlias));
const havingAgg = await db.sql`SELECT customerId, COUNT(*) AS n FROM orders GROUP BY customerId HAVING COUNT(*) > ${2}`;
ok("HAVING with a direct aggregate", havingAgg.length === 1 && havingAgg[0].n === 3, fmt(havingAgg));
await expectSqlError("ungrouped column in HAVING is caught", () => db.sql`SELECT customerId, COUNT(*) AS n FROM orders GROUP BY customerId HAVING total > 1`, "NOT_GROUPED", "total");

// upserts
const customerCount = (await db.sql`SELECT COUNT(*) AS n FROM customers`)[0].n as number;
const skipped = await db.sql`INSERT INTO customers (id, name, email, createdAt) VALUES (${String(ada.id)}, ${"Ada Clone"}, ${"clone@example.com"}, ${"2026-06-05T00:00:00Z"}) ON CONFLICT (id) DO NOTHING RETURNING *`;
ok("ON CONFLICT DO NOTHING skips the row", skipped.length === 0 && (await db.sql`SELECT COUNT(*) AS n FROM customers`)[0].n === customerCount);
const upserted = await db.sql`INSERT INTO customers (name, email, createdAt) VALUES (${"Grace Hopper"}, ${"grace@example.com"}, ${"2026-06-06T00:00:00Z"}) ON CONFLICT (email) DO UPDATE SET name = excluded.name RETURNING id, name`;
ok("DO UPDATE on a unique column with excluded.*", upserted.length === 1 && upserted[0].name === "Grace Hopper" && upserted[0].id === grace.id, fmt(upserted));
ok("upsert updated in place, no new row", (await db.sql`SELECT COUNT(*) AS n FROM customers`)[0].n === customerCount);
const grew = await db.sql`INSERT INTO customers (name, email, createdAt) VALUES (${"Barbara"}, ${"barbara@example.com"}, ${"2026-06-07T00:00:00Z"}) ON CONFLICT (email) DO UPDATE SET name = excluded.name RETURNING name`;
ok("upsert inserts when nothing conflicts", grew.length === 1 && grew[0].name === "Barbara" && (await db.sql`SELECT COUNT(*) AS n FROM customers`)[0].n === customerCount + 1);
await db.sql`CREATE TABLE counters (slug text PRIMARY KEY, count integer)`;
await db.sql`INSERT INTO counters (slug, count) VALUES (${"visits"}, ${1}) ON CONFLICT (slug) DO UPDATE SET count = count + ${1}`;
await db.sql`INSERT INTO counters (slug, count) VALUES (${"visits"}, ${1}) ON CONFLICT (slug) DO UPDATE SET count = count + ${1}`;
ok("increment upsert (count = count + 1)", (await db.sql`SELECT count FROM counters WHERE slug = ${"visits"}`)[0].count === 2);
await db.sql`DROP TABLE counters`;
await expectSqlError("conflict target must be pk or unique", () => db.sql`INSERT INTO customers (name, email, createdAt) VALUES (${"X"}, ${"x@example.com"}, ${"2026-06-08T00:00:00Z"}) ON CONFLICT (name) DO NOTHING`, "INVALID_CONFLICT_TARGET", "name");
await expectSqlError("a conflict outside the target still fails loudly", () => db.sql`INSERT INTO customers (id, name, email, createdAt) VALUES (${String(ada.id)}, ${"X"}, ${"fresh@example.com"}, ${"2026-06-08T00:00:00Z"}) ON CONFLICT (email) DO NOTHING`, "PRIMARY_KEY_CONFLICT", "does not cover");

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
