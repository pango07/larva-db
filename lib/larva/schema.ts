import { Row, Scalar, ulid } from "./core";

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
}

export interface TableSchema {
  columns: Record<string, ColumnDef>;
  primaryKey: string;
  partitionColumn?: string;
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

export class ColumnBuilder {
  private def: ColumnDef;

  constructor(type: ColumnType) {
    this.def = { type, primaryKey: false, unique: false, partitionBy: false };
  }

  primaryKey(): this {
    this.def.primaryKey = true;
    return this;
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

  build(): ColumnDef {
    return { ...this.def };
  }
}

export const t = {
  text: () => new ColumnBuilder("text"),
  integer: () => new ColumnBuilder("integer"),
  real: () => new ColumnBuilder("real"),
  boolean: () => new ColumnBuilder("boolean"),
  timestamp: () => new ColumnBuilder("timestamp"),
  json: (): never => {
    throw new SchemaError(
      "UNSUPPORTED_COLUMN_TYPE",
      "t.json() is reserved but not implemented in this prototype; use t.text() and JSON.stringify for now",
    );
  },
};

export function defineSchema(spec: Record<string, Record<string, ColumnBuilder>>): DatabaseSchema {
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

    schema[table] = { columns, primaryKey, partitionColumn: parts[0]?.[0] };
  }
  return schema;
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
  }
  return drift;
}
