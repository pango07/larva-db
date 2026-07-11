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
ok("IN (SELECT …) parses", parse("SELECT * FROM a WHERE id IN (SELECT id FROM b)").kind === "select");
ok("scalar subquery parses", parse("SELECT * FROM a WHERE x > (SELECT MAX(x) FROM b)").kind === "select");
ok("NOT IN (SELECT …) parses", parse("DELETE FROM a WHERE id NOT IN (SELECT aId FROM b)").kind === "delete");
await expectSqlError("subquery in FROM (derived table)", () => parse("SELECT * FROM (SELECT * FROM a)"), "UNSUPPORTED_FEATURE", "derived tables");
await expectSqlError("EXISTS hints at IN or JOIN", () => parse("SELECT * FROM a WHERE EXISTS (SELECT 1 FROM b)"), "UNKNOWN_FUNCTION", "correlated");
await expectSqlError("UNION", () => parse("SELECT * FROM a UNION SELECT * FROM b"), "UNSUPPORTED_FEATURE", "UNION");
await expectSqlError("window function", () => parse("SELECT SUM(x) OVER () FROM a"), "UNSUPPORTED_FEATURE", "window");
ok("three-table join parses", parse("SELECT * FROM a JOIN b ON a.x = b.x JOIN c ON b.y = c.y").kind === "select");
ok("self-join with aliases parses", parse("SELECT * FROM a x JOIN a y ON x.pid = y.id").kind === "select");
await expectSqlError("self-join without aliases", () => parse("SELECT * FROM a JOIN a ON a.x = a.y"), "DUPLICATE_TABLE_NAME", "alias");
await expectSqlError("RIGHT JOIN", () => parse("SELECT * FROM a RIGHT JOIN b ON a.x = b.x"), "UNSUPPORTED_FEATURE", "RIGHT");
ok("ALTER TABLE ADD COLUMN parses", parse("ALTER TABLE a ADD COLUMN x text").kind === "alter");
ok("ADD without COLUMN keyword parses", parse("ALTER TABLE a ADD x integer").kind === "alter");
await expectSqlError("DROP COLUMN says why", () => parse("ALTER TABLE a DROP COLUMN x"), "UNSUPPORTED_FEATURE", "time travel");
await expectSqlError("RENAME says why", () => parse("ALTER TABLE a RENAME TO b"), "UNSUPPORTED_FEATURE", "time travel");
await expectSqlError("ADD COLUMN NOT NULL is rejected", () => parse("ALTER TABLE a ADD COLUMN x text NOT NULL"), "UNSUPPORTED_FEATURE", "NULL");
await expectSqlError("ADD COLUMN UNIQUE is rejected", () => parse("ALTER TABLE a ADD COLUMN x text UNIQUE"), "UNSUPPORTED_FEATURE", "retroactively");
await expectSqlError("ADD COLUMN DEFAULT is rejected", () => parse("ALTER TABLE a ADD COLUMN x text DEFAULT 'y'"), "UNSUPPORTED_FEATURE", "backfill");
await expectSqlError("ADD CONSTRAINT is rejected", () => parse("ALTER TABLE a ADD CONSTRAINT u UNIQUE (x)"), "UNSUPPORTED_FEATURE", "retroactively");
await expectSqlError("CREATE VIEW", () => parse("CREATE VIEW v AS SELECT 1"), "UNSUPPORTED_FEATURE", "views");
await expectSqlError("CREATE TRIGGER", () => parse("CREATE TRIGGER trg"), "UNSUPPORTED_FEATURE", "triggers");
await expectSqlError("CREATE INDEX", () => parse("CREATE INDEX idx ON a (x)"), "UNSUPPORTED_FEATURE", "indexes");
await expectSqlError("stacked statements", () => parse("SELECT * FROM a; DROP TABLE a"), "MULTIPLE_STATEMENTS", "injection");
await expectSqlError("unknown function lists the whole catalog", () => parse("SELECT MEDIAN(x) FROM a"), "UNKNOWN_FUNCTION", "COALESCE");
await expectSqlError("CONCAT hints at ||", () => parse("SELECT CONCAT(a, b) FROM t"), "UNKNOWN_FUNCTION", "||");
await expectSqlError("SUBSTRING hints at SUBSTR", () => parse("SELECT SUBSTRING(a, 1, 2) FROM t"), "UNKNOWN_FUNCTION", "SUBSTR");
await expectSqlError("DATE_TRUNC hints at DATE/STRFTIME", () => parse("SELECT DATE_TRUNC('month', x) FROM t"), "UNKNOWN_FUNCTION", "STRFTIME");
await expectSqlError("unknown CAST target", () => parse("SELECT CAST(x AS blob) FROM t"), "UNKNOWN_TYPE", "blob");
await expectSqlError("aggregate in GROUP BY", () => parse("SELECT COUNT(*) FROM t GROUP BY SUM(x)"), "AGGREGATE_MISPLACED", "GROUP BY");
await expectSqlError("separator on non-GROUP_CONCAT aggregate", () => parse("SELECT SUM(x, ',') FROM t"), "PARSE_ERROR", "GROUP_CONCAT");
await expectSqlError("nested aggregates", () => parse("SELECT SUM(COUNT(x)) FROM a"), "UNSUPPORTED_FEATURE", "nested");
await expectSqlError("aggregate in WHERE points to HAVING", () => parse("SELECT * FROM a WHERE COUNT(*) > 1"), "AGGREGATE_IN_WHERE", "HAVING");
await expectSqlError("wrong function arity", () => parse("SELECT ROUND(x, 1, 2) FROM a"), "WRONG_ARGUMENT_COUNT", "ROUND");
await expectSqlError("DO UPDATE needs a conflict target", () => parse("INSERT INTO t (id) VALUES (?) ON CONFLICT DO UPDATE SET n = 1"), "PARSE_ERROR", "conflict target");
ok("multi-column conflict target parses", parse("INSERT INTO t (id) VALUES (?) ON CONFLICT (a, b) DO NOTHING").kind === "insert");
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
ok("GROUP BY expression parses", parse("SELECT DATE(createdAt), SUM(total) FROM orders GROUP BY DATE(createdAt)").kind === "select");
ok("CAST parses", parse("SELECT CAST(x AS integer) FROM t").kind === "select");
ok("CURRENT_TIMESTAMP parses", parse("SELECT CURRENT_TIMESTAMP FROM t").kind === "select");
ok("GROUP_CONCAT with separator parses", parse("SELECT GROUP_CONCAT(name, ', ') FROM t").kind === "select");
ok("->> parses", parse("SELECT payload ->> 'user' FROM events").kind === "select");

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

