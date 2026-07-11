<!-- Paste this file into your agent's instructions (CLAUDE.md, AGENTS.md,
     .cursorrules, a system prompt). It is also served at /llms.txt on any
     deployed Larva test lab. Canonical source: docs/larva-for-agents.md -->

# Working with LarvaDB (@larva-db/core)

This project uses **Larva**, a SQL database that lives inside a Vercel Blob /
S3 / R2 object store. You query it with real SQL through tagged templates.

## Querying

- Query with `db.sql` tagged templates. ALWAYS interpolate values with
  `${...}` — they are parameterized automatically. Never build SQL by string
  concatenation.
- The schema is defined in code with `defineSchema` — use those exact table
  and column names.
- Timestamps are ISO 8601 text. Compare them directly as strings:
  `WHERE createdAt >= ${"2026-07-01"}`.

## Supported SQL

- `SELECT` (with `DISTINCT`) over expressions: arithmetic, `||` concatenation,
  `CASE WHEN`, `CAST(x AS text/integer/real/boolean)`.
- Scalar functions: `UPPER`, `LOWER`, `LENGTH`, `TRIM`, `ROUND`, `ABS`,
  `COALESCE`, `NULLIF`, `IFNULL`, `REPLACE`, `CEIL`, `FLOOR`, `MOD`, `SUBSTR`.
- Dates: `NOW()`, `CURRENT_TIMESTAMP`, `DATE(x)`, `STRFTIME('%Y-%m', x)`.
- JSON over text columns: `JSON_EXTRACT(col, '$.a.b[0]')` and `col ->> 'key'`.
- `WHERE` with `=`, `!=`, `<`, `>`, `<=`, `>=`, `AND`, `OR`, `NOT`, `IN`,
  `BETWEEN`, `LIKE`, `IS NULL`.
- `ORDER BY` (columns or select aliases), `LIMIT` / `OFFSET`.
- `GROUP BY` over expressions or aliases (e.g. `GROUP BY DATE(createdAt)`)
  with `COUNT` / `SUM` / `AVG` / `MIN` / `MAX` / `GROUP_CONCAT(x, sep)`,
  including `COUNT(DISTINCT col)`, plus `HAVING`.
- `INNER JOIN` and `LEFT JOIN` on equality — any number of tables, including
  self-joins (alias each occurrence: `FROM staff e JOIN staff m ON
  e.managerId = m.id`).
- Uncorrelated subqueries: `WHERE id IN (SELECT ...)`, `NOT IN (SELECT ...)`,
  and scalar comparisons like `WHERE total > (SELECT AVG(total) FROM orders)`.
  The subquery must NOT reference the outer query's tables (no correlation) —
  use a JOIN for that. NULLs in the subquery result are ignored, so
  `NOT IN (SELECT ...)` behaves the way you intend even when the inner column
  has NULLs (unlike standard SQL's NULL trap).
- `INSERT ... RETURNING`, multi-row, with upsert:
  `ON CONFLICT (col) DO NOTHING` or `DO UPDATE SET col = excluded.col`.
  The conflict target must be the primary key, a UNIQUE column, or the exact
  columns of a composite unique declared in the schema
  (`ON CONFLICT (userId, feature) DO UPDATE ...`).
- `UPDATE ... WHERE`, `DELETE ... WHERE`, `CREATE TABLE`, `DROP TABLE`.
- `ALTER TABLE t ADD COLUMN name type` — plain nullable columns only.
  Existing rows read the new column as NULL; backfill with UPDATE if needed.

## Schema features to know

- A `t.uuid()` column is an auto-assigned ID: OMIT it on INSERT and read the
  generated UUID back with `RETURNING`. Prefer it for row identity — the
  writer invents the value, so nothing ever contends. Supplying your own
  value is allowed and respected.
- A `t.sequence()` column is an auto-assigned integer: OMIT it on INSERT and
  read the assigned value back with `RETURNING`. Never generate the number
  yourself. Numbers are unique across concurrent writers but gappy (like a
  Postgres sequence). Use it when humans need small numbers (invoice #42);
  otherwise prefer `t.uuid()`.
- Composite unique constraints come from `defineSchema`'s second argument:
  `defineSchema(spec, { uniques: { orders: [["customerId", "sku"]] } })`.

## NOT supported — do not emit

Correlated subqueries, subqueries in `FROM` (derived tables), window
functions, `UNION`, `RIGHT`/`FULL`/`CROSS` joins, `DROP COLUMN`/`RENAME`,
views, triggers, nested aggregates. If a query needs these, fetch the data
and compute in application code instead — tables here are small. Rejections
name the feature and say what to do instead; read the error message and
follow it.

## Guardrails

- `UPDATE` or `DELETE` without a `WHERE` clause is rejected unless you pass
  `{ allowFullTable: true }`. Only pass it when a full-table write is truly
  intended.
- Use `db.transaction(async (tx) => { ... })` for multi-statement changes —
  they commit atomically or not at all.
- Writes can throw `ConflictError` under heavy concurrency after retries.
  Surface it; never swallow it.
- If something goes wrong, `db.asOf(pastDate)` reads an old version and
  `db.rollbackTo(version)` restores it — destructive mistakes are reversible.

## Performance rules of thumb

- Filters on the primary key or the one `.partitionBy()` column prune
  storage reads aggressively. Filter on the RAW column:
  `createdAt >= ${"2026-07-01"}` prunes; `DATE(createdAt) >= ...` scans
  (still correct, just slower).
- Everything else scans the table — fine at tens of thousands of rows.
- Write throughput is roughly one commit per second across all writers;
  batch related statements into one transaction instead of many commits.

## Getting data out

- `db.export({ format: "postgres" })` → one `.sql` file; load with
  `psql $DATABASE_URL < export.sql`.
- `db.export({ format: "sqlite" })` → a genuine SQLite `.db` file.
- `db.export({ format: "json" })` / `{ format: "csv" }` for everything else.
- From a shell: `npx larva sql "..."`, `npx larva export --format postgres` —
  same database, same dialect, same errors (needs BLOB_READ_WRITE_TOKEN).
