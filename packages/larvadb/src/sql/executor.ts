import { ChunkRef, cmpScalar, LarvaProto, Manifest, Row, Scalar, Snapshot } from "../core";
import { DatabaseSchema, TableSchema, validateInsert } from "../schema";
import {
  Aggregate,
  CastType,
  ColumnRef,
  coveredByGroupBy,
  DeleteStmt,
  Expr,
  hasAggregate,
  InsertStmt,
  mapColumnRefs,
  SelectItem,
  SelectStmt,
  Statement,
  ungroupedColumns,
  UpdateStmt,
} from "./ast";
import { SqlError } from "./errors";

const CHUNK_TARGET_ROWS = 1000;

export interface ExecOptions {
  allowFullTable?: boolean;
  maxAttempts?: number;
}

export interface QueryStats {
  chunksTotal: number;
  chunksFetched: number;
}

/** alias/table name → current row, for expression evaluation across a join */
type Ctx = Record<string, Row>;

/** A staged write: chunks are already on Blob; apply re-points a manifest at
 * them (returning null when the touched data changed — re-execute). rows are
 * the RETURNING projection. */
export interface PlanOutcome {
  apply: (m: Manifest) => Manifest | null;
  rows: Row[];
}

export class Executor {
  /** Pruning stats of the most recent table fetch — used by tests and curious users. */
  lastStats: QueryStats = { chunksTotal: 0, chunksFetched: 0 };

  constructor(private proto: LarvaProto) {}

  private schemaOf(manifest: Manifest, table: string): TableSchema {
    const schema = (manifest.schema ?? {}) as DatabaseSchema;
    const ts = schema[table];
    if (!ts || !manifest.tables[table]) {
      throw new SqlError(
        "UNKNOWN_TABLE",
        `table "${table}" does not exist (tables: ${Object.keys(manifest.tables).join(", ") || "none"})`,
      );
    }
    return ts;
  }

  async execute(stmt: Statement, params: Scalar[], opts: ExecOptions, snap?: Snapshot): Promise<Row[]> {
    if (stmt.kind === "select") return this.select(stmt, params, snap ?? (await this.proto.snapshot()));
    // Single-statement write: plan against each (re)fetched snapshot, one CAS.
    let rows: Row[] = [];
    await this.proto.commit(async (s) => {
      const plan = await this.plan(stmt, params, opts, s);
      rows = plan.rows;
      return { apply: plan.apply };
    }, opts);
    return rows;
  }

  /** Execute one statement inside a transaction, against its virtual snapshot. */
  async executeInTx(
    stmt: Statement,
    params: Scalar[],
    opts: ExecOptions,
    snap: Snapshot,
    record: (apply: PlanOutcome["apply"]) => void,
  ): Promise<Row[]> {
    if (stmt.kind === "select") return this.select(stmt, params, snap);
    const plan = await this.plan(stmt, params, opts, snap);
    record(plan.apply);
    return plan.rows;
  }

  private plan(stmt: Statement, params: Scalar[], opts: ExecOptions, snap: Snapshot): Promise<PlanOutcome> {
    switch (stmt.kind) {
      case "select":
        throw new SqlError("PARSE_ERROR", "SELECT has no write plan"); // unreachable
      case "insert":
        return this.planInsert(stmt, params, snap);
      case "update":
        return this.planUpdate(stmt, params, opts, snap);
      case "delete":
        return this.planDelete(stmt, params, opts, snap);
      case "create":
        return this.planCreate(stmt, snap);
      case "drop":
        return this.planDrop(stmt.table, snap);
    }
  }

  // ---------- reads ----------