// 3+ table joins and self-joins
await db.sql`CREATE TABLE items (id text PRIMARY KEY, orderId text, sku text, qty integer)`;
const firstOrders = await db.sql`SELECT id FROM orders ORDER BY createdAt LIMIT 2`;
await db.sql`INSERT INTO items (orderId, sku, qty) VALUES (${String(firstOrders[0].id)}, ${"widget"}, ${2}), (${String(firstOrders[1].id)}, ${"gadget"}, ${1})`;
const three = await db.sql`
  SELECT customers.name, orders.total, items.sku FROM items
  INNER JOIN orders ON items.orderId = orders.id
  INNER JOIN customers ON orders.customerId = customers.id
  ORDER BY items.sku`;
ok("three-table join", three.length === 2 && three[0].sku === "gadget" && three.every((r) => r.name === "Ada"), fmt(three));
const threeLeft = await db.sql`
  SELECT customers.name, items.sku FROM customers
  LEFT JOIN orders ON orders.customerId = customers.id
  LEFT JOIN items ON items.orderId = orders.id
  WHERE customers.name = ${"Alan"}`;
ok("LEFT JOIN chain carries NULLs through", threeLeft.length === 1 && threeLeft[0].sku === null, fmt(threeLeft));
await expectSqlError(
  "ON must involve the joined table",
  () => db.sql`SELECT customers.name FROM customers INNER JOIN orders ON orders.customerId = customers.id INNER JOIN items ON orders.id = customers.id`,
  "INVALID_JOIN_CONDITION",
);
await db.sql`DROP TABLE items`;
await db.sql`CREATE TABLE staff (id text PRIMARY KEY, name text, managerId text)`;
await db.sql`INSERT INTO staff (id, name, managerId) VALUES (${"s1"}, ${"Root"}, ${null}), (${"s2"}, ${"Mid"}, ${"s1"}), (${"s3"}, ${"Leaf"}, ${"s2"})`;
const selfJoin = await db.sql`SELECT e.name AS emp, m.name AS boss FROM staff e INNER JOIN staff m ON e.managerId = m.id ORDER BY emp`;
ok("self-join with aliases", fmt(selfJoin) === '[{"emp":"Leaf","boss":"Mid"},{"emp":"Mid","boss":"Root"}]', fmt(selfJoin));
const leftSelf = await db.sql`SELECT e.name AS emp FROM staff e LEFT JOIN staff m ON e.managerId = m.id WHERE m.id IS NULL`;
ok("LEFT self-join finds the root", leftSelf.length === 1 && leftSelf[0].emp === "Root", fmt(leftSelf));
await db.sql`DROP TABLE staff`;

