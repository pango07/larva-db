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

// v2 schema features: sequence inference and typed composite uniques
const v2 = defineSchema(
  {
    invoices: {
      number: t.sequence().primaryKey(),
      customer: t.text(),
    },
  },
  { uniques: { invoices: [["number", "customer"]] } },
);

type Invoice = InferRow<typeof v2, "invoices">;
declare const invoice: Invoice;

// sequence is an integer column; primaryKey() strips null
const invoiceNumber: number = invoice.number;

// @ts-expect-error sequence pk is a number, not a string
const invoiceNumberStr: string = invoice.number;

const v2nullable = defineSchema({ tickets: { id: t.text().primaryKey(), counter: t.sequence() } });
type Ticket = InferRow<typeof v2nullable, "tickets">;
declare const ticket: Ticket;
const counter: number | null = ticket.counter;

// @ts-expect-error uniques keys must be table names in the schema
defineSchema({ a: { id: t.text().primaryKey() } }, { uniques: { b: [["id", "id"]] } });

// uuid is a text column; primaryKey() strips null
const withUuid = defineSchema({ orders: { id: t.uuid().primaryKey(), memo: t.text(), ref: t.uuid() } });
type Order = InferRow<typeof withUuid, "orders">;
declare const order: Order;
const orderId: string = order.id;
const orderRef: string | null = order.ref;

// @ts-expect-error uuid pk is a string, not a number
const orderIdNum: number = order.id;

void [v2, invoiceNumber, invoiceNumberStr, v2nullable, counter, withUuid, orderId, orderRef, orderIdNum];