  private async select(stmt: SelectStmt, params: Scalar[], snap: Snapshot): Promise<Row[]> {
    const fromName = stmt.from.alias ?? stmt.from.table;
    const fromSchema = this.schemaOf(snap.manifest, stmt.from.table);
    const leftChunks = await this.fetchTable(snap, stmt.from.table, fromSchema, stmt.where, fromName, params);
    const leftRows = leftChunks.flatMap((c) => c.rows);
    const realCols = new Set(Object.keys(fromSchema.columns));

    let contexts: Ctx[];
    if (stmt.join) {
      const joinName = stmt.join.table.alias ?? stmt.join.table.table;
      const joinSchema = this.schemaOf(snap.manifest, stmt.join.table.table);
      Object.keys(joinSchema.columns).forEach((c) => realCols.add(c));
      const rightRows = (
        await this.fetchTable(snap, stmt.join.table.table, joinSchema, undefined, joinName, params)
      ).flatMap((c) => c.rows);

      // Resolve which side of ON belongs to which table.
      const sideOf = (col: ColumnRef): "from" | "join" => {
        if (col.table === fromName) return "from";
        if (col.table === joinName) return "join";
        if (!col.table) {
          const inFrom = col.name in fromSchema.columns;
          const inJoin = col.name in joinSchema.columns;
          if (inFrom && inJoin) throw new SqlError("AMBIGUOUS_COLUMN", `"${col.name}" exists in both joined tables; qualify it`);
          if (inFrom) return "from";
          if (inJoin) return "join";
        }
        throw new SqlError("UNKNOWN_COLUMN", `JOIN condition references unknown column "${col.table ?? ""}${col.table ? "." : ""}${col.name}"`);
      };
      const [fromKey, joinKey] =
        sideOf(stmt.join.leftCol) === "from"
          ? [stmt.join.leftCol.name, stmt.join.rightCol.name]
          : [stmt.join.rightCol.name, stmt.join.leftCol.name];

      const index = new Map<Scalar, Row[]>();
      for (const r of rightRows) {
        const k = r[joinKey];
        index.set(k, [...(index.get(k) ?? []), r]);
      }
      const nullRight: Row = Object.fromEntries(Object.keys(joinSchema.columns).map((c) => [c, null]));
      contexts = leftRows.flatMap((l) => {
        const matches = l[fromKey] === null ? [] : (index.get(l[fromKey]) ?? []);
        if (matches.length > 0) return matches.map((r) => ({ [fromName]: l, [joinName]: r }));
        return stmt.join?.type === "left" ? [{ [fromName]: l, [joinName]: nullRight }] : [];
      });
    } else {
      contexts = leftRows.map((r) => ({ [fromName]: r }));
    }

    if (stmt.where) {
      contexts = contexts.filter((ctx) => this.truthy(this.evalExpr(stmt.where as Expr, ctx, params)));
    }

    let output: Row[];
    const hasAggregates = stmt.items?.some((i) => hasAggregate(i.expr)) ?? false;
    if (stmt.groupBy || stmt.having || hasAggregates) {
      output = this.grouped(stmt, contexts, params, realCols);
      if (stmt.orderBy) {
        for (const { column } of stmt.orderBy) {
          if (output.length > 0 && !(column.name in output[0])) {
            throw new SqlError(
              "PARSE_ERROR",
              `ORDER BY on a grouped query must reference an output column or alias ("${column.name}" is not one of: ${Object.keys(output[0]).join(", ")})`,
            );
          }
        }
        output.sort((a, b) => this.orderCmp(a, b, stmt.orderBy as { column: ColumnRef; desc: boolean }[]));
      }
    } else {
      if (stmt.orderBy) {
        // An unqualified ORDER BY name that matches a select-item alias sorts
        // by that item's expression; anything else sorts by the source column.
        const aliased = new Map<string, Expr>();
        for (const item of stmt.items ?? []) if (item.alias) aliased.set(item.alias, item.expr);
        const sortKey = (column: ColumnRef, ctx: Ctx): Scalar => {
          const viaAlias = !column.table ? aliased.get(column.name) : undefined;
          return viaAlias ? this.evalExpr(viaAlias, ctx, params) : this.resolveColumn(column, ctx);
        };
        contexts.sort((a, b) => {
          for (const { column, desc } of stmt.orderBy as { column: ColumnRef; desc: boolean }[]) {
            const c = cmpScalar(sortKey(column, a), sortKey(column, b));
            if (c !== 0) return desc ? -c : c;
          }
          return 0;
        });
      }
      output = contexts.map((ctx) => this.project(stmt.items, ctx, params));
    }

    if (stmt.distinct) {
      const seen = new Set<string>();
      output = output.filter((row) => {
        const key = JSON.stringify(Object.values(row));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    const limit = stmt.limit !== undefined ? this.intOf(stmt.limit, params, "LIMIT") : undefined;
    const offset = stmt.offset !== undefined ? this.intOf(stmt.offset, params, "OFFSET") : 0;
    return output.slice(offset, limit !== undefined ? offset + limit : undefined);
  }

  private grouped(stmt: SelectStmt, contexts: Ctx[], params: Scalar[], realCols: Set<string>): Row[] {
    const items = stmt.items;
    if (!items) throw new SqlError("PARSE_ERROR", "SELECT * cannot be combined with GROUP BY, HAVING, or aggregates; list columns explicitly");

    // A bare name in GROUP BY or HAVING that matches a select-item alias (and
    // is not a real column — columns win) refers to that item's expression,
    // so GROUP BY month and HAVING revenue > 100 both work.
    const aliased = new Map<string, Expr>();
    for (const item of items) if (item.alias) aliased.set(item.alias, item.expr);
    const dealias = (e: Expr): Expr =>
      mapColumnRefs(e, (c) => (!c.table && !realCols.has(c.name) && aliased.has(c.name) ? (aliased.get(c.name) as Expr) : null));

    const groupBy = (stmt.groupBy ?? []).map(dealias);
    const requireGrouped = (expr: Expr, where: string) => {
      if (coveredByGroupBy(expr, groupBy)) return;
      const names = new Set(groupBy.filter((g) => g.kind === "column").map((g) => (g as ColumnRef).name));
      const offender = ungroupedColumns(expr).find((c) => !names.has(c.name));
      throw new SqlError(
        "NOT_GROUPED",
        `column "${offender?.name ?? "?"}" in ${where} must appear in GROUP BY or inside an aggregate`,
      );
    };
    for (const item of items) requireGrouped(item.expr, "the SELECT list");

    let having = stmt.having;
    if (having) {
      having = dealias(having);
      requireGrouped(having, "HAVING");
    }

    const groups = new Map<string, Ctx[]>();
    for (const ctx of contexts) {
      const key = JSON.stringify(groupBy.map((g) => this.evalExpr(g, ctx, params)));
      groups.set(key, [...(groups.get(key) ?? []), ctx]);
    }
    if (groups.size === 0 && groupBy.length === 0) groups.set("[]", []); // aggregate over empty table

    let rowsets = [...groups.values()];
    if (having) {
      const h = having;
      rowsets = rowsets.filter((rows) => this.truthy(this.evalExpr(h, rows[0] ?? {}, params, rows)));
    }
    return rowsets.map((rows) => {
      const out: Row = {};
      items.forEach((item, i) => {
        out[this.outputName(item, i)] = this.evalExpr(item.expr, rows[0] ?? {}, params, rows);
      });
      return out;
    });
  }

  private aggregate(agg: Aggregate, rows: Ctx[], params: Scalar[]): Scalar {
    if (agg.func === "COUNT" && agg.arg === null) return rows.length;
    if (agg.arg === null) throw new SqlError("PARSE_ERROR", `${agg.func}(*) is not valid; ${agg.func} needs a column or expression`);
    const arg = agg.arg;
    let values = rows.map((ctx) => this.evalExpr(arg, ctx, params)).filter((v) => v !== null);
    if (agg.distinct) values = [...new Set(values)];
    switch (agg.func) {
      case "COUNT":
        return values.length;
      case "MIN":
        return values.length ? values.reduce((a, b) => (cmpScalar(a, b) <= 0 ? a : b)) : null;
      case "MAX":
        return values.length ? values.reduce((a, b) => (cmpScalar(a, b) >= 0 ? a : b)) : null;
      case "SUM":
      case "AVG": {
        if (values.some((v) => typeof v !== "number")) {
          throw new SqlError("TYPE_MISMATCH", `${agg.func}(…) requires a numeric argument`);
        }
        if (values.length === 0) return null;
        const sum = (values as number[]).reduce((a, b) => a + b, 0);
        return agg.func === "SUM" ? sum : sum / values.length;
      }
      case "GROUP_CONCAT": {
        if (values.length === 0) return null;
        const sep = agg.sep ? this.evalExpr(agg.sep, rows[0] ?? {}, params) : ",";
        if (typeof sep !== "string") throw new SqlError("TYPE_MISMATCH", "the GROUP_CONCAT separator must be text");
        return values.map((v) => (typeof v === "boolean" ? (v ? "true" : "false") : String(v))).join(sep);
      }
    }
  }

  /** Output column name: alias, else the column/function name, else a positional fallback. */
  private outputName(item: SelectItem, index: number): string {
    if (item.alias) return item.alias;
    const e = item.expr;
    if (e.kind === "column") return e.name;
    if (e.kind === "aggregate") return e.func.toLowerCase();
    if (e.kind === "func") return e.name.toLowerCase();
    return `column${index + 1}`;
  }

  private project(items: SelectItem[] | null, ctx: Ctx, params: Scalar[]): Row {
    if (items === null) {
      // SELECT *: merge tables; colliding join columns get qualified keys.
      const tables = Object.keys(ctx);
      const out: Row = { ...ctx[tables[0]] };
      for (const t of tables.slice(1)) {
        for (const [k, v] of Object.entries(ctx[t])) out[k in out ? `${t}.${k}` : k] = v;
      }
      return out;
    }
    const out: Row = {};
    items.forEach((item, i) => {
      out[this.outputName(item, i)] = this.evalExpr(item.expr, ctx, params);
    });
    return out;
  }

  private orderCmp(a: Row, b: Row, orderBy: { column: ColumnRef; desc: boolean }[]): number {
    for (const { column, desc } of orderBy) {
      const c = cmpScalar(a[column.name] ?? null, b[column.name] ?? null);
      if (c !== 0) return desc ? -c : c;
    }
    return 0;
  }

  private intOf(expr: Expr, params: Scalar[], what: string): number {
    const v = expr.kind === "param" ? params[expr.index] : expr.kind === "literal" ? expr.value : null;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new SqlError("TYPE_MISMATCH", `${what} must be a non-negative integer, got ${JSON.stringify(v)}`);
    }
    return v;
  }

  // ---------- chunk fetch with zone-map pruning ----------

  private async fetchTable(
    snap: Snapshot,
    table: string,
    schema: TableSchema,
    where: Expr | undefined,
    ctxName: string,
    params: Scalar[],
  ): Promise<{ ref: ChunkRef; rows: Row[] }[]> {
    const refs = snap.manifest.tables[table]?.chunks ?? [];
    const bounds = where ? this.pruneBounds(where, schema, ctxName, params) : {};
    const survivors = refs.filter((ref) => {
      if (!ref.stats) return true;
      const pk = bounds[schema.primaryKey];
      if (pk && (cmpScalar(ref.stats.pkMax, pk.lo) < 0 || cmpScalar(ref.stats.pkMin, pk.hi) > 0)) return false;
      const part = schema.partitionColumn ? bounds[schema.partitionColumn] : undefined;
      if (
        part &&
        ref.stats.partMin !== undefined &&
        ref.stats.partMax !== undefined &&
        (cmpScalar(ref.stats.partMax, part.lo) < 0 || cmpScalar(ref.stats.partMin, part.hi) > 0)
      ) {
        return false;
      }
      return true;
    });
    this.lastStats = { chunksTotal: refs.length, chunksFetched: survivors.length };
    return Promise.all(survivors.map(async (ref) => ({ ref, rows: await this.proto.readChunk(ref) })));
  }

  /**
   * Extract [lo, hi] bounds per column from top-level AND-ed predicates on the
   * from-table. Anything else simply doesn't prune — never affects correctness.
   */
  private pruneBounds(
    where: Expr,
    schema: TableSchema,
    ctxName: string,
    params: Scalar[],
  ): Record<string, { lo: Scalar; hi: Scalar }> {
    const bounds: Record<string, { lo: Scalar; hi: Scalar }> = {};
    const scalarOf = (e: Expr): Scalar | undefined =>
      e.kind === "literal" ? e.value : e.kind === "param" ? params[e.index] : undefined;
    const colOf = (e: Expr): string | undefined =>
      e.kind === "column" && (!e.table || e.table === ctxName) ? e.name : undefined;
    const narrow = (col: string, lo: Scalar, hi: Scalar) => {
      const cur = bounds[col];
      bounds[col] = cur
        ? { lo: cmpScalar(lo, cur.lo) > 0 ? lo : cur.lo, hi: cmpScalar(hi, cur.hi) < 0 ? hi : cur.hi }
        : { lo, hi };
    };
    const MIN: Scalar = null; // null sorts first in cmpScalar → acts as -infinity
    const MAX = "￿￿￿￿"; // above any ISO timestamp / ULID / practical text

    const walk = (e: Expr): void => {
      if (e.kind === "binary" && e.op === "AND") {
        walk(e.left);
        walk(e.right);
        return;
      }
      if (e.kind === "binary" && ["=", "<", "<=", ">", ">="].includes(e.op)) {
        const [col, val, op] =
          colOf(e.left) !== undefined
            ? [colOf(e.left), scalarOf(e.right), e.op]
            : [colOf(e.right), scalarOf(e.left), flip(e.op)];
        if (col === undefined || val === undefined || val === null) return;
        if (!(col in schema.columns)) return;
        if (typeof val === "number" || typeof val === "string") {
          if (op === "=") narrow(col, val, val);
          else if (op === "<" || op === "<=") narrow(col, MIN, val);
          else narrow(col, val, MAX);
        }
        return;
      }
      if (e.kind === "between" && !e.negated) {
        const col = colOf(e.expr);
        const lo = scalarOf(e.lo);
        const hi = scalarOf(e.hi);
        if (col && col in schema.columns && lo !== undefined && hi !== undefined) narrow(col, lo, hi);
        return;
      }
      if (e.kind === "in" && !e.negated) {
        const col = colOf(e.expr);
        const vals = e.list.map(scalarOf);
        if (col && col in schema.columns && vals.every((v) => v !== undefined && v !== null)) {
          const sorted = [...(vals as Scalar[])].sort(cmpScalar);
          narrow(col, sorted[0], sorted[sorted.length - 1]);
        }
      }
    };
    const flip = (op: string): CompareLike => (op === "<" ? ">" : op === "<=" ? ">=" : op === ">" ? "<" : op === ">=" ? "<=" : "=") as CompareLike;
    type CompareLike = "=" | "<" | "<=" | ">" | ">=";
    walk(where);
    return bounds;
  }

  // ---------- expression evaluation ----------

  private resolveColumn(col: ColumnRef, ctx: Ctx): Scalar {
    if (col.table) {
      const row = ctx[col.table];
      if (!row) throw new SqlError("UNKNOWN_TABLE", `"${col.table}" is not a table or alias in this query (available: ${Object.keys(ctx).join(", ")})`);
      if (!(col.name in row)) throw new SqlError("UNKNOWN_COLUMN", `column "${col.name}" does not exist in "${col.table}"`);
      return row[col.name];
    }
    const owners = Object.keys(ctx).filter((t) => col.name in ctx[t]);
    if (owners.length === 0) {
      throw new SqlError("UNKNOWN_COLUMN", `column "${col.name}" does not exist (tables in scope: ${Object.keys(ctx).join(", ")})`);
    }
    if (owners.length > 1) {
      throw new SqlError("AMBIGUOUS_COLUMN", `column "${col.name}" exists in ${owners.join(" and ")}; qualify it`);
    }
    return ctx[owners[0]][col.name];
  }

  private truthy(v: Scalar): boolean {
    return v === true || (typeof v === "number" && v !== 0);
  }

  /** `group` carries the rows of the current group so aggregate nodes can evaluate; absent outside GROUP BY/HAVING contexts. */
  private evalExpr(e: Expr, ctx: Ctx, params: Scalar[], group?: Ctx[]): Scalar {
    switch (e.kind) {
      case "aggregate": {
        if (!group) {
          throw new SqlError(
            "AGGREGATE_MISPLACED",
            `${e.func} is an aggregate and only works in a SELECT list or HAVING clause; it cannot be used here`,
          );
        }
        return this.aggregate(e, group, params);
      }
      case "func":
        return this.scalarFunc(e.name, e.args.map((a) => this.evalExpr(a, ctx, params, group)));
      case "case": {
        for (const b of e.branches) {
          if (this.truthy(this.evalExpr(b.when, ctx, params, group))) return this.evalExpr(b.then, ctx, params, group);
        }
        return e.else !== undefined ? this.evalExpr(e.else, ctx, params, group) : null;
      }
      case "cast":
        return this.castValue(this.evalExpr(e.expr, ctx, params, group), e.to);
      case "literal":
        return e.value;
      case "param": {
        if (e.index >= params.length) {
          throw new SqlError("MISSING_PARAM", `query uses ${e.index + 1}+ parameters but only ${params.length} were provided`);
        }
        return params[e.index];
      }
      case "column":
        return this.resolveColumn(e, ctx);
      case "not":
        return !this.truthy(this.evalExpr(e.expr, ctx, params, group));
      case "isnull": {
        const v = this.evalExpr(e.expr, ctx, params, group);
        return e.negated ? v !== null : v === null;
      }
      case "in": {
        const v = this.evalExpr(e.expr, ctx, params, group);
        const hit = v !== null && e.list.some((item) => this.evalExpr(item, ctx, params, group) === v);
        return e.negated ? !hit : hit;
      }
      case "between": {
        const v = this.evalExpr(e.expr, ctx, params, group);
        if (v === null) return false;
        const hit =
          cmpScalar(v, this.evalExpr(e.lo, ctx, params, group)) >= 0 &&
          cmpScalar(v, this.evalExpr(e.hi, ctx, params, group)) <= 0;
        return e.negated ? !hit : hit;
      }
      case "like": {
        const v = this.evalExpr(e.expr, ctx, params, group);
        const pattern = this.evalExpr(e.pattern, ctx, params, group);
        if (typeof v !== "string" || typeof pattern !== "string") return e.negated;
        const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, "s");
        return e.negated ? !re.test(v) : re.test(v);
      }
      case "binary": {
        if (e.op === "AND") return this.truthy(this.evalExpr(e.left, ctx, params, group)) && this.truthy(this.evalExpr(e.right, ctx, params, group));
        if (e.op === "OR") return this.truthy(this.evalExpr(e.left, ctx, params, group)) || this.truthy(this.evalExpr(e.right, ctx, params, group));
        const l = this.evalExpr(e.left, ctx, params, group);
        const r = this.evalExpr(e.right, ctx, params, group);
        if (e.op === "||") {
          if (l === null || r === null) return null; // SQL: NULL propagates through concat
          if (typeof l === "boolean" || typeof r === "boolean") {
            throw new SqlError("TYPE_MISMATCH", `|| concatenates text and numbers, got ${JSON.stringify(l)} || ${JSON.stringify(r)}`);
          }
          return String(l) + String(r);
        }
        if (e.op === "->>") {
          if (l === null || r === null) return null;
          const doc = this.parseJsonDoc(l, "the left side of ->>");
          if (typeof r === "string") {
            return this.jsonScalar(doc !== null && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>)[r] : undefined);
          }
          if (typeof r === "number" && Number.isInteger(r)) {
            return this.jsonScalar(Array.isArray(doc) ? doc[r] : undefined);
          }
          throw new SqlError("TYPE_MISMATCH", `->> expects a text key or integer index on the right, got ${JSON.stringify(r)}`);
        }
        if (["+", "-", "*", "/"].includes(e.op)) {
          if (l === null || r === null) return null;
          if (typeof l !== "number" || typeof r !== "number") {
            throw new SqlError("TYPE_MISMATCH", `arithmetic needs numbers, got ${JSON.stringify(l)} ${e.op} ${JSON.stringify(r)}`);
          }
          return e.op === "+" ? l + r : e.op === "-" ? l - r : e.op === "*" ? l * r : l / r;
        }
        if (l === null || r === null) return false; // SQL null semantics, two-valued
        switch (e.op) {
          case "=":
            return l === r;
          case "!=":
            return l !== r;
          case "<":
            return cmpScalar(l, r) < 0;
          case "<=":
            return cmpScalar(l, r) <= 0;
          case ">":
            return cmpScalar(l, r) > 0;
          case ">=":
            return cmpScalar(l, r) >= 0;
          default:
            throw new SqlError("PARSE_ERROR", `unexpected operator "${e.op}"`);
        }
      }
    }
  }

