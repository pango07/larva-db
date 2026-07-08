# Larva — Quickstart

**A tiny SQL database that lives inside your Vercel Blob storage.** No signup, no new vendor, no server. When your app grows up, export to a bigger database with one command — that's why it's called Larva.

Good for: dashboards, internal tools, small apps, prototypes, anything an AI agent is building for you.
Not for: apps with heavy traffic or millions of rows. (When you get there, congratulations — see "Growing up" below.)

## 1. Install

```bash
npm install larvadb
```

Make sure your Vercel project has a **private Blob store** connected (Vercel dashboard → Storage → Create → Blob → Private). That's the whole setup — Larva finds the credentials Vercel already put in your environment.

## 2. Describe your data

Create a file called `schema.ts`. This tells Larva (and your AI agent) what your data looks like:

```ts
import { defineSchema, t } from "larvadb";

export const schema = defineSchema({
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
```

Tip: put `.partitionBy()` on the column you'll filter by most (usually a date). It makes those queries much faster.

## 3. Use it

```ts
import { larva } from "larvadb";
import { schema } from "./schema";

const db = larva({ schema });

// Add data — ${...} values are automatically made safe
await db.sql`INSERT INTO customers (name, email) VALUES (${"Ada"}, ${"ada@example.com"})`;

// Query with plain SQL
const recent = await db.sql`
  SELECT customers.name, orders.total
  FROM orders
  INNER JOIN customers ON orders.customerId = customers.id
  WHERE orders.createdAt > ${"2026-06-01"}
  ORDER BY orders.total DESC
  LIMIT 10
`;

// Do several things as one all-or-nothing step
await db.transaction(async (tx) => {
  await tx.sql`INSERT INTO orders (customerId, total, status) VALUES (${id}, ${99.5}, ${"paid"})`;
  await tx.sql`UPDATE customers SET name = ${"Ada L."} WHERE id = ${id}`;
});
```

## 4. The undo button

Every change Larva makes is versioned. If something goes wrong — say your agent deleted the wrong rows — you can look at the past and put it back:

```ts
const tenMinutesAgo = await db.asOf(new Date(Date.now() - 10 * 60 * 1000));
await tenMinutesAgo.sql`SELECT COUNT(*) FROM customers`;  // peek at the past

await db.rollbackTo(tenMinutesAgo.version);               // restore it
```

History is kept for 7 days (or the last 50 versions, whichever is more).

## 5. Growing up (the escape hatch)

Larva is for small apps. You've outgrown it if you need more than a handful of writes per second, or your tables reach millions of rows. When that happens:

```bash
npx larva export --format sqlite   # a real SQLite file → import into Turso, D1, etc.
npx larva export --format csv      # spreadsheets, Postgres COPY
```

Your data is never trapped. That's a promise, not a feature.

---

## For your AI agent — paste this into its instructions

> This project uses **Larva** (`larvadb`), a SQL database on Vercel Blob. Query with `db.sql` tagged templates and always interpolate values with `${...}` (parameterized automatically) — never build SQL by string concatenation. The schema is defined in `schema.ts`; use those exact table and column names.
>
> **Supported SQL:** SELECT with WHERE (=, !=, <, >, <=, >=, AND, OR, NOT, IN, BETWEEN, LIKE, IS NULL), ORDER BY, LIMIT/OFFSET, GROUP BY with COUNT/SUM/AVG/MIN/MAX, two-table INNER JOIN and LEFT JOIN on equality; INSERT (with RETURNING), UPDATE ... WHERE, DELETE ... WHERE, CREATE TABLE, DROP TABLE.
>
> **Not supported (do not emit):** subqueries, HAVING, window functions, UNION, self-joins, 3+ table joins, ALTER TABLE, views, triggers. If a query needs these, fetch the data and compute in TypeScript instead — tables here are small.
>
> UPDATE or DELETE without a WHERE clause is rejected unless `{ allowFullTable: true }` is passed. Use `db.transaction(async (tx) => { ... })` for multi-statement changes. Writes can throw `ConflictError` under concurrency after retries — surface it, don't swallow it. Filters on the primary key or the `.partitionBy()` column are fast; other columns scan the table, which is fine at this scale.
