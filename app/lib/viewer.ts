import { demoSchema } from "@/app/lib/demo";

/** The client-facing description of one table's shape — enough to render the
 * full table structure (headers, pk/partition badges) before any row loads. */
export interface TableMeta {
  columns: string[];
  types: Record<string, string>;
  primaryKey: string;
  partitionColumn: string | null;
}

export function tableMeta(table: string): TableMeta | null {
  const spec = demoSchema[table];
  if (!spec) return null;
  const columns = Object.keys(spec.columns);
  return {
    columns,
    types: Object.fromEntries(columns.map((c) => [c, spec.columns[c].type])),
    primaryKey: spec.primaryKey,
    partitionColumn: spec.partitionColumn ?? null,
  };
}

/** Every table's shape, keyed by name — shipped with the inspect response so the
 * viewer can draw the skeleton table immediately. */
export function schemaMeta(): Record<string, TableMeta> {
  return Object.fromEntries(Object.keys(demoSchema).map((t) => [t, tableMeta(t)!]));
}