// uncorrelated subqueries — inner query first, result feeds the outer plan
// (orders: Ada 100/110/120, Grace 130/140)
const bigSpenders = await db.sql`SELECT name FROM customers WHERE id IN (SELECT customerId FROM orders WHERE total >= ${120}) ORDER BY name`;
ok("IN (SELECT …)", fmt(bigSpenders.map((r) => r.name)) === '["Ada","Grace"]', fmt(bigSpenders));
const orderless = await db.sql`SELECT name FROM customers WHERE id NOT IN (SELECT customerId FROM orders)`;
ok("NOT IN (SELECT …)", orderless.length === 1 && orderless[0].name === "Alan", fmt(orderless));
const maxOrder = await db.sql`SELECT total FROM orders WHERE total = (SELECT MAX(total) FROM orders)`;
ok("scalar subquery (MAX)", maxOrder.length === 1 && maxOrder[0].total === 140, fmt(maxOrder));
const aboveAvg = await db.sql`SELECT COUNT(*) AS n FROM orders WHERE total > (SELECT AVG(total) FROM orders)`;
ok("scalar subquery in a comparison", aboveAvg[0].n === 2, fmt(aboveAvg));
const nested = await db.sql`SELECT name FROM customers WHERE id IN (SELECT customerId FROM orders WHERE total = (SELECT MIN(total) FROM orders))`;
ok("nested subquery", nested.length === 1 && nested[0].name === "Ada", fmt(nested));
await db.sql`UPDATE orders SET status = ${"vip"} WHERE customerId IN (SELECT id FROM customers WHERE name = ${"Grace"})`;
ok("subquery inside UPDATE", (await db.sql`SELECT COUNT(*) AS n FROM orders WHERE status = ${"vip"}`)[0].n === 2);
await expectSqlError(
  "multi-row scalar subquery is caught",
  () => db.sql`SELECT name FROM customers WHERE id = (SELECT customerId FROM orders)`,
  "SUBQUERY_MULTIPLE_ROWS",
);
await expectSqlError(
  "multi-column subquery is caught",
  () => db.sql`SELECT name FROM customers WHERE id IN (SELECT customerId, total FROM orders)`,
  "SUBQUERY_SHAPE",
);
await expectSqlError(
  "correlated subquery gets a pointed error",
  () => db.sql`SELECT name FROM customers WHERE id IN (SELECT customerId FROM orders WHERE orders.customerId = customers.id)`,
  "UNKNOWN_TABLE",
  "correlated",
);

// additive ALTER TABLE — existing chunks untouched, absent keys read as NULL
await db.sql`ALTER TABLE orders ADD COLUMN note text`;
ok("added column reads NULL on existing rows", (await db.sql`SELECT COUNT(*) AS n FROM orders WHERE note IS NULL`)[0].n === 5);
await db.sql`UPDATE orders SET note = ${"big"} WHERE total >= ${130}`;
ok("UPDATE backfills the added column", (await db.sql`SELECT COUNT(*) AS n FROM orders WHERE note = ${"big"}`)[0].n === 2);
const noteStar = await db.sql`SELECT * FROM orders WHERE total = ${100}`;
ok("SELECT * includes the added column as NULL", noteStar.length === 1 && noteStar[0].note === null, fmt(noteStar));
await expectSqlError("duplicate column is caught", () => db.sql`ALTER TABLE orders ADD COLUMN note text`, "DUPLICATE_COLUMN");
await expectSqlError("ALTER on a missing table", () => db.sql`ALTER TABLE nope ADD COLUMN x text`, "UNKNOWN_TABLE");
const notInNull = await db.sql`SELECT COUNT(*) AS n FROM orders WHERE status NOT IN (SELECT note FROM orders)`;
ok("NOT IN ignores NULLs from the subquery (two-valued, not SQL's NULL trap)", notInNull[0].n === 5, fmt(notInNull));
await db.sql`ALTER TABLE customers ADD COLUMN nickname text`;
const upAltered = await db.sql`INSERT INTO customers (id, name, email, createdAt) VALUES (${String(ada.id)}, ${"x"}, ${"x@x.com"}, ${"2026-06-09T00:00:00Z"})
  ON CONFLICT (id) DO UPDATE SET nickname = COALESCE(nickname, ${"the countess"}) RETURNING nickname`;