  /** SQLite-compatible scalar functions; NULL in → NULL out (except COALESCE, whose job is NULLs). */
  private scalarFunc(name: string, args: Scalar[]): Scalar {
    const str = (v: Scalar, i = 0): string => {
      if (typeof v !== "string") throw new SqlError("TYPE_MISMATCH", `${name} expects text for argument ${i + 1}, got ${JSON.stringify(v)}`);
      return v;
    };
    const num = (v: Scalar, i = 0): number => {
      if (typeof v !== "number") throw new SqlError("TYPE_MISMATCH", `${name} expects a number for argument ${i + 1}, got ${JSON.stringify(v)}`);
      return v;
    };
    // These four make sense with NULL (or no) arguments; everything below NULL-propagates.
    if (name === "COALESCE") return args.find((v) => v !== null) ?? null;
    if (name === "IFNULL") return args[0] !== null ? args[0] : args[1];
    if (name === "NULLIF") return args[0] === args[1] ? null : args[0];
    if (name === "NOW") return new Date().toISOString();
    if (args[0] === null) return null;
    switch (name) {
      case "UPPER":
        return str(args[0]).toUpperCase();
      case "LOWER":
        return str(args[0]).toLowerCase();
      case "TRIM":
        return str(args[0]).trim();
      case "LENGTH":
        return str(args[0]).length;
      case "ABS":
        return Math.abs(num(args[0]));
      case "ROUND": {
        const digits = args.length > 1 && args[1] !== null ? num(args[1], 1) : 0;
        const f = 10 ** digits;
        return Math.round(num(args[0]) * f) / f;
      }
      case "SUBSTR": {
        const s = str(args[0]);
        if (args[1] === null || (args.length > 2 && args[2] === null)) return null;
        const start = num(args[1], 1); // 1-based; negative counts from the end (SQLite semantics)
        const begin = start > 0 ? start - 1 : Math.max(0, s.length + start);
        const len = args.length > 2 ? Math.max(0, num(args[2], 2)) : undefined;
        return s.slice(begin, len === undefined ? undefined : begin + len);
      }
      case "DATE":
        // Timestamps are ISO 8601 text, so the calendar date is a prefix.
        return str(args[0]).slice(0, 10);
      case "STRFTIME": {
        const fmt = str(args[0]);
        if (args[1] === null) return null;
        const ts = str(args[1], 1);
        return fmt.replace(/%(.)/g, (_, spec: string) => {
          switch (spec) {
            case "Y": return ts.slice(0, 4);
            case "m": return ts.slice(5, 7);
            case "d": return ts.slice(8, 10);
            case "H": return ts.slice(11, 13);
            case "M": return ts.slice(14, 16);
            case "S": return ts.slice(17, 19);
            case "%": return "%";
            default:
              throw new SqlError("UNSUPPORTED_FEATURE", `STRFTIME specifier %${spec} is not supported; available: %Y %m %d %H %M %S`);
          }
        });
      }
      case "REPLACE": {
        if (args[1] === null || args[2] === null) return null;
        return str(args[0]).split(str(args[1], 1)).join(str(args[2], 2));
      }
      case "CEIL":
        return Math.ceil(num(args[0]));
      case "FLOOR":
        return Math.floor(num(args[0]));
      case "MOD": {
        if (args[1] === null) return null;
        const d = num(args[1], 1);
        return d === 0 ? null : num(args[0]) % d; // SQL: x MOD 0 is NULL, not an error
      }
      case "JSON_EXTRACT": {
        if (args[1] === null) return null;
        return this.jsonExtract(str(args[0]), str(args[1], 1));
      }
      default:
        throw new SqlError("UNKNOWN_FUNCTION", `function "${name}" is not available`); // unreachable — parser gates the set
    }
  }

