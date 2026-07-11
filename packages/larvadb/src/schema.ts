import { Row, Scalar, ulid, uuidv7 } from "./core";

/**
 * Code-first schema (Design §8). The canonical schema lives in the app repo so
 * it sits in the agent's context window; it is embedded into the manifest and
 * drift between the two is a loud startup error.
 *
 * `json` columns are deferred to a later increment — the type is reserved so
 * the error can say so precisely.
 */

export type ColumnType = "text" | "integer" | "real" | "boolean" | "timestamp";

export interface ColumnDef {
  type: ColumnType;
  primaryKey: boolean;
  unique: boolean;
  references?: string;
  partitionBy: boolean;
  /** Auto-assigned integer drawn from a CAS-claimed range (format 2 stores).
   * Gappy on crash, like a Postgres sequence; values are unique across
   * processes because claimed ranges are disjoint. */
  sequence?: boolean;
  /** Auto-filled with a time-ordered UUIDv7 when omitted on INSERT (format 2
   * stores). The writer invents the value, so unlike sequence there is
   * nothing to coordinate — contention-free identity. */
  uuid?: boolean;
}

export interface TableSchema {
  columns: Record<string, ColumnDef>;
  primaryKey: string;
  partitionColumn?: string;
  /** Composite UNIQUE constraints (two or more columns each; format 2 stores).
   * Enforced on INSERT and upsert, like single-column .unique(). */
  uniques?: string[][];
}

export type DatabaseSchema = Record<string, TableSchema>;

export class SchemaError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SchemaError";
  }
}

/** Carries the column's TypeScript value type as a phantom, so row types can
 * be inferred from the schema (see InferTables / InferRow). Columns are
 * nullable by default; primaryKey() removes null. */
export class ColumnBuilder<T> {
  declare readonly $type: T;
  private def: ColumnDef;

  constructor(type: ColumnType) {
    this.def = { type, primaryKey: false, unique: false, partitionBy: false };
  }

  primaryKey(): ColumnBuilder<NonNullable<T>> {
    this.def.primaryKey = true;
    return this as unknown as ColumnBuilder<NonNullable<T>>;
  }

  unique(): this {
    this.def.unique = true;
    return this;
  }

  references(target: string): this {
    this.def.references = target;
    return this;
  }

  /** Maintain zone-map statistics on this column so range/equality filters prune chunks. */
  partitionBy(): this {
    this.def.partitionBy = true;
    return this;
  }

  /** @internal — use t.sequence(). */
  markSequence(): this {
    this.def.sequence = true;
    return this;
  }

  /** @internal — use t.uuid(). */
  markUuid(): this {
    this.def.uuid = true;
    return this;
  }

  build(): ColumnDef {
    return { ...this.def };
  }
}

export const t = {
  text: () => new ColumnBuilder<string | null>("text"),
  integer: () => new ColumnBuilder<number | null>("integer"),
  real: () => new ColumnBuilder<number | null>("real"),
  boolean: () => new ColumnBuilder<boolean | null>("boolean"),
  timestamp: () => new ColumnBuilder<string | null>("timestamp"),
  /** Auto-assigned integer: omit it on INSERT and Larva fills the next number.
   * Numbers are unique across concurrent processes (disjoint CAS-claimed
   * ranges) but gappy on crash — same contract as a Postgres sequence. */
  sequence: () => new ColumnBuilder<number | null>("integer").markSequence(),
  /** Auto-ID: omit it on INSERT and Larva fills a time-ordered UUID (v7).
   * Nothing to coordinate across processes — each writer invents the value —
   * and time-ordering keeps new rows clustered for zone-map pruning. */
  uuid: () => new ColumnBuilder<string | null>("text").markUuid(),
  json: (): never => {
    throw new SchemaError(
      "UNSUPPORTED_COLUMN_TYPE",
      "t.json() is reserved but not implemented in this prototype; use t.text() and JSON.stringify for now",
    );
  },
};

type SchemaSpec = Record<string, Record<string, ColumnBuilder<unknown>>>;

