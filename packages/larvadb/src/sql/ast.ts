import { Scalar } from "../core";

export interface ColumnRef {
  kind: "column";
  table?: string;
  name: string;
}

export interface Literal {
  kind: "literal";
  value: Scalar;
}

export interface Param {
  kind: "param";
  index: number;
}

export type CompareOp = "=" | "!=" | "<" | ">" | "<=" | ">=";
export type ArithOp = "+" | "-" | "*" | "/";

export type AggFunc = "COUNT" | "SUM" | "AVG" | "MIN" | "MAX";
export type ScalarFunc = "UPPER" | "LOWER" | "LENGTH" | "TRIM" | "ROUND" | "ABS" | "COALESCE" | "SUBSTR";

export interface Aggregate {
  kind: "aggregate";
  func: AggFunc;
  /** null = COUNT(*) */
  arg: Expr | null;
  distinct: boolean;
}

export type Expr =
  | ColumnRef
  | Literal
  | Param
  | Aggregate
  | { kind: "binary"; op: CompareOp | ArithOp | "AND" | "OR" | "||"; left: Expr; right: Expr }
  | { kind: "not"; expr: Expr }
  | { kind: "in"; expr: Expr; list: Expr[]; negated: boolean }
  | { kind: "between"; expr: Expr; lo: Expr; hi: Expr; negated: boolean }
  | { kind: "like"; expr: Expr; pattern: Expr; negated: boolean }
  | { kind: "isnull"; expr: Expr; negated: boolean }
  | { kind: "func"; name: ScalarFunc; args: Expr[] }
  | { kind: "case"; branches: { when: Expr; then: Expr }[]; else?: Expr };

export interface SelectItem {
  expr: Expr;
  alias?: string;
}

export interface TableRef {
  table: string;
  alias?: string;
}

export interface SelectStmt {
  kind: "select";
  /** null = SELECT * */
  items: SelectItem[] | null;
  distinct: boolean;
  from: TableRef;
  join?: { type: "inner" | "left"; table: TableRef; leftCol: ColumnRef; rightCol: ColumnRef };
  where?: Expr;
  groupBy?: ColumnRef[];
  having?: Expr;
  orderBy?: { column: ColumnRef; desc: boolean }[];
  limit?: Expr;
  offset?: Expr;
}

export interface OnConflict {
  /** The conflict target: must be the primary key or a UNIQUE column. */
  column?: string;
  /** "nothing" = DO NOTHING; otherwise the DO UPDATE SET list (values may reference excluded.*) */
  action: "nothing" | { set: { column: string; value: Expr }[] };
}

export interface InsertStmt {
  kind: "insert";
  table: string;
  columns: string[];
  rows: Expr[][];
  onConflict?: OnConflict;
  returning: SelectItem[] | null | undefined; // undefined = no RETURNING, null = RETURNING *
}

export interface UpdateStmt {
  kind: "update";
  table: string;
  set: { column: string; value: Expr }[];
  where?: Expr;
  returning: SelectItem[] | null | undefined;
}

export interface DeleteStmt {
  kind: "delete";
  table: string;
  where?: Expr;
  returning: SelectItem[] | null | undefined;
}

export interface CreateTableStmt {
  kind: "create";
  table: string;
  columns: { name: string; type: string; primaryKey: boolean; unique: boolean }[];
}

export interface DropTableStmt {
  kind: "drop";
  table: string;
}

export type Statement = SelectStmt | InsertStmt | UpdateStmt | DeleteStmt | CreateTableStmt | DropTableStmt;

/** True if the expression contains an aggregate anywhere (not descending into nothing — aggregates cannot nest). */
export function hasAggregate(e: Expr): boolean {
  switch (e.kind) {
    case "aggregate":
      return true;
    case "binary":
      return hasAggregate(e.left) || hasAggregate(e.right);
    case "not":
      return hasAggregate(e.expr);
    case "in":
      return hasAggregate(e.expr) || e.list.some(hasAggregate);
    case "between":
      return hasAggregate(e.expr) || hasAggregate(e.lo) || hasAggregate(e.hi);
    case "like":
      return hasAggregate(e.expr) || hasAggregate(e.pattern);
    case "isnull":
      return hasAggregate(e.expr);
    case "func":
      return e.args.some(hasAggregate);
    case "case":
      return (
        e.branches.some((b) => hasAggregate(b.when) || hasAggregate(b.then)) ||
        (e.else !== undefined && hasAggregate(e.else))
      );
    default:
      return false;
  }
}

/**
 * Rewrite an expression, replacing each column reference for which `fn`
 * returns a substitute (return null to keep the reference). Aggregate
 * arguments are rewritten too. Used for HAVING alias resolution and for
 * substituting excluded.* in ON CONFLICT DO UPDATE.
 */
export function mapColumnRefs(e: Expr, fn: (c: ColumnRef) => Expr | null): Expr {
  const m = (x: Expr): Expr => mapColumnRefs(x, fn);
  switch (e.kind) {
    case "column":
      return fn(e) ?? e;
    case "literal":
    case "param":
      return e;
    case "aggregate":
      return { ...e, arg: e.arg === null ? null : m(e.arg) };
    case "binary":
      return { ...e, left: m(e.left), right: m(e.right) };
    case "not":
      return { ...e, expr: m(e.expr) };
    case "in":
      return { ...e, expr: m(e.expr), list: e.list.map(m) };
    case "between":
      return { ...e, expr: m(e.expr), lo: m(e.lo), hi: m(e.hi) };
    case "like":
      return { ...e, expr: m(e.expr), pattern: m(e.pattern) };
    case "isnull":
      return { ...e, expr: m(e.expr) };
    case "func":
      return { ...e, args: e.args.map(m) };
    case "case":
      return {
        ...e,
        branches: e.branches.map((b) => ({ when: m(b.when), then: m(b.then) })),
        else: e.else === undefined ? undefined : m(e.else),
      };
  }
}

/** Collect every bare/qualified column reference that sits OUTSIDE any aggregate. */
export function ungroupedColumns(e: Expr, out: ColumnRef[] = []): ColumnRef[] {
  switch (e.kind) {
    case "column":
      out.push(e);
      break;
    case "aggregate":
      break; // columns inside an aggregate are always legal
    case "binary":
      ungroupedColumns(e.left, out);
      ungroupedColumns(e.right, out);
      break;
    case "not":
      ungroupedColumns(e.expr, out);
      break;
    case "in":
      ungroupedColumns(e.expr, out);
      e.list.forEach((x) => ungroupedColumns(x, out));
      break;
    case "between":
      ungroupedColumns(e.expr, out);
      ungroupedColumns(e.lo, out);
      ungroupedColumns(e.hi, out);
      break;
    case "like":
      ungroupedColumns(e.expr, out);
      ungroupedColumns(e.pattern, out);
      break;
    case "isnull":
      ungroupedColumns(e.expr, out);
      break;
    case "func":
      e.args.forEach((x) => ungroupedColumns(x, out));
      break;
    case "case":
      e.branches.forEach((b) => {
        ungroupedColumns(b.when, out);
        ungroupedColumns(b.then, out);
      });
      if (e.else) ungroupedColumns(e.else, out);
      break;
  }
  return out;
}