ok("upsert SET reads an ALTERed column on a pre-ALTER row", upAltered.length === 1 && upAltered[0].nickname === "the countess", fmt(upAltered));

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

// v2 schema features: sequences + composite uniques (a format-2 database)
const v2schema = defineSchema(
  {
    invoices: {
      number: t.sequence().primaryKey(),
      customer: t.text(),
    },
    entitlements: {
      id: t.text().primaryKey(),
      userId: t.text(),
      feature: t.text(),
      level: t.integer(),
    },
  },
  { uniques: { entitlements: [["userId", "feature"]] } },
);
const db2 = larva({ schema: v2schema, prefix: `${prefix}v2/` });
const invs = await db2.sql`INSERT INTO invoices (customer) VALUES (${"ada"}), (${"grace"}), (${"alan"}) RETURNING number, customer`;
ok(
  "sequence pk auto-assigned, distinct and increasing",
  invs.length === 3 && invs.every((r) => Number.isInteger(r.number)) && new Set(invs.map((r) => r.number)).size === 3 && (invs[0].number as number) < (invs[2].number as number),
  fmt(invs),
);
const explicit = await db2.sql`INSERT INTO invoices (number, customer) VALUES (${9000}, ${"manual"}) RETURNING number`;
ok("explicit sequence value accepted", explicit[0].number === 9000);
await db2.sql`INSERT INTO entitlements (userId, feature, level) VALUES (${"u1"}, ${"exports"}, ${1})`;
await expectSqlError(
  "composite unique rejects the duplicate pair",
  () => db2.sql`INSERT INTO entitlements (userId, feature, level) VALUES (${"u1"}, ${"exports"}, ${2})`,
  "UNIQUE_CONFLICT",
  "(userId, feature)",
);
const bumped = await db2.sql`INSERT INTO entitlements (userId, feature, level) VALUES (${"u1"}, ${"exports"}, ${5})
  ON CONFLICT (userId, feature) DO UPDATE SET level = excluded.level RETURNING level`;
ok(
  "upsert on the composite target",
  bumped[0].level === 5 && (await db2.sql`SELECT COUNT(*) AS n FROM entitlements`)[0].n === 1,
  fmt(bumped),
);
await db2.sql`INSERT INTO entitlements (userId, feature, level) VALUES (${"u1"}, ${null}, ${1}), (${"u1"}, ${null}, ${2})`;
ok("NULL never conflicts in a composite unique", (await db2.sql`SELECT COUNT(*) AS n FROM entitlements`)[0].n === 3);
await expectSqlError(
  "undeclared composite target is rejected",
  () => db2.sql`INSERT INTO entitlements (userId, level) VALUES (${"u2"}, ${1}) ON CONFLICT (userId, level) DO NOTHING`,
  "INVALID_CONFLICT_TARGET",
  "composite unique",
);