/** What defineSchema returns: the runtime DatabaseSchema plus a phantom brand
 * carrying the spec's types, so InferRow/InferTables can read them back. */
export type TypedSchema<S extends SchemaSpec = SchemaSpec> = DatabaseSchema & {
  readonly "~spec": S;
};

/** Row types inferred from a defineSchema() result.
 * Note: a table with no declared primary key gets an implicit `id: string`
 * column at runtime that inference cannot see — declare it for typed rows. */
export type InferTables<TSchema extends TypedSchema> = {
  [T in keyof TSchema["~spec"]]: {
    [C in keyof TSchema["~spec"][T]]: TSchema["~spec"][T][C] extends ColumnBuilder<infer V> ? V : never;
  };
};

export type InferRow<
  TSchema extends TypedSchema,
  T extends keyof TSchema["~spec"],
> = InferTables<TSchema>[T];

export interface SchemaOptions<S extends SchemaSpec = SchemaSpec> {
  /** Composite UNIQUE constraints per table, e.g. { orders: [["customerId", "sku"]] }.
   * Single-column uniqueness belongs on the column: t.text().unique(). */
  uniques?: Partial<Record<keyof S & string, string[][]>>;
}

export function defineSchema<S extends SchemaSpec>(spec: S, opts?: SchemaOptions<S>): TypedSchema<S> {
  for (const table of Object.keys(opts?.uniques ?? {})) {
    if (!spec[table]) {
      throw new SchemaError("UNKNOWN_TABLE", `uniques declares constraints for table "${table}", which is not in the schema`);
    }
  }
  const schema: DatabaseSchema = {};
  for (const [table, cols] of Object.entries(spec)) {
    const columns: Record<string, ColumnDef> = {};
    for (const [name, builder] of Object.entries(cols)) columns[name] = builder.build();

    const pks = Object.entries(columns).filter(([, c]) => c.primaryKey);
    if (pks.length > 1) {
      throw new SchemaError("MULTIPLE_PRIMARY_KEYS", `table "${table}" declares ${pks.length} primary keys; declare exactly one`);
    }
    let primaryKey = pks[0]?.[0];
    if (!primaryKey) {
      // Implicit ULID id so updates and deletes can always address rows (Design §5).
      if (columns.id) {
        throw new SchemaError(
          "AMBIGUOUS_ID_COLUMN",
          `table "${table}" has an "id" column that is not the primary key; mark it .primaryKey() or rename it`,
        );
      }
      columns.id = { type: "text", primaryKey: true, unique: false, partitionBy: false };
      primaryKey = "id";
    }

    const parts = Object.entries(columns).filter(([, c]) => c.partitionBy);
    if (parts.length > 1) {
      throw new SchemaError("MULTIPLE_PARTITION_COLUMNS", `table "${table}" declares ${parts.length} partitionBy columns; declare at most one`);
    }

    const uniques = opts?.uniques?.[table];
    if (uniques) {
      for (const cols of uniques) {
        if (cols.length < 2) {
          throw new SchemaError(
            "INVALID_COMPOSITE_UNIQUE",
            `composite unique on "${table}" lists ${cols.length} column(s); use .unique() on the column for single-column uniqueness`,
          );
        }
        for (const c of cols) {
          if (!columns[c]) {
            throw new SchemaError("UNKNOWN_COLUMN", `composite unique on "${table}" references column "${c}", which does not exist`);
          }
        }
        if (new Set(cols).size !== cols.length) {
          throw new SchemaError("INVALID_COMPOSITE_UNIQUE", `composite unique on "${table}" repeats a column: (${cols.join(", ")})`);
        }
      }
    }

    schema[table] = { columns, primaryKey, partitionColumn: parts[0]?.[0], ...(uniques?.length ? { uniques } : {}) };
  }
  return schema as TypedSchema<S>;
}

const typeOk = (type: ColumnType, v: Scalar): boolean => {
  if (v === null) return true;
  switch (type) {
    case "text":
    case "timestamp":
      return typeof v === "string";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "real":
      return typeof v === "number";
    case "boolean":
      return typeof v === "boolean";
  }
};