  private castValue(v: Scalar, to: CastType): Scalar {
    if (v === null) return null;
    switch (to) {
      case "text":
        return typeof v === "boolean" ? (v ? "true" : "false") : String(v);
      case "integer":
      case "real": {
        const n = typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : Number(v);
        if (Number.isNaN(n)) throw new SqlError("TYPE_MISMATCH", `cannot CAST ${JSON.stringify(v)} to ${to}`);
        return to === "integer" ? Math.trunc(n) : n;
      }
      case "boolean": {
        if (typeof v === "boolean") return v;
        if (typeof v === "number") return v !== 0;
        if (v === "true") return true;
        if (v === "false") return false;
        throw new SqlError("TYPE_MISMATCH", `cannot CAST ${JSON.stringify(v)} to boolean`);
      }
    }
  }

  private parseJsonDoc(v: Scalar, where: string): unknown {
    if (typeof v !== "string") {
      throw new SqlError("TYPE_MISMATCH", `${where} must be JSON text (store JSON with a text column and JSON.stringify), got ${JSON.stringify(v)}`);
    }
    try {
      return JSON.parse(v);
    } catch {
      throw new SqlError("TYPE_MISMATCH", `${where} is not valid JSON`);
    }
  }

  /** Objects and arrays come back as JSON text (SQLite json1 semantics); missing paths are NULL. */
  private jsonScalar(v: unknown): Scalar {
    if (v === undefined || v === null) return null;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    return JSON.stringify(v);
  }

