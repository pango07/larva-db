import { ChunkRef, cmpScalar, CommitStats, IndexBlob, IndexRef, LarvaProto, Manifest, Row, Scalar, Snapshot } from "../core";
import { DatabaseSchema, fillAbsentColumns, TableSchema, validateInsert } from "../schema";
import {
  Aggregate,
  CastType,
  ColumnRef,
  coveredByGroupBy,
  DeleteStmt,
  Expr,
  hasAggregate,
  hasSubquery,
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

/** SQL type names (and common aliases) → Larva column types. */
const COLUMN_TYPES: Record<string, TableSchema["columns"][string]["type"]> = {
  text: "text", varchar: "text", integer: "integer", int: "integer", real: "real",
  float: "real", double: "real", boolean: "boolean", bool: "boolean",
  timestamp: "timestamp", datetime: "timestamp",
};

/** One chunk's entry in a secondary index: sorted distinct non-NULL values. */
function distinctSorted(rows: Row[], col: string): Scalar[] {
  return [...new Set(rows.map((r) => r[col] ?? null).filter((v) => v !== null))].sort(cmpScalar);
}

function sortedHas(vals: Scalar[], v: Scalar): boolean {
  let lo = 0;
  let hi = vals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cmpScalar(vals[mid], v);
    if (c === 0) return true;
    if (c < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** Any value in the sorted array within [lo, hi]? */
function sortedOverlaps(vals: Scalar[], lo: Scalar, hi: Scalar): boolean {
  let a = 0;
  let b = vals.length;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (cmpScalar(vals[mid], lo) < 0) a = mid + 1;
    else b = mid;
  }
  return a < vals.length && cmpScalar(vals[a], hi) <= 0;
}

export interface ExecOptions {
  allowFullTable?: boolean;
  maxAttempts?: number;
  /** Format 4: this instance's not-yet-folded append rows, per table. SELECTs
   * scan them alongside chunk rows (read-your-writes); write planning never
   * sees them — ordered writes fold first instead (the barrier in LarvaDb). */
  overlay?: Record<string, Row[]>;
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

  /** Stats of the most recent direct write commit — LarvaDb's contention
   * heuristic reads this to decide when to escalate to the ordered queue. */
  lastCommitStats?: CommitStats;

  async execute(stmt: Statement, params: Scalar[], opts: ExecOptions, snap?: Snapshot): Promise<Row[]> {
    if (stmt.kind === "select") return this.select(stmt, params, snap ?? (await this.proto.snapshot()), opts.overlay);
    // Single-statement write: plan against each (re)fetched snapshot, one CAS.
    let rows: Row[] = [];
    const result = await this.proto.commit(async (s) => {
      const plan = await this.plan(stmt, params, opts, s);
      rows = plan.rows;
      return { apply: plan.apply };
    }, opts);
    this.lastCommitStats = result.stats;
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

  private async plan(stmt: Statement, params: Scalar[], opts: ExecOptions, snap: Snapshot): Promise<PlanOutcome> {
    // Subqueries in writes resolve against the same snapshot the plan uses, so
    // a commit retry that re-plans also re-evaluates them on the fresh state.
    if (this.statementHasSubquery(stmt)) stmt = await this.resolveSubqueries(stmt, params, snap);
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
      case "alter":
        return this.planAlter(stmt, snap);
      case "createIndex":
        return this.planCreateIndex(stmt, snap);
      case "dropIndex":
        return this.planDropIndex(stmt, snap);
    }
  }

  // ---------- reads ----------

  /** Chunk rows plus this instance's un-folded append rows, deduped by pk —
   * a row both folded and still pending must not appear twice. */
  private withOverlay(rows: Row[], extra: Row[] | undefined, schema: TableSchema): Row[] {
    if (!extra?.length) return rows;
    const seen = new Set(rows.map((r) => r[schema.primaryKey]));
    return rows.concat(extra.filter((r) => !seen.has(r[schema.primaryKey])));
  }

  private async select(stmt: SelectStmt, params: Scalar[], snap: Snapshot, overlay?: Record<string, Row[]>): Promise<Row[]> {
    if (this.statementHasSubquery(stmt)) {
      stmt = (await this.resolveSubqueries(stmt, params, snap, overlay)) as SelectStmt;
    }
    const fromName = stmt.from.alias ?? stmt.from.table;
    const fromSchema = this.schemaOf(snap.manifest, stmt.from.table);
    const leftChunks = await this.fetchTable(snap, stmt.from.table, fromSchema, stmt.where, fromName, params);
    const leftRows = this.withOverlay(leftChunks.flatMap((c) => c.rows), overlay?.[stmt.from.table], fromSchema);
    const realCols = new Set(Object.keys(fromSchema.columns));

    // Left-deep hash joins, in statement order: each JOIN's ON compares a
    // column of the joined table against a column of any table already in
    // scope. Self-joins are ordinary — the parser guarantees distinct names.
    const scopes: { name: string; schema: TableSchema }[] = [{ name: fromName, schema: fromSchema }];
    let contexts: Ctx[] = leftRows.map((r) => ({ [fromName]: r }));
    for (const join of stmt.joins ?? []) {
      const joinName = join.table.alias ?? join.table.table;
      const joinSchema = this.schemaOf(snap.manifest, join.table.table);
      Object.keys(joinSchema.columns).forEach((c) => realCols.add(c));
      const rightRows = this.withOverlay(
        (await this.fetchTable(snap, join.table.table, joinSchema, undefined, joinName, params)).flatMap((c) => c.rows),
        overlay?.[join.table.table],
        joinSchema,
      );

      // Resolve each side of ON to the joined table or a table already in scope.
      const resolve = (col: ColumnRef): { name: string; isJoined: boolean } => {
        if (col.table === joinName) return { name: joinName, isJoined: true };
        if (col.table) {
          const prior = scopes.find((s) => s.name === col.table);
          if (prior) return { name: prior.name, isJoined: false };
          throw new SqlError(
            "UNKNOWN_TABLE",
            `JOIN condition references "${col.table}", which is not in scope (tables: ${[...scopes.map((s) => s.name), joinName].join(", ")})`,
          );
        }
        const inJoined = col.name in joinSchema.columns;
        const priors = scopes.filter((s) => col.name in s.schema.columns);
        if (inJoined && priors.length === 0) return { name: joinName, isJoined: true };
        if (!inJoined && priors.length === 1) return { name: priors[0].name, isJoined: false };
        if (!inJoined && priors.length === 0) {
          throw new SqlError("UNKNOWN_COLUMN", `JOIN condition references unknown column "${col.name}"`);
        }
        throw new SqlError("AMBIGUOUS_COLUMN", `"${col.name}" exists in more than one joined table; qualify it`);
      };
      const left = resolve(join.leftCol);
      const right = resolve(join.rightCol);
      if (left.isJoined === right.isJoined) {
        throw new SqlError(
          "INVALID_JOIN_CONDITION",
          `JOIN ${joinName} … ON must compare a column of "${joinName}" with a column of an earlier table`,
        );
      }
      const joinKey = (left.isJoined ? join.leftCol : join.rightCol).name;
      const prior = left.isJoined ? { name: right.name, col: join.rightCol.name } : { name: left.name, col: join.leftCol.name };

      const index = new Map<Scalar, Row[]>();
      for (const r of rightRows) {
        const k = r[joinKey];
        index.set(k, [...(index.get(k) ?? []), r]);
      }
      const nullRight: Row = Object.fromEntries(Object.keys(joinSchema.columns).map((c) => [c, null]));
      contexts = contexts.flatMap((ctx) => {
        const v = ctx[prior.name][prior.col];
        const matches = v === null ? [] : (index.get(v) ?? []);
        if (matches.length > 0) return matches.map((r) => ({ ...ctx, [joinName]: r }));
        return join.type === "left" ? [{ ...ctx, [joinName]: nullRight }] : [];
      });
      scopes.push({ name: joinName, schema: joinSchema });
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

  // ---------- uncorrelated subqueries (Design §7) ----------

  /** Any subquery node in the statement's expressions? (RETURNING is excluded:
   * it accepts plain columns only and rejects anything else on its own.) */
  private statementHasSubquery(stmt: Statement): boolean {
    switch (stmt.kind) {
      case "select":
        return (
          (stmt.items ?? []).some((i) => hasSubquery(i.expr)) ||
          (stmt.where !== undefined && hasSubquery(stmt.where)) ||
          (stmt.having !== undefined && hasSubquery(stmt.having)) ||
          (stmt.groupBy ?? []).some(hasSubquery) ||
          (stmt.limit !== undefined && hasSubquery(stmt.limit)) ||
          (stmt.offset !== undefined && hasSubquery(stmt.offset))
        );
      case "insert":
        return (
          stmt.rows.some((r) => r.some(hasSubquery)) ||
          (stmt.onConflict !== undefined &&
            stmt.onConflict.action !== "nothing" &&
            stmt.onConflict.action.set.some((s) => hasSubquery(s.value)))
        );
      case "update":
        return stmt.set.some((s) => hasSubquery(s.value)) || (stmt.where !== undefined && hasSubquery(stmt.where));
      case "delete":
        return stmt.where !== undefined && hasSubquery(stmt.where);
      default:
        return false;
    }
  }

  /**
   * Inner-query-first evaluation, exactly as Design §7 planned it: each
   * subquery executes against the same snapshot as the outer statement, and
   * its node is rewritten into plain literals before the outer plan runs.
   * Rewriting (not late binding) is what lets IN lists participate in
   * zone-map pruning — and it never mutates the parsed AST, so a re-planned
   * commit re-evaluates subqueries on the fresh snapshot.
   */
  private async resolveSubqueries(
    stmt: Statement,
    params: Scalar[],
    snap: Snapshot,
    overlay?: Record<string, Row[]>,
  ): Promise<Statement> {
    const run = async (query: SelectStmt, where: string): Promise<Scalar[]> => {
      let rows: Row[];
      try {
        rows = await this.select(query, params, snap, overlay);
      } catch (err) {
        if (err instanceof SqlError && ["UNKNOWN_TABLE", "UNKNOWN_COLUMN", "AMBIGUOUS_COLUMN"].includes(err.code)) {
          throw new SqlError(
            err.code,
            `${err.message} — thrown inside a subquery, which cannot see the outer query's tables (correlated subqueries are not supported; use a JOIN instead)`,
          );
        }
        throw err;
      }
      if (query.items && query.items.length !== 1) {
        throw new SqlError("SUBQUERY_SHAPE", `a subquery used ${where} must select exactly one column; this one selects ${query.items.length}`);
      }
      return rows.map((r) => {
        const keys = Object.keys(r);
        if (keys.length !== 1) {
          throw new SqlError("SUBQUERY_SHAPE", `a subquery used ${where} must select exactly one column; this one returns ${keys.length}`);
        }
        return r[keys[0]];
      });
    };

    const rewrite = async (e: Expr): Promise<Expr> => {
      switch (e.kind) {
        case "subquery": {
          const vals = await run(e.query, "as a value");
          if (vals.length > 1) {
            throw new SqlError(
              "SUBQUERY_MULTIPLE_ROWS",
              `a scalar subquery returned ${vals.length} rows; use IN (SELECT …) for set membership, or make the subquery yield one row (LIMIT 1 or an aggregate)`,
            );
          }
          return { kind: "literal", value: vals[0] ?? null };
        }
        case "insub": {
          // NULLs are dropped from the list: Larva is two-valued throughout
          // (Design §7), so x IN (…) never matches NULL and x NOT IN (…)
          // deliberately does NOT inherit SQL's NULL-poisoning trap.
          const vals = (await run(e.query, "with IN")).filter((v) => v !== null);
          return {
            kind: "in",
            expr: await rewrite(e.expr),
            list: vals.map((value): Expr => ({ kind: "literal", value })),
            negated: e.negated,
          };
        }
        case "column":
        case "literal":
        case "param":
          return e;
        case "aggregate":
          return {
            ...e,
            arg: e.arg === null ? null : await rewrite(e.arg),
            sep: e.sep === undefined ? undefined : await rewrite(e.sep),
          };
        case "binary":
          return { ...e, left: await rewrite(e.left), right: await rewrite(e.right) };
        case "not":
        case "isnull":
          return { ...e, expr: await rewrite(e.expr) };
        case "cast":
          return { ...e, expr: await rewrite(e.expr) };
        case "in":
          return { ...e, expr: await rewrite(e.expr), list: await Promise.all(e.list.map(rewrite)) };
        case "between":
          return { ...e, expr: await rewrite(e.expr), lo: await rewrite(e.lo), hi: await rewrite(e.hi) };
        case "like":
          return { ...e, expr: await rewrite(e.expr), pattern: await rewrite(e.pattern) };
        case "func":
          return { ...e, args: await Promise.all(e.args.map(rewrite)) };
        case "case":
          return {
            ...e,
            branches: await Promise.all(e.branches.map(async (b) => ({ when: await rewrite(b.when), then: await rewrite(b.then) }))),
            else: e.else === undefined ? undefined : await rewrite(e.else),
          };
      }
    };

    switch (stmt.kind) {
      case "select":
        return {
          ...stmt,
          items:
            stmt.items === null
              ? null
              : await Promise.all(stmt.items.map(async (i) => ({ ...i, expr: await rewrite(i.expr) }))),
          where: stmt.where === undefined ? undefined : await rewrite(stmt.where),
          having: stmt.having === undefined ? undefined : await rewrite(stmt.having),
          groupBy: stmt.groupBy === undefined ? undefined : await Promise.all(stmt.groupBy.map(rewrite)),
          limit: stmt.limit === undefined ? undefined : await rewrite(stmt.limit),
          offset: stmt.offset === undefined ? undefined : await rewrite(stmt.offset),
        };
      case "insert":
        return {
          ...stmt,
          rows: await Promise.all(stmt.rows.map((r) => Promise.all(r.map(rewrite)))),
          onConflict:
            stmt.onConflict === undefined || stmt.onConflict.action === "nothing"
              ? stmt.onConflict
              : {
                  ...stmt.onConflict,
                  action: {
                    set: await Promise.all(
                      stmt.onConflict.action.set.map(async (s) => ({ ...s, value: await rewrite(s.value) })),
                    ),
                  },
                },
        };
      case "update":
        return {
          ...stmt,
          set: await Promise.all(stmt.set.map(async (s) => ({ ...s, value: await rewrite(s.value) }))),
          where: stmt.where === undefined ? undefined : await rewrite(stmt.where),
        };
      case "delete":
        return { ...stmt, where: stmt.where === undefined ? undefined : await rewrite(stmt.where) };
      default:
        return stmt;
    }
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
    let survivors = refs.filter((ref) => {
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

    // Secondary indexes: for each bounded column with an index, keep only the
    // chunks whose distinct-value entry can satisfy the predicate. A chunk id
    // absent from the index, or a missing index blob, means "always fetch" —
    // staleness degrades pruning, never results.
    const indexes = snap.manifest.tables[table]?.indexes;
    if (indexes && survivors.length > 0) {
      for (const [col, b] of Object.entries(bounds)) {
        const ref = indexes[col];
        if (!ref) continue;
        const blob = await this.proto.readIndex(ref);
        if (!blob) continue;
        survivors = survivors.filter((c) => {
          const vals = blob[c.id];
          if (!vals) return true;
          if (!sortedOverlaps(vals, b.lo, b.hi)) return false;
          return b.values ? b.values.some((v) => sortedHas(vals, v)) : true;
        });
        if (survivors.length === 0) break;
      }
    }
    this.lastStats = { chunksTotal: refs.length, chunksFetched: survivors.length };
    // Chunks written before an ALTER TABLE lack the added columns — absent
    // keys read as NULL. fillAbsentColumns never mutates the cached rows.
    return Promise.all(
      survivors.map(async (ref) => ({ ref, rows: fillAbsentColumns(await this.proto.readChunk(ref), schema) })),
    );
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
  ): Record<string, { lo: Scalar; hi: Scalar; values?: Scalar[] }> {
    const bounds: Record<string, { lo: Scalar; hi: Scalar; values?: Scalar[] }> = {};
    const scalarOf = (e: Expr): Scalar | undefined =>
      e.kind === "literal" ? e.value : e.kind === "param" ? params[e.index] : undefined;
    const colOf = (e: Expr): string | undefined =>
      e.kind === "column" && (!e.table || e.table === ctxName) ? e.name : undefined;
    // `values` carries the exact =/IN candidate set for index membership
    // checks; ranges leave it unset. Keeping either side's set on merge is a
    // superset check — safe for pruning.
    const narrow = (col: string, lo: Scalar, hi: Scalar, values?: Scalar[]) => {
      const cur = bounds[col];
      const merged = cur
        ? { lo: cmpScalar(lo, cur.lo) > 0 ? lo : cur.lo, hi: cmpScalar(hi, cur.hi) < 0 ? hi : cur.hi }
        : { lo, hi };
      const keep = cur?.values && values ? cur.values.filter((v) => values.includes(v)) : (cur?.values ?? values);
      bounds[col] = { ...merged, ...(keep ? { values: keep } : {}) };
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
          if (op === "=") narrow(col, val, val, [val]);
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
          narrow(col, sorted[0], sorted[sorted.length - 1], sorted);
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
      case "subquery":
      case "insub":
        throw new SqlError("INTERNAL", "subquery nodes must be resolved before evaluation"); // unreachable — resolveSubqueries runs first
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

  /**
   * Evaluate an INSERT's rows to final, validated form: expressions evaluated,
   * omitted sequence columns claimed (locally-leased ranges), auto ids filled.
   * After this, the rows' content is fully client-determined — which is what
   * the tier-A append path (LarvaDb) relies on to acknowledge at durability.
   */
  async prepareRows(stmt: InsertStmt, params: Scalar[], schema: TableSchema): Promise<Row[]> {
    const rawRows: Row[] = stmt.rows.map((values) => {
      const raw: Row = {};
      stmt.columns.forEach((col, i) => {
        raw[col] = this.evalExpr(values[i], {}, params);
      });
      return raw;
    });

    // Fill omitted sequence columns before validation. Claims go through the
    // sequences blob, off the manifest hot path; on re-execution fresh values
    // are drawn (gaps, never duplicates).
    for (const [col, def] of Object.entries(schema.columns)) {
      if (!def.sequence) continue;
      const needy = rawRows.filter((r) => (r[col] ?? null) === null);
      if (needy.length > 0) {
        const vals = await this.proto.claimSequence(`${stmt.table}.${col}`, needy.length);
        needy.forEach((r, i) => (r[col] = vals[i]));
      }
    }
    return rawRows.map((raw) => validateInsert(stmt.table, schema, raw));
  }

  /** RETURNING projection for rows that never went through a plan (tier A). */
  projectReturning(rows: Row[], returning: SelectItem[] | null | undefined, table: string): Row[] {
    return this.returningRows(rows, returning, table);
  }

  /**
   * Re-stage `table`'s secondary-index blobs to reflect a chunk change in the
   * commit being planned: drop retired chunk entries, add entries for new
   * chunks. Reads the planning snapshot's blobs (immutable, cached). Also the
   * fold path's maintenance hook (LarvaDb). Returns {} when nothing is indexed.
   */
  async stageIndexUpdates(
    snap: Snapshot,
    table: string,
    schema: TableSchema,
    retiredIds: string[],
    added: { ref: ChunkRef; rows: Row[] }[],
  ): Promise<Record<string, IndexRef>> {
    const cols = Object.keys(schema.columns).filter((c) => schema.columns[c].indexed);
    if (cols.length === 0) return {};
    const out: Record<string, IndexRef> = {};
    for (const col of cols) {
      const cur = snap.manifest.tables[table]?.indexes?.[col];
      const blob: IndexBlob = { ...(cur ? ((await this.proto.readIndex(cur)) ?? {}) : {}) };
      for (const id of retiredIds) delete blob[id];
      for (const { ref, rows } of added) blob[ref.id] = distinctSorted(rows, col);
      out[col] = await this.proto.stageIndex(table, col, blob);
    }
    return out;
  }

  /** Apply staged index refs to a manifest's table entry (inside apply()). */
  private static repointIndexes(t: { indexes?: Record<string, IndexRef> }, updates: Record<string, IndexRef>): void {
    for (const [col, ref] of Object.entries(updates)) (t.indexes ??= {})[col] = ref;
  }

  private async planInsert(stmt: InsertStmt, params: Scalar[], snap: Snapshot): Promise<PlanOutcome> {
    const schema = this.schemaOf(snap.manifest, stmt.table);
    const incoming = await this.prepareRows(stmt, params, schema);

    // Uniqueness, treated uniformly: the pk, single UNIQUE columns, and
    // declared composite constraints. A constraint's key is null when any of
    // its columns is NULL (SQL semantics: NULLs never conflict).
    type Constraint = { label: string; cols: string[]; isPk: boolean };
    const constraints: Constraint[] = [
      { label: schema.primaryKey, cols: [schema.primaryKey], isPk: true },
      ...Object.entries(schema.columns)
        .filter(([, c]) => c.unique)
        .map(([n]) => ({ label: n, cols: [n], isPk: false })),
      ...(schema.uniques ?? []).map((cols) => ({ label: `(${cols.join(", ")})`, cols, isPk: false })),
    ];
    const keyOf = (c: Constraint, row: Row): string | null =>
      c.cols.some((col) => (row[col] ?? null) === null) ? null : JSON.stringify(c.cols.map((col) => row[col]));

    const oc = stmt.onConflict;
    let target: Constraint | null = null;
    if (oc) {
      const cols = oc.columns ?? [schema.primaryKey];
      for (const c of cols) {
        if (!(c in schema.columns)) {
          throw new SqlError("UNKNOWN_COLUMN", `ON CONFLICT target "${c}" does not exist in table "${stmt.table}"`);
        }
      }
      const setKey = (list: string[]) => [...list].sort().join(" ");
      target = constraints.find((c) => setKey(c.cols) === setKey(cols)) ?? null;
      if (!target) {
        throw new SqlError(
          "INVALID_CONFLICT_TARGET",
          cols.length === 1
            ? `ON CONFLICT target "${cols[0]}" must be the primary key or a UNIQUE column — conflicts are only detectable where uniqueness is enforced`
            : `ON CONFLICT (${cols.join(", ")}) must match a composite unique constraint declared in defineSchema's uniques option`,
        );
      }
    }

    // Conflict detection against the snapshot (pruned lookup). Note:
    // snapshot-isolated — two concurrent inserts of the same pk are write
    // skew (Design §6) and not detected; ULID defaults make this moot.
    const pks = incoming.map((r) => r[schema.primaryKey]);
    const candidates = (snap.manifest.tables[stmt.table]?.chunks ?? []).filter((ref) => {
      if (!ref.stats || constraints.length > 1) return true; // unique constraints force full scan
      return pks.some((pk) => cmpScalar(ref.stats!.pkMin, pk) <= 0 && cmpScalar(ref.stats!.pkMax, pk) >= 0);
    });
    // Copy (never mutate the chunk cache) and NULL-fill columns added by
    // ALTER TABLE, so DO UPDATE SET expressions can read them on old rows.
    const loaded = await Promise.all(
      candidates.map(async (ref) => ({ ref, rows: [...fillAbsentColumns(await this.proto.readChunk(ref), schema)] })),
    );

    // Rows are processed in statement order, each seeing the effect of the
    // previous ones (SQLite upsert semantics): a row can conflict with an
    // earlier row of the same INSERT.
    type Loc = { kind: "chunk"; chunk: number; idx: number } | { kind: "pending"; idx: number };
    const maps = new Map<string, Map<string, Loc>>(constraints.map((c) => [c.label, new Map()]));
    loaded.forEach((c, ci) =>
      c.rows.forEach((row, ri) => {
        for (const con of constraints) {
          const k = keyOf(con, row);
          if (k !== null) maps.get(con.label)!.set(k, { kind: "chunk", chunk: ci, idx: ri });
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
      let hit: { con: Constraint; loc: Loc } | null = null;
      for (const con of constraints) {
        const k = keyOf(con, row);
        const l = k !== null ? maps.get(con.label)!.get(k) : undefined;
        if (l) {
          hit = { con, loc: l };
          break;
        }
      }

      if (!hit) {
        const ploc: Loc = { kind: "pending", idx: pending.length };
        pending.push(row);
        for (const con of constraints) {
          const k = keyOf(con, row);
          if (k !== null) maps.get(con.label)!.set(k, ploc);
        }
        resultRows.push(row);
        continue;
      }
      const loc = hit.loc;

      if (!oc || !target || hit.con.label !== target.label) {
        const hint = oc && target ? `; the ON CONFLICT target is "${target.label}", which does not cover this conflict` : "";
        if (hit.con.isPk) {
          throw new SqlError(
            "PRIMARY_KEY_CONFLICT",
            loc.kind === "pending"
              ? `duplicate primary key within the inserted rows${hint}`
              : `primary key ${JSON.stringify(row[schema.primaryKey])} already exists in "${stmt.table}"${hint}`,
          );
        }
        const vals = hit.con.cols.map((c) => JSON.stringify(row[c])).join(", ");
        throw new SqlError(
          "UNIQUE_CONFLICT",
          hit.con.cols.length === 1
            ? `value ${vals} already exists in unique column "${stmt.table}.${hit.con.label}"${hint}`
            : `values (${vals}) already exist for unique constraint ${hit.con.label} on "${stmt.table}"${hint}`,
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
      for (const con of constraints) {
        if (con.isPk) continue; // pk updates are rejected above
        const oldK = keyOf(con, existing);
        const newK = keyOf(con, next);
        if (oldK === newK) continue;
        if (oldK !== null) maps.get(con.label)!.delete(oldK);
        if (newK !== null) {
          if (maps.get(con.label)!.has(newK)) {
            throw new SqlError(
              "UNIQUE_CONFLICT",
              con.cols.length === 1
                ? `ON CONFLICT DO UPDATE would duplicate value ${JSON.stringify(next[con.cols[0]])} in unique column "${stmt.table}.${con.label}"`
                : `ON CONFLICT DO UPDATE would duplicate unique constraint ${con.label} on "${stmt.table}"`,
            );
          }
          maps.get(con.label)!.set(newK, loc);
        }
      }
      setRow(loc, next);
      resultRows.push(next);
    }

    const statsCols = { pk: schema.primaryKey, part: schema.partitionColumn };
    const replacements: { retired: ChunkRef; replacement: ChunkRef }[] = [];
    const staged: { ref: ChunkRef; rows: Row[] }[] = [];
    for (const ci of dirty) {
      const replacement = await this.proto.stageChunk(stmt.table, loaded[ci].rows, statsCols);
      replacements.push({ retired: loaded[ci].ref, replacement });
      staged.push({ ref: replacement, rows: loaded[ci].rows });
    }
    const appended: ChunkRef[] = [];
    for (let i = 0; i < pending.length; i += CHUNK_TARGET_ROWS) {
      const slice = pending.slice(i, i + CHUNK_TARGET_ROWS);
      const ref = await this.proto.stageChunk(stmt.table, slice, statsCols);
      appended.push(ref);
      staged.push({ ref, rows: slice });
    }
    const indexUpdates = await this.stageIndexUpdates(
      snap,
      stmt.table,
      schema,
      replacements.map((r) => r.retired.id),
      staged,
    );

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
        Executor.repointIndexes(t, indexUpdates);
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
      const staged: { ref: ChunkRef; rows: Row[] }[] = [];
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
          const replacement = out.length > 0 ? await this.proto.stageChunk(table, out, statsCols) : null;
          replacements.push({ retired: ref, replacement });
          if (replacement) staged.push({ ref: replacement, rows: out });
        }
      }
      const indexUpdates = await this.stageIndexUpdates(
        snap,
        table,
        schema,
        replacements.map((r) => r.retired.id),
        staged,
      );

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
          Executor.repointIndexes(t, indexUpdates);
          return m;
        },
        rows: this.returningRows(affected, returning, table),
      };
    }
  }

  // ---------- DDL ----------

  private async planCreate(stmt: Extract<Statement, { kind: "create" }>, snap: Snapshot): Promise<PlanOutcome> {
    const columns: TableSchema["columns"] = {};
    for (const col of stmt.columns) {
      const type = COLUMN_TYPES[col.type];
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

  /** ADD COLUMN of a plain nullable column: a schema-only commit. Existing
   * chunks are untouched — absent keys read as NULL (fillAbsentColumns). */
  private async planAlter(stmt: Extract<Statement, { kind: "alter" }>, snap: Snapshot): Promise<PlanOutcome> {
    const schema = this.schemaOf(snap.manifest, stmt.table);
    const type = COLUMN_TYPES[stmt.column.type];
    if (!type) {
      throw new SqlError("UNKNOWN_TYPE", `type "${stmt.column.type}" is not available; Larva types are text, integer, real, boolean, timestamp`);
    }
    if (stmt.column.name in schema.columns) {
      throw new SqlError("DUPLICATE_COLUMN", `column "${stmt.column.name}" already exists in table "${stmt.table}"`);
    }
    const { table, column } = stmt;
    return {
      apply: (m) => {
        const live = ((m.schema ?? {}) as DatabaseSchema)[table];
        if (!live || column.name in live.columns) return null; // changed underneath us — re-execute for the precise error
        const next: TableSchema = {
          ...live,
          columns: { ...live.columns, [column.name]: { type, primaryKey: false, unique: false, partitionBy: false } },
        };
        m.schema = { ...((m.schema ?? {}) as DatabaseSchema), [table]: next };
        return m;
      },
      rows: [],
    };
  }

  /** Build the full index from the current chunk set, then commit the ref +
   * schema flag atomically. Any chunk change underneath forces a rebuild via
   * re-execution, so the initial build always covers the committed state. */
  private async planCreateIndex(stmt: Extract<Statement, { kind: "createIndex" }>, snap: Snapshot): Promise<PlanOutcome> {
    const schema = this.schemaOf(snap.manifest, stmt.table);
    const { table, column } = stmt;
    if (!(column in schema.columns)) {
      throw new SqlError("UNKNOWN_COLUMN", `column "${column}" does not exist in table "${table}" (columns: ${Object.keys(schema.columns).join(", ")})`);
    }
    if (schema.columns[column].indexed) {
      if (stmt.ifNotExists) return { apply: (m) => m, rows: [] };
      throw new SqlError("INDEX_EXISTS", `column "${table}.${column}" is already indexed; DROP INDEX ON ${table} (${column}) first`);
    }
    const chunks = snap.manifest.tables[table]?.chunks ?? [];
    const blob: IndexBlob = {};
    for (const ref of chunks) {
      blob[ref.id] = distinctSorted(await this.proto.readChunk(ref), column);
    }
    const idxRef = await this.proto.stageIndex(table, column, blob);
    const baseSig = chunks.map((c) => c.id).join(",");
    return {
      apply: (m) => {
        const t = m.tables[table];
        if (!t || t.chunks.map((c) => c.id).join(",") !== baseSig) return null; // chunks moved — rebuild
        (t.indexes ??= {})[column] = idxRef;
        const s = (m.schema ?? {}) as DatabaseSchema;
        const live = s[table];
        if (live?.columns[column]) {
          m.schema = {
            ...s,
            [table]: { ...live, columns: { ...live.columns, [column]: { ...live.columns[column], indexed: true } } },
          };
        }
        return m;
      },
      rows: [],
    };
  }

  private async planDropIndex(stmt: Extract<Statement, { kind: "dropIndex" }>, snap: Snapshot): Promise<PlanOutcome> {
    const schema = this.schemaOf(snap.manifest, stmt.table);
    const { table, column } = stmt;
    if (!(column in schema.columns)) {
      throw new SqlError("UNKNOWN_COLUMN", `column "${column}" does not exist in table "${table}" (columns: ${Object.keys(schema.columns).join(", ")})`);
    }
    if (!schema.columns[column].indexed) {
      throw new SqlError("INDEX_NOT_FOUND", `there is no index on "${table}.${column}"`);
    }
    return {
      apply: (m) => {
        const t = m.tables[table];
        if (!t) return null;
        if (t.indexes) {
          delete t.indexes[column];
          if (Object.keys(t.indexes).length === 0) delete t.indexes;
        }
        const s = (m.schema ?? {}) as DatabaseSchema;
        const live = s[table];
        if (live?.columns[column]) {
          const rest = { ...live.columns[column] };
          delete rest.indexed;
          m.schema = { ...s, [table]: { ...live, columns: { ...live.columns, [column]: rest } } };
        }
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
