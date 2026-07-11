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

export type AggFunc = "COUNT" | "SUM" | "AVG" | "MIN" | "MAX" | "GROUP_CONCAT";
export type ScalarFunc =
  | "UPPER" | "LOWER" | "LENGTH" | "TRIM" | "ROUND" | "ABS" | "COALESCE" | "SUBSTR"
  | "DATE" | "STRFTIME" | "NOW"
  | "NULLIF" | "IFNULL" | "REPLACE" | "CEIL" | "FLOOR" | "MOD"
  | "JSON_EXTRACT";
export type CastType = "text" | "integer" | "real" | "boolean";

export interface Aggregate {
  kind: "aggregate";
  func: AggFunc;
  /** null = COUNT(*) */
  arg: Expr | null;
  distinct: boolean;
  /** GROUP_CONCAT only: the separator (defaults to ",") */
  sep?: Expr;
}

export type Expr =
  | ColumnRef
  | Literal
  | Param
  | Aggregate
  | { kind: "binary"; op: CompareOp | ArithOp | "AND" | "OR" | "||" | "->>"; left: Expr; right: Expr }
  | { kind: "not"; expr: Expr }
  | { kind: "in"; expr: Expr; list: Expr[]; negated: boolean }
  | { kind: "between"; expr: Expr; lo: Expr; hi: Expr; negated: boolean }
  | { kind: "like"; expr: Expr; pattern: Expr; negated: boolean }
  | { kind: "isnull"; expr: Expr; negated: boolean }
  | { kind: "func"; name: ScalarFunc; args: Expr[] }
  | { kind: "case"; branches: { when: Expr; then: Expr }[]; else?: Expr }
  | { kind: "cast"; expr: Expr; to: CastType }
  // Uncorrelated subqueries (Design §7): evaluated inner-query-first by the
  // executor and rewritten into plain literals before the outer plan runs.
  // Their inner scope is their own — the expression walkers below never
  // descend into `query`.
  | { kind: "subquery"; query: SelectStmt }
  | { kind: "insub"; expr: Expr; query: SelectStmt; negated: boolean };

export interface SelectItem {
  expr: Expr;
  alias?: string;
}

export interface TableRef {
  table: string;
  alias?: string;
}

/** One JOIN clause. ON is a single equality between a column of the joined
 * table and a column of any table already in scope (left-deep hash joins). */
export interface JoinClause {
  type: "inner" | "left";
  table: TableRef;
  leftCol: ColumnRef;
  rightCol: ColumnRef;
}

export interface SelectStmt {
  kind: "select";
  /** null = SELECT * */
  items: SelectItem[] | null;
  distinct: boolean;
  from: TableRef;
  /** In statement order; self-joins are legal (each occurrence needs its own alias). */
  joins?: JoinClause[];
  where?: Expr;
  /** Full expressions: GROUP BY DATE(createdAt) and GROUP BY <select alias> are both legal. */
  groupBy?: Expr[];
  having?: Expr;
  orderBy?: { column: ColumnRef; desc: boolean }[];
  limit?: Expr;
  offset?: Expr;
}