  private jsonExtract(json: string, path: string): Scalar {
    const doc = this.parseJsonDoc(json, "JSON_EXTRACT's first argument");
    if (!path.startsWith("$")) {
      throw new SqlError("INVALID_JSON_PATH", `JSON paths start with "$" (e.g. '$.user.name' or '$.tags[0]'), got ${JSON.stringify(path)}`);
    }
    let cur: unknown = doc;
    const seg = /\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/y;
    seg.lastIndex = 1;
    let at = 1;
    while (at < path.length) {
      const m = seg.exec(path);
      if (!m) {
        throw new SqlError("INVALID_JSON_PATH", `cannot parse JSON path ${JSON.stringify(path)} at position ${at}; use the '$.key.sub[0]' form`);
      }
      at = seg.lastIndex;
      if (cur === null || typeof cur !== "object") return null;
      cur = m[1] !== undefined ? (cur as Record<string, unknown>)[m[1]] : Array.isArray(cur) ? cur[Number(m[2])] : undefined;
    }
    return this.jsonScalar(cur);
  }

  // ---------- writes ----------

  private returningRows(rows: Row[], returning: SelectItem[] | null | undefined, table: string): Row[] {
    if (returning === undefined) return [];
    if (returning === null) return rows;
    return rows.map((r) => {
      const out: Row = {};
      for (const item of returning) {
        if (item.expr.kind !== "column") throw new SqlError("PARSE_ERROR", "RETURNING supports columns only");
        if (!(item.expr.name in r)) throw new SqlError("UNKNOWN_COLUMN", `RETURNING column "${item.expr.name}" does not exist in "${table}"`);
        out[item.alias ?? item.expr.name] = r[item.expr.name];
      }
      return out;
    });
  }

