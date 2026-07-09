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
- Two-table `INNER JOIN` and `LEFT JOIN` on equality.
- `INSERT ... RETURNING`, multi-row, with upsert:
  `ON CONFLICT (col) DO NOTHING` or `DO UPDATE SET col = excluded.col`
  (the conflict target must be the primary key or a UNIQUE column).
- `UPDATE ... WHERE`, `DELETE ... WHERE`, `CREATE TABLE`, `DROP TABLE`.

## NOT supported — do not emit

Subqueries, window functions, `UNION`, self-joins, joins of 3+ tables,
`ALTER TABLE`, views, triggers, nested aggregates. If a query needs these,
fetch the data and compute in application code instead — tables here are
small. Rejections name the feature and say what to do instead; read the
error message and follow it.

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
