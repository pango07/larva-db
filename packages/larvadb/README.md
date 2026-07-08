# larvadb

**A tiny SQL database that lives inside your Vercel Blob store.** No signup, no new vendor, no server. When your app grows up, export to a bigger database with one command — that's why it's called Larva.

```bash
npm install @larva-db/core
```

```ts
import { defineSchema, larva, t } from "@larva-db/core";

const schema = defineSchema({
  customers: {
    id: t.text().primaryKey(),
    name: t.text(),
    email: t.text().unique(),
    createdAt: t.timestamp().partitionBy(),
  },
});

const db = larva({ schema }); // credentials auto-discovered from the Vercel env

await db.sql`INSERT INTO customers (name, email) VALUES (${"Ada"}, ${"ada@example.com"}) RETURNING *`;
await db.sql`SELECT * FROM customers WHERE createdAt > ${"2026-06-01"} ORDER BY name LIMIT 10`;

await db.transaction(async (tx) => {
  await tx.sql`INSERT INTO orders (customerId, total) VALUES (${id}, ${99.5})`;
  await tx.sql`UPDATE inventory SET count = count - 1 WHERE sku = ${"widget"}`;
});

const past = await db.asOf(new Date(Date.now() - 600_000)); // the undo button
await db.rollbackTo(past.version);

await db.export({ format: "sqlite" }); // the escape hatch
await db.vacuum();
```

Storage backends: Vercel Blob (default), or any S3-compatible store (AWS S3, Cloudflare R2) via `new S3Adapter({...})`.

Full design document, dialect reference, and honest performance envelope: https://github.com/pango07/larva-db

**Good for:** dashboards, internal tools, small apps, prototypes, anything an AI agent is building for you.
**Not for:** heavy write traffic or queries that must scan millions of rows — export and graduate when you get there.