  private async planInsert(stmt: InsertStmt, params: Scalar[], snap: Snapshot): Promise<PlanOutcome> {
    const schema = this.schemaOf(snap.manifest, stmt.table);
    const incoming: Row[] = stmt.rows.map((values) => {
      const raw: Row = {};
      stmt.columns.forEach((col, i) => {
        raw[col] = this.evalExpr(values[i], {}, params);
      });
      return validateInsert(stmt.table, schema, raw);
    });

    const oc = stmt.onConflict;
    const target = oc ? (oc.column ?? schema.primaryKey) : null;
    if (oc && target) {
      if (!(target in schema.columns)) {
        throw new SqlError("UNKNOWN_COLUMN", `ON CONFLICT target "${target}" does not exist in table "${stmt.table}"`);
      }
      if (target !== schema.primaryKey && !schema.columns[target].unique) {
        throw new SqlError(
          "INVALID_CONFLICT_TARGET",
          `ON CONFLICT target "${target}" must be the primary key or a UNIQUE column — conflicts are only detectable where uniqueness is enforced`,
        );
      }
    }

    // Conflict detection against the snapshot (pruned lookup). Note:
    // snapshot-isolated — two concurrent inserts of the same pk are write
    // skew (Design §6) and not detected; ULID defaults make this moot.
    const uniqueCols = Object.entries(schema.columns).filter(([, c]) => c.unique).map(([n]) => n);
    const pks = incoming.map((r) => r[schema.primaryKey]);
    const candidates = (snap.manifest.tables[stmt.table]?.chunks ?? []).filter((ref) => {
      if (!ref.stats || uniqueCols.length > 0) return true; // unique columns force full scan
      return pks.some((pk) => cmpScalar(ref.stats!.pkMin, pk) <= 0 && cmpScalar(ref.stats!.pkMax, pk) >= 0);
    });
    const loaded = await Promise.all(
      candidates.map(async (ref) => ({ ref, rows: [...(await this.proto.readChunk(ref))] })),
    );

    // Rows are processed in statement order, each seeing the effect of the
    // previous ones (SQLite upsert semantics): a row can conflict with an
    // earlier row of the same INSERT.
    type Loc = { kind: "chunk"; chunk: number; idx: number } | { kind: "pending"; idx: number };
    const pkMap = new Map<Scalar, Loc>();
    const uniqMaps = new Map<string, Map<Scalar, Loc>>(uniqueCols.map((c) => [c, new Map()]));
    loaded.forEach((c, ci) =>
      c.rows.forEach((row, ri) => {
        pkMap.set(row[schema.primaryKey], { kind: "chunk", chunk: ci, idx: ri });
        for (const u of uniqueCols) {
          if (row[u] !== null) uniqMaps.get(u)!.set(row[u], { kind: "chunk", chunk: ci, idx: ri });
        }
      }),
    );

    const pending: Row[] = [];
    const dirty = new Set<number>();
    const resultRows: Row[] = [];
    const getRow = (loc: Loc): Row => (loc.kind === "pending" ? pending[loc.idx] : loaded[loc.chunk].rows[loc.idx]);
    const setRow = (loc: Loc, row: Row): void => {
      if (loc.kind === "pending") pending[loc.idx] = row;
      else {
        loaded[loc.chunk].rows[loc.idx] = row;
        dirty.add(loc.chunk);
      }
    };

    for (const row of incoming) {
      let conflictCol: string | null = null;
      let loc = pkMap.get(row[schema.primaryKey]);
      if (loc) conflictCol = schema.primaryKey;
      else {
        for (const u of uniqueCols) {
          const l = row[u] !== null ? uniqMaps.get(u)!.get(row[u]) : undefined;
          if (l) {
            conflictCol = u;
            loc = l;
            break;
          }
        }
      }

      if (!conflictCol || !loc) {
        const ploc: Loc = { kind: "pending", idx: pending.length };
        pending.push(row);
        pkMap.set(row[schema.primaryKey], ploc);
        for (const u of uniqueCols) if (row[u] !== null) uniqMaps.get(u)!.set(row[u], ploc);
        resultRows.push(row);
        continue;
      }

      if (!oc || conflictCol !== target) {
        const hint = oc ? `; the ON CONFLICT target is "${target}", which does not cover this conflict` : "";
        if (conflictCol === schema.primaryKey) {
          throw new SqlError(
            "PRIMARY_KEY_CONFLICT",
            loc.kind === "pending"
              ? `duplicate primary key within the inserted rows${hint}`
              : `primary key ${JSON.stringify(row[schema.primaryKey])} already exists in "${stmt.table}"${hint}`,
          );
        }
        throw new SqlError(
          "UNIQUE_CONFLICT",
          `value ${JSON.stringify(row[conflictCol])} already exists in unique column "${stmt.table}.${conflictCol}"${hint}`,
        );
      }

      if (oc.action === "nothing") continue;

      // DO UPDATE SET: bare columns read the existing row; excluded.col reads
      // the row that failed to insert.
      const existing = getRow(loc);
      const next = { ...existing };
      for (const { column, value } of oc.action.set) {
        if (!(column in schema.columns)) {
          throw new SqlError("UNKNOWN_COLUMN", `column "${column}" does not exist in table "${stmt.table}"`);
        }
        if (column === schema.primaryKey) {
          throw new SqlError("UNSUPPORTED_FEATURE", "updating the primary key in ON CONFLICT DO UPDATE is not supported; DELETE and re-INSERT instead");
        }
        const substituted = mapColumnRefs(value, (c) => {
          if (c.table !== "excluded") return null;
          if (!(c.name in schema.columns)) {
            throw new SqlError("UNKNOWN_COLUMN", `excluded.${c.name} does not exist in table "${stmt.table}"`);
          }
          return { kind: "literal", value: row[c.name] ?? null };
        });
        next[column] = this.evalExpr(substituted, { [stmt.table]: existing }, params);
      }
      const invalid = Object.entries(schema.columns).find(([n, def]) => {
        const v = next[n] ?? null;
        return v !== null && !validTypeQuick(def.type, v);
      });
      if (invalid) {
        throw new SqlError("TYPE_MISMATCH", `column "${stmt.table}.${invalid[0]}" is ${invalid[1].type}, got ${JSON.stringify(next[invalid[0]])}`);
      }
      for (const u of uniqueCols) {
        if (existing[u] === next[u]) continue;
        if (existing[u] !== null) uniqMaps.get(u)!.delete(existing[u]);
        if (next[u] !== null) {
          if (uniqMaps.get(u)!.has(next[u])) {
            throw new SqlError("UNIQUE_CONFLICT", `ON CONFLICT DO UPDATE would duplicate value ${JSON.stringify(next[u])} in unique column "${stmt.table}.${u}"`);
          }
          uniqMaps.get(u)!.set(next[u], loc);
        }
      }
      setRow(loc, next);
      resultRows.push(next);
    }

    const statsCols = { pk: schema.primaryKey, part: schema.partitionColumn };
    const replacements: { retired: ChunkRef; replacement: ChunkRef }[] = [];
    for (const ci of dirty) {
      replacements.push({
        retired: loaded[ci].ref,
        replacement: await this.proto.stageChunk(stmt.table, loaded[ci].rows, statsCols),
      });
    }
    const appended: ChunkRef[] = [];
    for (let i = 0; i < pending.length; i += CHUNK_TARGET_ROWS) {
      appended.push(await this.proto.stageChunk(stmt.table, pending.slice(i, i + CHUNK_TARGET_ROWS), statsCols));
    }

    return {
      apply: (m) => {
        const t = m.tables[stmt.table];
        if (!t) return null;
        for (const { retired, replacement } of replacements) {
          const idx = t.chunks.findIndex((c) => c.id === retired.id);
          if (idx < 0) return null; // a touched chunk changed underneath us — re-execute
          t.chunks[idx] = replacement;
        }
        t.chunks.push(...appended);
        return m;
      },
      rows: this.returningRows(resultRows, stmt.returning, stmt.table),
    };
  }