/** Validate and normalize a row for insert: fill the implicit pk, check types and column names. */
export function validateInsert(table: string, schema: TableSchema, row: Row): Row {
  const out: Row = {};
  for (const key of Object.keys(row)) {
    if (!schema.columns[key]) {
      throw new SchemaError(
        "UNKNOWN_COLUMN",
        `column "${key}" does not exist in table "${table}" (columns: ${Object.keys(schema.columns).join(", ")})`,
      );
    }
  }
  for (const [name, def] of Object.entries(schema.columns)) {
    let v = row[name] ?? null;
    // Sequence values are claimed (async) by the insert planner before
    // validation; a null here means the planner was bypassed.
    if (v === null && def.sequence) {
      throw new SchemaError("SEQUENCE_UNASSIGNED", `sequence column "${table}.${name}" was not assigned; insert through db.sql\`INSERT …\``);
    }
    if (v === null && def.uuid) v = uuidv7();
    if (v === null && name === schema.primaryKey) v = ulid();
    if (!typeOk(def.type, v)) {
      throw new SchemaError(
        "TYPE_MISMATCH",
        `column "${table}.${name}" is ${def.type}, got ${JSON.stringify(v)}`,
      );
    }
    out[name] = v;
  }
  return out;
}

/**
 * Columns added by ALTER TABLE (or additive drift migration) after a chunk was
 * written are absent from its stored rows — they read as NULL (Design §7).
 * Returns the input array untouched when every row is already complete;
 * never mutates rows (chunk caches hand out shared arrays).
 */
export function fillAbsentColumns(rows: Row[], schema: TableSchema): Row[] {
  const cols = Object.keys(schema.columns);
  let filled = false;
  const out = rows.map((r) => {
    const missing = cols.filter((c) => !(c in r));
    if (missing.length === 0) return r;
    filled = true;
    const full = { ...r };
    for (const c of missing) full[c] = null;
    return full;
  });
  return filled ? out : rows;
}

/** Compare code-first schema against the manifest's; return human-readable drift descriptions. */
export function schemaDrift(code: DatabaseSchema, manifest: DatabaseSchema): string[] {
  const drift: string[] = [];
  for (const [table, codeTable] of Object.entries(code)) {
    const live = manifest[table];
    if (!live) continue; // missing tables are created, not drift
    for (const [col, def] of Object.entries(codeTable.columns)) {
      const liveCol = live.columns[col];
      if (!liveCol) drift.push(`table "${table}": column "${col}" is in code but not in the store`);
      else if (liveCol.type !== def.type) drift.push(`table "${table}.${col}": code says ${def.type}, store says ${liveCol.type}`);
    }
    for (const col of Object.keys(live.columns)) {
      if (!codeTable.columns[col]) drift.push(`table "${table}": column "${col}" exists in the store but not in code`);
    }
    if (live.primaryKey !== codeTable.primaryKey) {
      drift.push(`table "${table}": primary key differs (code "${codeTable.primaryKey}", store "${live.primaryKey}")`);
    }
    if ((live.partitionColumn ?? null) !== (codeTable.partitionColumn ?? null)) {
      drift.push(`table "${table}": partition column differs (code "${codeTable.partitionColumn}", store "${live.partitionColumn}")`);
    }
    const uniqKey = (u?: string[][]) => JSON.stringify((u ?? []).map((cols) => [...cols].sort()).sort());
    if (uniqKey(live.uniques) !== uniqKey(codeTable.uniques)) {
      drift.push(`table "${table}": composite unique constraints differ between code and store`);
    }
    for (const [col, def] of Object.entries(codeTable.columns)) {
      const liveCol = live.columns[col];
      if (liveCol && (liveCol.sequence ?? false) !== (def.sequence ?? false)) {
        drift.push(`table "${table}.${col}": sequence flag differs between code and store`);
      }
      if (liveCol && (liveCol.uuid ?? false) !== (def.uuid ?? false)) {
        drift.push(`table "${table}.${col}": uuid flag differs between code and store`);
      }
    }
  }
  return drift;
}
