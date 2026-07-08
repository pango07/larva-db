/**
 * Compile-time tests for typed row inference. Never executed — only
 * typechecked (bunx tsc --noEmit). Every line here failing to compile is a
 * regression; every @ts-expect-error compiling is one too.
 */
import { defineSchema, InferRow, larva, t } from "@larva-db/core";

const schema = defineSchema({
  customers: {
    id: t.text().primaryKey(),
    name: t.text(),
    age: t.integer(),
    active: t.boolean(),
    createdAt: t.timestamp().partitionBy(),
  },
});

type Customer = InferRow<typeof schema, "customers">;

declare const customer: Customer;

// primaryKey() strips null; plain columns are nullable
const id: string = customer.id;
const name: string | null = customer.name;
const age: number | null = customer.age;
const active: boolean | null = customer.active;
const createdAt: string | null = customer.createdAt;

// @ts-expect-error name is nullable, not plain string
const nameStrict: string = customer.name;

// @ts-expect-error no such column
const missing = customer.nope;

// @ts-expect-error no such table
type Nope = InferRow<typeof schema, "orders">;

// queries accept the inferred row type
const db = larva({ schema });
const typedRows: Promise<Customer[]> = db.sql<Customer>`SELECT * FROM customers`;

void [id, name, age, active, createdAt, nameStrict, missing, typedRows];
export type { Nope };
