import { ChunkRef, cmpScalar, LarvaProto, Manifest, Row, Scalar, Snapshot } from "../core";
import { DatabaseSchema, TableSchema, validateInsert } from "../schema";
import {
  Aggregate,
  ColumnRef,
  DeleteStmt,
  Expr,
  InsertStmt,
  SelectItem,
  SelectStmt,
  Statement,
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
    switch (stmt.kind) {
      case "select":
        return this.select(stmt, params, snap ?? (await this.proto.snapshot()));
      case "insert":
        return this.insert(stmt, params, opts);
      case "update":
        return this.update(stmt, params, opts);
      case "delete":
        return this.delete(stmt, params, opts);
      case "create":
        return this.createTable(stmt, opts);
      case "drop":
        return this.dropTable(stmt.table, opts);
    }
  }

  // ---------- reads ----------

  private async select(stmt: SelectStmt, params: Scalar[], snap: Snapshot): Promise<Row[]> {
    const fromName = stmt.from.alias ?? stmt.from.table;
    const fromSchema = this.schemaOf(snap.manifest, stmt.from.table);
    const leftChunks = await this.fetchTable(snap, stmt.from.table, fromSchema, stmt.where, fromName, params);
    const leftRows = leftChunks.flatMap((c) => c.rows);

    let contexts: Ctx[];
    if (stmt.join) {
      const joinName = stmt.join.table.alias ?? stmt.join.table.table;
      const joinSchema = this.schemaOf(snap.manifest, stmt.join.table.table);
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
    const hasAggregates = stmt.items?.some((i) => i.expr.kind === "aggregate") ?? false;
    if (stmt.groupBy || hasAggregates) {
      output = this.grouped(stmt, contexts, params);
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
        contexts.sort((a, b) => {
          for (const { column, desc } of stmt.orderBy as { column: ColumnRef; desc: boolean }[]) {
            const c = cmpScalar(this.resolveColumn(column, a), this.resolveColumn(column, b));
            if (c !== 0) return desc ? -c : c;
          }
          return 0;
        });
      }
      output = contexts.map((ctx) => this.project(stmt.items, ctx));
    }

    const limit = stmt.limit !== undefined ? this.intOf(stmt.limit, params, "LIMIT") : undefined;
    const offset = stmt.offset !== undefined ? this.intOf(stmt.offset, params, "OFFSET") : 0;
    return output.slice(offset, limit !== undefined ? offset + limit : undefined);
  }

  private grouped(stmt: SelectStmt, contexts: Ctx[], params: Scalar[]): Row[] {
    const items = stmt.items;
    if (!items) throw new SqlError("PARSE_ERROR", "SELECT * cannot be combined with GROUP BY or aggregates; list columns explicitly");
    const groupCols = stmt.groupBy ?? [];
    for (const item of items) {
      if (item.expr.kind === "column") {
        const name = item.expr.name;
        if (!groupCols.some((g) => g.name === name)) {
          throw new SqlError(
            "NOT_GROUPED",
            `column "${name}" must appear in GROUP BY or inside an aggregate`,
          );
        }
      }
    }

    const groups = new Map<string, Ctx[]>();
    for (const ctx of contexts) {
      const key = JSON.stringify(groupCols.map((g) => this.resolveColumn(g, ctx)));
      groups.set(key, [...(groups.get(key) ?? []), ctx]);
    }
    if (groups.size === 0 && groupCols.length === 0) groups.set("[]", []); // aggregate over empty table

    return [...groups.values()].map((rows) => {
      const out: Row = {};
      for (const item of items) {
        const name = item.alias ?? (item.expr.kind === "aggregate" ? item.expr.func.toLowerCase() : item.expr.name);
        out[name] =
          item.expr.kind === "aggregate"
            ? this.aggregate(item.expr, rows, params)
            : this.resolveColumn(item.expr, rows[0]);
      }
      return out;
    });
  }

  private aggregate(agg: Aggregate, rows: Ctx[], params: Scalar[]): Scalar {
    void params;
    if (agg.func === "COUNT" && agg.arg === null) return rows.length;
    if (agg.arg === null) throw new SqlError("PARSE_ERROR", `${agg.func}(*) is not valid; ${agg.func} needs a column`);
    const values = rows.map((ctx) => this.resolveColumn(agg.arg as ColumnRef, ctx)).filter((v) => v !== null);
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
          throw new SqlError("TYPE_MISMATCH", `${agg.func}(${agg.arg.name}) requires a numeric column`);
        }
        if (values.length === 0) return null;
        const sum = (values as number[]).reduce((a, b) => a + b, 0);
        return agg.func === "SUM" ? sum : sum / values.length;
      }
    }
  }

  private project(items: SelectItem[] | null, ctx: Ctx): Row {
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
    for (const item of items) {
      if (item.expr.kind === "aggregate") throw new SqlError("PARSE_ERROR", "aggregates require GROUP BY handling"); // unreachable
      out[item.alias ?? item.expr.name] = this.resolveColumn(item.expr, ctx);
    }
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

  private evalExpr(e: Expr, ctx: Ctx, params: Scalar[]): Scalar {
    switch (e.kind) {
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
        return !this.truthy(this.evalExpr(e.expr, ctx, params));
      case "isnull": {
        const v = this.evalExpr(e.expr, ctx, params);
        return e.negated ? v !== null : v === null;
      }
      case "in": {
        const v = this.evalExpr(e.expr, ctx, params);
        const hit = v !== null && e.list.some((item) => this.evalExpr(item, ctx, params) === v);
        return e.negated ? !hit : hit;
      }
      case "between": {
        const v = this.evalExpr(e.expr, ctx, params);
        if (v === null) return false;
        const hit =
          cmpScalar(v, this.evalExpr(e.lo, ctx, params)) >= 0 &&
          cmpScalar(v, this.evalExpr(e.hi, ctx, params)) <= 0;
        return e.negated ? !hit : hit;
      }
      case "like": {
        const v = this.evalExpr(e.expr, ctx, params);
        const pattern = this.evalExpr(e.pattern, ctx, params);
        if (typeof v !== "string" || typeof pattern !== "string") return e.negated;
        const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, "s");
        return e.negated ? !re.test(v) : re.test(v);
      }
      case "binary": {
        if (e.op === "AND") return this.truthy(this.evalExpr(e.left, ctx, params)) && this.truthy(this.evalExpr(e.right, ctx, params));
        if (e.op === "OR") return this.truthy(this.evalExpr(e.left, ctx, params)) || this.truthy(this.evalExpr(e.right, ctx, params));
        const l = this.evalExpr(e.left, ctx, params);
        const r = this.evalExpr(e.right, ctx, params);
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

  private async insert(stmt: InsertStmt, params: Scalar[], opts: ExecOptions): Promise<Row[]> {
    let inserted: Row[] = [];
    await this.proto.commit(async (snap) => {
      const schema = this.schemaOf(snap.manifest, stmt.table);
      inserted = stmt.rows.map((values) => {
        const raw: Row = {};
        stmt.columns.forEach((col, i) => {
          raw[col] = this.evalExpr(values[i], {}, params);
        });
        return validateInsert(stmt.table, schema, raw);
      });

      // Primary-key uniqueness against the snapshot (pruned lookup). Note:
      // snapshot-isolated — two concurrent inserts of the same pk are write
      // skew (Design §6) and not detected; ULID defaults make this moot.
      const pks = inserted.map((r) => r[schema.primaryKey]);
      if (new Set(pks).size !== pks.length) {
        throw new SqlError("PRIMARY_KEY_CONFLICT", `duplicate primary key within the inserted rows`);
      }
      const uniqueCols = Object.entries(schema.columns).filter(([, c]) => c.unique).map(([n]) => n);
      const candidates = (snap.manifest.tables[stmt.table]?.chunks ?? []).filter((ref) => {
        if (!ref.stats || uniqueCols.length > 0) return true; // unique columns force full scan
        return pks.some((pk) => cmpScalar(ref.stats!.pkMin, pk) <= 0 && cmpScalar(ref.stats!.pkMax, pk) >= 0);
      });
      for (const ref of candidates) {
        for (const row of await this.proto.readChunk(ref)) {
          if (pks.includes(row[schema.primaryKey])) {
            throw new SqlError("PRIMARY_KEY_CONFLICT", `primary key ${JSON.stringify(row[schema.primaryKey])} already exists in "${stmt.table}"`);
          }
          for (const col of uniqueCols) {
            if (row[col] !== null && inserted.some((r) => r[col] === row[col])) {
              throw new SqlError("UNIQUE_CONFLICT", `value ${JSON.stringify(row[col])} already exists in unique column "${stmt.table}.${col}"`);
            }
          }
        }
      }

      const statsCols = { pk: schema.primaryKey, part: schema.partitionColumn };
      const refs: ChunkRef[] = [];
      for (let i = 0; i < inserted.length; i += CHUNK_TARGET_ROWS) {
        refs.push(await this.proto.stageChunk(stmt.table, inserted.slice(i, i + CHUNK_TARGET_ROWS), statsCols));
      }
      return {
        apply: (m) => {
          const t = m.tables[stmt.table];
          if (!t) return null;
          t.chunks.push(...refs);
          return m;
        },
      };
    }, opts);
    return this.returningRows(inserted, stmt.returning, stmt.table);
  }

  private async update(stmt: UpdateStmt, params: Scalar[], opts: ExecOptions): Promise<Row[]> {
    return this.rewrite(stmt.table, stmt.where, opts, stmt.returning, (row, schema) => {
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

  private async delete(stmt: DeleteStmt, params: Scalar[], opts: ExecOptions): Promise<Row[]> {
    return this.rewrite(stmt.table, stmt.where, opts, stmt.returning, () => null, params, "DELETE");
  }

  /** Shared UPDATE/DELETE path: rewrite every chunk containing affected rows. */
  private async rewrite(
    table: string,
    where: Expr | undefined,
    opts: ExecOptions,
    returning: DeleteStmt["returning"],
    transform: (row: Row, schema: TableSchema) => Row | null,
    params: Scalar[],
    verb: string,
  ): Promise<Row[]> {
    if (!where && !opts.allowFullTable) {
      throw new SqlError(
        "MISSING_WHERE",
        `${verb} without a WHERE clause affects every row in "${table}"; pass { allowFullTable: true } if that is intended`,
      );
    }
    let affected: Row[] = [];
    await this.proto.commit(async (snap) => {
      const schema = this.schemaOf(snap.manifest, table);
      const chunks = await this.fetchTable(snap, table, schema, where, table, params);
      affected = [];
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
      };
    }, opts);
    return this.returningRows(affected, returning, table);
  }

  // ---------- DDL ----------

  private async createTable(stmt: Extract<Statement, { kind: "create" }>, opts: ExecOptions): Promise<Row[]> {
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

    await this.proto.commit(async (snap) => {
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
      };
    }, opts);
    return [];
  }

  private async dropTable(table: string, opts: ExecOptions): Promise<Row[]> {
    await this.proto.commit(async (snap) => {
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
      };
    }, opts);
    return [];
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
