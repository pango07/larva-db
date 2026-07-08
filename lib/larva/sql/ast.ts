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

export type Expr =
  | ColumnRef
  | Literal
  | Param
  | { kind: "binary"; op: CompareOp | ArithOp | "AND" | "OR"; left: Expr; right: Expr }
  | { kind: "not"; expr: Expr }
  | { kind: "in"; expr: Expr; list: Expr[]; negated: boolean }
  | { kind: "between"; expr: Expr; lo: Expr; hi: Expr; negated: boolean }
  | { kind: "like"; expr: Expr; pattern: Expr; negated: boolean }
  | { kind: "isnull"; expr: Expr; negated: boolean };

export type AggFunc = "COUNT" | "SUM" | "AVG" | "MIN" | "MAX";

export interface Aggregate {
  kind: "aggregate";
  func: AggFunc;
  /** null = COUNT(*) */
  arg: ColumnRef | null;
}

export interface SelectItem {
  expr: ColumnRef | Aggregate;
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
  from: TableRef;
  join?: { type: "inner" | "left"; table: TableRef; leftCol: ColumnRef; rightCol: ColumnRef };
  where?: Expr;
  groupBy?: ColumnRef[];
  orderBy?: { column: ColumnRef; desc: boolean }[];
  limit?: Expr;
  offset?: Expr;
}

export interface InsertStmt {
  kind: "insert";
  table: string;
  columns: string[];
  rows: Expr[][];
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