  private async planUpdate(stmt: UpdateStmt, params: Scalar[], opts: ExecOptions, snap: Snapshot): Promise<PlanOutcome> {
    return this.planRewrite(snap, stmt.table, stmt.where, opts, stmt.returning, (row, schema) => {
      const next = { ...row };
      for (const { column, value } of stmt.set) {
        if (!(column in schema.columns)) {
          throw new SqlError("UNKNOWN_COLUMN", `column "${column}" does not exist in table "${stmt.table}"`);
        }
        if (column === schema.primaryKey) {
          throw new SqlError("UNSUPPORTED_FEATURE", "updating the primary key is not supported in Larva v1; DELETE and re-INSERT instead");
        }
        // Evaluated against the pre-update row, so SET count = count - 1 works.
        next[column] = this.evalExpr(value, { [stmt.table]: row }, params);
      }
      return next;
    }, params, "UPDATE");
  }

  private async planDelete(stmt: DeleteStmt, params: Scalar[], opts: ExecOptions, snap: Snapshot): Promise<PlanOutcome> {
    return this.planRewrite(snap, stmt.table, stmt.where, opts, stmt.returning, () => null, params, "DELETE");
  }

  /** Shared UPDATE/DELETE path: rewrite every chunk containing affected rows. */
  private async planRewrite(
    snap: Snapshot,
    table: string,
    where: Expr | undefined,
    opts: ExecOptions,
    returning: DeleteStmt["returning"],
    transform: (row: Row, schema: TableSchema) => Row | null,
    params: Scalar[],
    verb: string,
  ): Promise<PlanOutcome> {
    if (!where && !opts.allowFullTable) {
      throw new SqlError(
        "MISSING_WHERE",
        `${verb} without a WHERE clause affects every row in "${table}"; pass { allowFullTable: true } if that is intended`,
      );
    }
    {
      const schema = this.schemaOf(snap.manifest, table);
      const chunks = await this.fetchTable(snap, table, schema, where, table, params);
      const affected: Row[] = [];
      const replacements: { retired: ChunkRef; replacement: ChunkRef | null }[] = [];
      const statsCols = { pk: schema.primaryKey, part: schema.partitionColumn };

      for (const { ref, rows } of chunks) {
        const out: Row[] = [];
        let touched = false;
        for (const row of rows) {
          const hit = !where || this.truthy(this.evalExpr(where, { [table]: row }, params));
          if (!hit) {
            out.push(row);
            continue;
          }
          touched = true;
          const next = transform(row, schema);
          affected.push(next ?? row);
          if (next !== null) {
            const invalid = Object.entries(schema.columns).find(([n, def]) => {
              const v = next[n] ?? null;
              return v !== null && !validTypeQuick(def.type, v);
            });
            if (invalid) throw new SqlError("TYPE_MISMATCH", `column "${table}.${invalid[0]}" is ${invalid[1].type}, got ${JSON.stringify(next[invalid[0]])}`);
            out.push(next);
          }
        }
        if (touched) {
          replacements.push({
            retired: ref,
            replacement: out.length > 0 ? await this.proto.stageChunk(table, out, statsCols) : null,
          });
        }
      }

      return {
        apply: (m) => {
          const t = m.tables[table];
          if (!t) return null;
          for (const { retired, replacement } of replacements) {
            const idx = t.chunks.findIndex((c) => c.id === retired.id);
            if (idx < 0) return null; // a touched chunk changed underneath us — re-execute
            if (replacement) t.chunks[idx] = replacement;
            else t.chunks.splice(idx, 1);
          }
          return m;
        },
        rows: this.returningRows(affected, returning, table),
      };
    }
  }