// time-series shapes: dates, GROUP BY expressions and aliases
// (orders: Ada 200/220/240 on June 5/10/15, Grace 130/140 on July 1/3)
const daily = await db.sql`SELECT DATE(createdAt) AS day, SUM(total) AS revenue FROM orders GROUP BY DATE(createdAt) ORDER BY day`;
ok("revenue by day (GROUP BY expression)", daily.length === 5 && daily[0].day === "2026-06-05" && daily[0].revenue === 200, fmt(daily));
const monthly = await db.sql`SELECT STRFTIME(${"%Y-%m"}, createdAt) AS month, COUNT(*) AS n FROM orders GROUP BY month ORDER BY month`;
ok("monthly buckets (STRFTIME + GROUP BY alias)", fmt(monthly) === '[{"month":"2026-06","n":3},{"month":"2026-07","n":2}]', fmt(monthly));
const tiers = await db.sql`SELECT CASE WHEN total >= 200 THEN ${"big"} ELSE ${"small"} END AS tier, COUNT(*) AS n FROM orders GROUP BY tier ORDER BY n DESC`;
ok("GROUP BY a CASE alias", fmt(tiers) === '[{"tier":"big","n":3},{"tier":"small","n":2}]', fmt(tiers));
const nowRow = await db.sql`SELECT NOW() AS ts, CURRENT_TIMESTAMP AS ts2, DATE(NOW()) AS today FROM customers LIMIT 1`;
ok("NOW / CURRENT_TIMESTAMP / DATE", typeof nowRow[0].ts === "string" && String(nowRow[0].ts).includes("T") && String(nowRow[0].ts2).includes("T") && String(nowRow[0].today).length === 10, fmt(nowRow));

// scalar stragglers + CAST
const cast = await db.sql`SELECT CAST(total AS integer) AS i, CAST(total AS text) AS s FROM orders ORDER BY total LIMIT 1`;
ok("CAST to integer and text", cast[0].i === 130 && cast[0].s === "130", fmt(cast));
const nulls = await db.sql`SELECT NULLIF(status, ${"archived"}) AS gone, IFNULL(NULL, ${"fallback"}) AS fb FROM orders LIMIT 1`;
ok("NULLIF / IFNULL", nulls[0].gone === null && nulls[0].fb === "fallback", fmt(nulls));
const misc = await db.sql`SELECT REPLACE(${"a-b-c"}, ${"-"}, ${"."}) AS r, CEIL(1.2) AS c, FLOOR(1.8) AS f, MOD(7, 3) AS m FROM customers LIMIT 1`;
ok("REPLACE / CEIL / FLOOR / MOD", misc[0].r === "a.b.c" && misc[0].c === 2 && misc[0].f === 1 && misc[0].m === 1, fmt(misc));

// GROUP_CONCAT
const gc = await db.sql`SELECT customerId, GROUP_CONCAT(total, ${", "}) AS totals FROM orders GROUP BY customerId ORDER BY totals`;
ok("GROUP_CONCAT with separator", gc.some((r) => r.totals === "200, 220, 240") && gc.some((r) => r.totals === "130, 140"), fmt(gc));

// JSON over text columns (SQLite json1 semantics; t.json() is still reserved)
await db.sql`CREATE TABLE events (id text PRIMARY KEY, payload text)`;
await db.sql`INSERT INTO events (payload) VALUES (${JSON.stringify({ user: { name: "Ada" }, tags: ["alpha", "beta"] })})`;
const je = await db.sql`SELECT JSON_EXTRACT(payload, ${"$.user.name"}) AS who, payload ->> ${"user"} AS userJson FROM events`;
ok("JSON_EXTRACT + ->>", je[0].who === "Ada" && typeof je[0].userJson === "string" && String(je[0].userJson).includes("Ada"), fmt(je));
const jf = await db.sql`SELECT COUNT(*) AS n FROM events WHERE JSON_EXTRACT(payload, ${"$.tags[1]"}) = ${"beta"}`;
ok("filter on a JSON path", jf[0].n === 1, fmt(jf));
await expectSqlError("bad JSON path is caught", () => db.sql`SELECT JSON_EXTRACT(payload, ${"user.name"}) AS x FROM events`, "INVALID_JSON_PATH", "$");
await db.sql`DROP TABLE events`;

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

// additive drift auto-migrates: a plain new column in code is applied as ALTER TABLE ADD COLUMN
const grown = larva({
  prefix,
  schema: defineSchema({
    customers: {
      id: t.text().primaryKey(),
      name: t.text(),
      email: t.text().unique(),
      createdAt: t.timestamp().partitionBy(),
      nickname: t.text(), // added by the ALTER above
      vip: t.boolean(), // new in code, not yet in the store
    },
    orders: { ...schemaTableClone(), note: t.text() },
  }),
});
const grownRows = await grown.sql`SELECT name, vip FROM customers WHERE name = ${"Ada"}`;
ok("additive drift auto-migrates", grownRows.length === 1 && grownRows[0].vip === null, fmt(grownRows));

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