export interface OnConflict {
  /** The conflict target: the primary key, a UNIQUE column, or (multi-column)
   * a declared composite unique constraint. Absent = the primary key. */
  columns?: string[];
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

/** ADD COLUMN of a plain nullable column — the only supported ALTER TABLE
 * form (Design §7). Existing chunks are untouched: absent keys read as NULL. */
export interface AlterTableStmt {
  kind: "alter";
  table: string;
  column: { name: string; type: string };
}

export type Statement = SelectStmt | InsertStmt | UpdateStmt | DeleteStmt | CreateTableStmt | DropTableStmt | AlterTableStmt;

/** True if the expression contains an aggregate anywhere (aggregates cannot nest). */
export function hasAggregate(e: Expr): boolean {
  switch (e.kind) {
    case "aggregate":
      return true;
    case "binary":
      return hasAggregate(e.left) || hasAggregate(e.right);
    case "not":
    case "isnull":
      return hasAggregate(e.expr);
    case "cast":
      return hasAggregate(e.expr);
    case "in":
      return hasAggregate(e.expr) || e.list.some(hasAggregate);
    case "between":
      return hasAggregate(e.expr) || hasAggregate(e.lo) || hasAggregate(e.hi);
    case "like":
      return hasAggregate(e.expr) || hasAggregate(e.pattern);
    case "func":
      return e.args.some(hasAggregate);
    case "case":
      return (
        e.branches.some((b) => hasAggregate(b.when) || hasAggregate(b.then)) ||
        (e.else !== undefined && hasAggregate(e.else))
      );
    case "insub":
      return hasAggregate(e.expr); // the inner query's aggregates are its own
    default:
      return false;
  }
}

/** True if the expression contains a subquery node anywhere (does not descend
 * into inner queries — a nested subquery resolves when its parent executes). */
export function hasSubquery(e: Expr): boolean {
  switch (e.kind) {
    case "subquery":
    case "insub":
      return true;
    case "binary":
      return hasSubquery(e.left) || hasSubquery(e.right);
    case "not":
    case "isnull":
    case "cast":
      return hasSubquery(e.expr);
    case "in":
      return hasSubquery(e.expr) || e.list.some(hasSubquery);
    case "between":
      return hasSubquery(e.expr) || hasSubquery(e.lo) || hasSubquery(e.hi);
    case "like":
      return hasSubquery(e.expr) || hasSubquery(e.pattern);
    case "func":
      return e.args.some(hasSubquery);
    case "aggregate":
      return (e.arg !== null && hasSubquery(e.arg)) || (e.sep !== undefined && hasSubquery(e.sep));
    case "case":
      return (
        e.branches.some((b) => hasSubquery(b.when) || hasSubquery(b.then)) ||
        (e.else !== undefined && hasSubquery(e.else))
      );
    default:
      return false;
  }
}

/**
 * Rewrite an expression, replacing each column reference for which `fn`
 * returns a substitute (return null to keep the reference). Aggregate
 * arguments are rewritten too. Used for HAVING / GROUP BY alias resolution
 * and for substituting excluded.* in ON CONFLICT DO UPDATE.
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
      return { ...e, arg: e.arg === null ? null : m(e.arg), sep: e.sep === undefined ? undefined : m(e.sep) };
    case "binary":
      return { ...e, left: m(e.left), right: m(e.right) };
    case "not":
      return { ...e, expr: m(e.expr) };
    case "cast":
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
    case "subquery":
      return e; // inner scope is its own — excluded.*/alias resolution never reaches in
    case "insub":
      return { ...e, expr: m(e.expr) };
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
    case "isnull":
      ungroupedColumns(e.expr, out);
      break;
    case "cast":
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
    case "insub":
      ungroupedColumns(e.expr, out);
      break;
    // "subquery" resolves to a constant before grouping — no outer columns
  }
  return out;
}

/**
 * Is `e` fully determined by the GROUP BY expressions? True when every path
 * to a column either passes through an aggregate or is (part of) a structural
 * match of a grouping expression. Bare grouping columns match by name so that
 * `GROUP BY customerId` covers `orders.customerId`.
 */
export function coveredByGroupBy(e: Expr, groupBy: Expr[]): boolean {
  const keys = new Set(groupBy.map((g) => JSON.stringify(g)));
  const ok = (x: Expr): boolean => {
    if (keys.has(JSON.stringify(x))) return true;
    switch (x.kind) {
      case "literal":
      case "param":
      case "aggregate":
        return true;
      case "column":
        return groupBy.some((g) => g.kind === "column" && g.name === x.name);
      case "binary":
        return ok(x.left) && ok(x.right);
      case "not":
      case "isnull":
        return ok(x.expr);
      case "cast":
        return ok(x.expr);
      case "in":
        return ok(x.expr) && x.list.every(ok);
      case "between":
        return ok(x.expr) && ok(x.lo) && ok(x.hi);
      case "like":
        return ok(x.expr) && ok(x.pattern);
      case "func":
        return x.args.every(ok);
      case "case":
        return x.branches.every((b) => ok(b.when) && ok(b.then)) && (x.else === undefined || ok(x.else));
      case "subquery":
        return true; // a constant once evaluated
      case "insub":
        return ok(x.expr);
    }
  };
  return ok(e);
}