  // ---------- DDL ----------

  private async planCreate(stmt: Extract<Statement, { kind: "create" }>, snap: Snapshot): Promise<PlanOutcome> {
    const TYPES: Record<string, "text" | "integer" | "real" | "boolean" | "timestamp"> = {
      text: "text", varchar: "text", integer: "integer", int: "integer", real: "real",
      float: "real", double: "real", boolean: "boolean", bool: "boolean",
      timestamp: "timestamp", datetime: "timestamp",
    };
    const columns: TableSchema["columns"] = {};
    for (const col of stmt.columns) {
      const type = TYPES[col.type];
      if (!type) {
        throw new SqlError("UNKNOWN_TYPE", `type "${col.type}" is not available; Larva v1 types are text, integer, real, boolean, timestamp`);
      }
      columns[col.name] = { type, primaryKey: col.primaryKey, unique: col.unique, partitionBy: false };
    }
    const pks = stmt.columns.filter((c) => c.primaryKey);
    if (pks.length > 1) throw new SqlError("PARSE_ERROR", `table "${stmt.table}" declares ${pks.length} primary keys; declare exactly one`);
    if (pks.length === 0 && !columns.id) {
      columns.id = { type: "text", primaryKey: true, unique: false, partitionBy: false };
    }
    const tableSchema: TableSchema = { columns, primaryKey: pks[0]?.name ?? "id" };

    if (snap.manifest.tables[stmt.table]) {
      throw new SqlError("TABLE_EXISTS", `table "${stmt.table}" already exists`);
    }
    return {
      apply: (m) => {
        if (m.tables[stmt.table]) return null;
        m.tables[stmt.table] = { chunks: [] };
        m.schema = { ...((m.schema ?? {}) as DatabaseSchema), [stmt.table]: tableSchema };
        return m;
      },
      rows: [],
    };
  }

  private async planDrop(table: string, snap: Snapshot): Promise<PlanOutcome> {
    this.schemaOf(snap.manifest, table); // throws UNKNOWN_TABLE
    return {
      apply: (m) => {
        if (!m.tables[table]) return null;
        delete m.tables[table];
        const schema = { ...((m.schema ?? {}) as DatabaseSchema) };
        delete schema[table];
        m.schema = schema;
        return m;
      },
      rows: [],
    };
  }
}

function validTypeQuick(type: string, v: Scalar): boolean {
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
    default:
      return true;
  }
}
