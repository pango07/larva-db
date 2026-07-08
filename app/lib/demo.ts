import { defineSchema, larva, LarvaDb, t } from "@larva-db/core";

/** The demo database behind the SQL console — quickstart schema, seeded. */
export const demoSchema = defineSchema({
  customers: {
    id: t.text().primaryKey(),
    name: t.text(),
    email: t.text().unique(),
    city: t.text(),
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

const PREFIX = "demo/v1/";
let dbPromise: Promise<LarvaDb> | null = null;

export function demoDb(): Promise<LarvaDb> {
  dbPromise ??= (async () => {
    const db = larva({ schema: demoSchema, prefix: PREFIX });
    const [{ n }] = await db.sql`SELECT COUNT(*) AS n FROM customers`;
    if (Number(n) === 0) await seed(db);
    return db;
  })();
  return dbPromise;
}

export async function resetDemo(): Promise<void> {
  const db = await demoDb();
  await db.destroy();
  dbPromise = null;
  await demoDb();
}

async function seed(db: LarvaDb): Promise<void> {
  const customers = await db.sql`INSERT INTO customers (name, email, city, createdAt) VALUES
    (${"Ada Lovelace"}, ${"ada@example.com"}, ${"London"}, ${"2026-05-03T09:00:00Z"}),
    (${"Grace Hopper"}, ${"grace@example.com"}, ${"New York"}, ${"2026-05-11T14:30:00Z"}),
    (${"Alan Turing"}, ${"alan@example.com"}, ${"London"}, ${"2026-05-20T10:15:00Z"}),
    (${"Katherine Johnson"}, ${"katherine@example.com"}, ${"Hampton"}, ${"2026-06-02T16:45:00Z"}),
    (${"Edsger Dijkstra"}, ${"edsger@example.com"}, ${"Austin"}, ${"2026-06-14T08:20:00Z"}),
    (${"Barbara Liskov"}, ${"barbara@example.com"}, ${"Boston"}, ${"2026-06-25T11:00:00Z"})
    RETURNING id`;
  const ids = customers.map((c) => String(c.id));
  const statuses = ["paid", "paid", "pending", "paid", "refunded"];
  // one multi-row insert per month → one chunk per month, so date filters visibly prune
  for (const [batch, month] of [
    [0, "2026-05"],
    [1, "2026-06"],
    [2, "2026-07"],
  ] as const) {
    const rows = Array.from({ length: 8 }, (_, i) => [
      ids[(batch * 3 + i) % ids.length],
      Math.round((20 + ((batch * 8 + i) * 137) % 480) * 100) / 100,
      statuses[(batch + i) % statuses.length],
      `${month}-${String(2 + i * 3).padStart(2, "0")}T12:00:00Z`,
    ]);
    await db.query(
      `INSERT INTO orders (customerId, total, status, createdAt) VALUES ${rows.map(() => "(?, ?, ?, ?)").join(", ")}`,
      rows.flat(),
    );
  }
}
