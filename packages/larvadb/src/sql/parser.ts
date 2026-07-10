import {
  AggFunc,
  CastType,
  ColumnRef,
  CompareOp,
  Expr,
  hasAggregate,
  OnConflict,
  ScalarFunc,
  SelectItem,
  SelectStmt,
  Statement,
  TableRef,
} from "./ast";
import { SqlError, unsupported } from "./errors";
import { Token, tokenize } from "./lexer";

const AGG_FUNCS = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX", "GROUP_CONCAT"]);
/** name → [min arity, max arity] */
const SCALAR_FUNCS: Record<string, [number, number]> = {
  UPPER: [1, 1],
  LOWER: [1, 1],
  LENGTH: [1, 1],
  TRIM: [1, 1],
  ABS: [1, 1],
  ROUND: [1, 2],
  SUBSTR: [2, 3],
  COALESCE: [2, Infinity],
  DATE: [1, 1],
  STRFTIME: [2, 2],
  NOW: [0, 0],
  NULLIF: [2, 2],
  IFNULL: [2, 2],
  REPLACE: [3, 3],
  CEIL: [1, 1],
  FLOOR: [1, 1],
  MOD: [2, 2],
  JSON_EXTRACT: [2, 2],
};
const FUNC_LIST =
  "aggregates COUNT, SUM, AVG, MIN, MAX, GROUP_CONCAT and scalar functions UPPER, LOWER, LENGTH, TRIM, ROUND, ABS, COALESCE, SUBSTR, DATE, STRFTIME, NOW, NULLIF, IFNULL, REPLACE, CEIL, FLOOR, MOD, JSON_EXTRACT, CAST";
/** Near-miss names agents emit, mapped to the supported spelling. */
const FUNC_HINTS: Record<string, string> = {
  CONCAT: "use the || operator instead",
  SUBSTRING: "use SUBSTR(text, start, length)",
  CEILING: "use CEIL",
  TO_CHAR: "use STRFTIME(format, timestamp)",
  DATE_TRUNC: "use DATE(x) for days or STRFTIME('%Y-%m', x) for months",
  DATETIME: "timestamps are ISO 8601 text; compare them directly or slice with DATE(x)",
  JSON_EXTRACT_PATH_TEXT: "use JSON_EXTRACT(column, '$.path') or the ->> operator",
};

/**
 * Hand-written recursive-descent / Pratt parser for the Larva dialect
 * (Design §7). Chosen over an off-the-shelf parser for error-message quality:
 * every deliberate exclusion is rejected by name with a suggested alternative.
 */
export function parse(sql: string): Statement {
  return new Parser(sql).parseStatement();
}

class Parser {
  private tokens: Token[];
  private i = 0;
  private paramCount = 0;
  private aggDepth = 0;

  constructor(private sql: string) {
    this.tokens = tokenize(sql);
  }

  // --- token plumbing ---
  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)];
  }
  private next(): Token {
    return this.tokens[this.i++];
  }
  private at(type: Token["type"], text?: string): boolean {
    const t = this.peek();
    return t.type === type && (text === undefined || t.text === text);
  }
  private eat(type: Token["type"], text?: string): boolean {
    if (this.at(type, text)) {
      this.i++;
      return true;
    }
    return false;
  }
  private expect(type: Token["type"], text?: string): Token {
    if (!this.at(type, text)) {
      const t = this.peek();
      throw this.err(`expected ${text ?? type}, found ${t.type === "eof" ? "end of statement" : `"${t.text}"`}`);
    }
    return this.next();
  }
  private err(msg: string): SqlError {
    const pos = this.peek().pos;
    return new SqlError(
      "PARSE_ERROR",
      `${msg} at position ${pos}: …${this.sql.slice(Math.max(0, pos - 20), pos + 20)}…`,
    );
  }

  // --- entry ---
  parseStatement(): Statement {
    const t = this.peek();
    if (t.type !== "keyword") throw this.err("expected a SQL statement");
    for (const feature of ["UNION", "INTERSECT", "EXCEPT", "ALTER"]) {
      if (t.text === feature) throw unsupported(feature);
    }

    let stmt: Statement;
    switch (t.text) {
      case "SELECT":
        stmt = this.select();
        break;
      case "INSERT":
        stmt = this.insert();
        break;
      case "UPDATE":
        stmt = this.update();
        break;
      case "DELETE":
        stmt = this.delete();
        break;
      case "CREATE":
        stmt = this.create();
        break;
      case "DROP":
        stmt = this.drop();
        break;
      default:
        throw this.err(`unexpected keyword "${t.text}"`);
    }

    this.eat("punct", ";");
    if (!this.at("eof")) {
      throw new SqlError(
        "MULTIPLE_STATEMENTS",
        "only one statement per query string is allowed (this also closes the classic '; DROP TABLE' injection vector); use db.transaction for multi-statement changes",
      );
    }
    return stmt;
  }

  // --- statements ---
  private select(): SelectStmt {
    this.expect("keyword", "SELECT");
    const distinct = this.eat("keyword", "DISTINCT");

    let items: SelectItem[] | null = null;
    if (!this.eat("punct", "*")) {
      items = [this.selectItem()];
      while (this.eat("punct", ",")) items.push(this.selectItem());
    }

    this.expect("keyword", "FROM");
    this.rejectSubquery("FROM");
    const from = this.tableRef();
    const stmt: SelectStmt = { kind: "select", items, distinct, from };

    // joins
    const joinKeyword = this.peek();
    if (joinKeyword.type === "keyword" && ["RIGHT", "FULL", "CROSS"].includes(joinKeyword.text)) {
      throw new SqlError(
        "UNSUPPORTED_FEATURE",
        `${joinKeyword.text} JOIN is not supported in Larva v1; only INNER JOIN and LEFT JOIN are available`,
      );
    }
    if (this.at("keyword", "INNER") || this.at("keyword", "LEFT") || this.at("keyword", "JOIN")) {
      const type = this.eat("keyword", "LEFT") ? "left" : (this.eat("keyword", "INNER"), "inner" as const);
      this.eat("keyword", "OUTER");
      this.expect("keyword", "JOIN");
      this.rejectSubquery("JOIN");
      const table = this.tableRef();
      if (table.table === from.table) {
        throw new SqlError("UNSUPPORTED_FEATURE", "self-joins are not supported in Larva v1; fetch the table once and join in application code");
      }
      this.expect("keyword", "ON");
      const leftCol = this.columnRef();
      this.expect("op", "=");
      const rightCol = this.columnRef();
      stmt.join = { type, table, leftCol, rightCol };

      if (this.at("keyword", "INNER") || this.at("keyword", "LEFT") || this.at("keyword", "JOIN")) {
        throw new SqlError("UNSUPPORTED_FEATURE", "queries may join at most two tables in Larva v1; join the third table in application code");
      }
    }

    if (this.eat("keyword", "WHERE")) {
      stmt.where = this.expr();
      if (hasAggregate(stmt.where)) {
        throw new SqlError("AGGREGATE_IN_WHERE", "aggregate functions are not allowed in WHERE (it filters individual rows); use HAVING after GROUP BY");
      }
    }

    if (this.eat("keyword", "GROUP")) {
      this.expect("keyword", "BY");
      stmt.groupBy = [this.expr()];
      while (this.eat("punct", ",")) stmt.groupBy.push(this.expr());
      if (stmt.groupBy.some(hasAggregate)) {
        throw new SqlError("AGGREGATE_MISPLACED", "aggregate functions are not allowed in GROUP BY; group by the raw expression and aggregate in the SELECT list");
      }
    }
    if (this.eat("keyword", "HAVING")) stmt.having = this.expr();

    if (this.eat("keyword", "ORDER")) {
      this.expect("keyword", "BY");
      stmt.orderBy = [];
      do {
        const column = this.columnRef();
        const desc = this.eat("keyword", "DESC") || (this.eat("keyword", "ASC"), false);
        stmt.orderBy.push({ column, desc });
      } while (this.eat("punct", ","));
    }

    if (this.eat("keyword", "LIMIT")) stmt.limit = this.primary();
    if (this.eat("keyword", "OFFSET")) stmt.offset = this.primary();
    if (this.at("keyword", "UNION")) throw unsupported("UNION");
    return stmt;
  }

  private insert(): Statement {
    this.expect("keyword", "INSERT");
    this.expect("keyword", "INTO");
    const table = this.ident("table name");
    this.expect("punct", "(");
    const columns = [this.ident("column name")];
    while (this.eat("punct", ",")) columns.push(this.ident("column name"));
    this.expect("punct", ")");
    this.expect("keyword", "VALUES");

    const rows: Expr[][] = [];
    do {
      this.expect("punct", "(");
      const row = [this.additive()];
      while (this.eat("punct", ",")) row.push(this.additive());
      this.expect("punct", ")");
      if (row.length !== columns.length) {
        throw new SqlError(
          "VALUE_COUNT_MISMATCH",
          `INSERT lists ${columns.length} columns but a VALUES row has ${row.length} values`,
        );
      }
      rows.push(row);
    } while (this.eat("punct", ","));

    return { kind: "insert", table, columns, rows, onConflict: this.onConflict(), returning: this.returning() };
  }

  private onConflict(): OnConflict | undefined {
    if (!this.eat("keyword", "ON")) return undefined;
    this.expect("keyword", "CONFLICT");
    let columns: string[] | undefined;
    if (this.eat("punct", "(")) {
      columns = [this.ident("conflict target column")];
      while (this.eat("punct", ",")) columns.push(this.ident("conflict target column"));
      this.expect("punct", ")");
    }
    this.expect("keyword", "DO");
    if (this.eat("keyword", "NOTHING")) return { columns, action: "nothing" };

    this.expect("keyword", "UPDATE");
    if (columns === undefined) {
      throw new SqlError(
        "PARSE_ERROR",
        "ON CONFLICT DO UPDATE requires a conflict target, e.g. ON CONFLICT (id) DO UPDATE SET …",
      );
    }
    this.expect("keyword", "SET");
    const set: { column: string; value: Expr }[] = [];
    do {
      const col = this.ident("column name");
      this.expect("op", "=");
      set.push({ column: col, value: this.additive() });
    } while (this.eat("punct", ","));
    if (this.at("keyword", "WHERE")) {
      throw new SqlError(
        "UNSUPPORTED_FEATURE",
        "a WHERE clause on ON CONFLICT DO UPDATE is not supported; the update applies to every conflicting row",
      );
    }
    return { columns, action: { set } };
  }

  private update(): Statement {
    this.expect("keyword", "UPDATE");
    const table = this.ident("table name");
    this.expect("keyword", "SET");
    const set: { column: string; value: Expr }[] = [];
    do {
      const column = this.ident("column name");
      this.expect("op", "=");
      set.push({ column, value: this.additive() });
    } while (this.eat("punct", ","));
    const where = this.eat("keyword", "WHERE") ? this.expr() : undefined;
    return { kind: "update", table, set, where, returning: this.returning() };
  }

  private delete(): Statement {
    this.expect("keyword", "DELETE");
    this.expect("keyword", "FROM");
    const table = this.ident("table name");
    const where = this.eat("keyword", "WHERE") ? this.expr() : undefined;
    return { kind: "delete", table, where, returning: this.returning() };
  }

  private create(): Statement {
    this.expect("keyword", "CREATE");
    for (const feature of ["VIEW", "TRIGGER", "INDEX", "UNIQUE"]) {
      if (this.at("keyword", feature)) throw unsupported(feature === "UNIQUE" ? "INDEX" : feature);
    }
    this.expect("keyword", "TABLE");
    const table = this.ident("table name");
    this.expect("punct", "(");
    const columns: { name: string; type: string; primaryKey: boolean; unique: boolean }[] = [];
    do {
      const name = this.ident("column name");
      const type = this.ident("column type").toLowerCase();
      let primaryKey = false;
      let unique = false;
      for (;;) {
        if (this.eat("keyword", "PRIMARY")) {
          this.expect("keyword", "KEY");
          primaryKey = true;
        } else if (this.eat("keyword", "UNIQUE")) {
          unique = true;
        } else if (this.eat("keyword", "REFERENCES")) {
          this.ident("referenced table");
          if (this.eat("punct", "(")) {
            this.ident("referenced column");
            this.expect("punct", ")");
          }
        } else break;
      }
      columns.push({ name, type, primaryKey, unique });
    } while (this.eat("punct", ","));
    this.expect("punct", ")");
    return { kind: "create", table, columns };
  }

  private drop(): Statement {
    this.expect("keyword", "DROP");
    for (const feature of ["VIEW", "TRIGGER", "INDEX"]) {
      if (this.at("keyword", feature)) throw unsupported(feature);
    }
    this.expect("keyword", "TABLE");
    return { kind: "drop", table: this.ident("table name") };
  }

  private returning(): SelectItem[] | null | undefined {
    if (!this.eat("keyword", "RETURNING")) return undefined;
    if (this.eat("punct", "*")) return null;
    const items = [this.selectItem()];
    while (this.eat("punct", ",")) items.push(this.selectItem());
    return items;
  }

  // --- pieces ---
  private ident(what: string): string {
    if (this.at("ident")) return this.next().text;
    throw this.err(`expected ${what}`);
  }

  private tableRef(): TableRef {
    const table = this.ident("table name");
    const alias = this.eat("keyword", "AS") ? this.ident("alias") : this.at("ident") ? this.next().text : undefined;
    return { table, alias };
  }

  private columnRef(): ColumnRef {
    const first = this.ident("column name");
    if (this.eat("punct", ".")) return { kind: "column", table: first, name: this.ident("column name") };
    return { kind: "column", name: first };
  }

  private selectItem(): SelectItem {
    const expr = this.expr();
    const alias = this.eat("keyword", "AS") ? this.ident("alias") : undefined;
    return { expr, alias };
  }

  private rejectSubquery(where: string): void {
    if (this.at("punct", "(") && this.peek(1).type === "keyword" && this.peek(1).text === "SELECT") {
      throw new SqlError(
        "UNSUPPORTED_FEATURE",
        `subqueries are not supported in Larva v1 (found one in ${where}); run the inner query first and interpolate its result`,
      );
    }
  }

  // --- expressions (Pratt: OR < AND < NOT < comparison < additive/|| < multiplicative < primary) ---
  private expr(): Expr {
    return this.orExpr();
  }

  private orExpr(): Expr {
    let left = this.andExpr();
    while (this.eat("keyword", "OR")) left = { kind: "binary", op: "OR", left, right: this.andExpr() };
    return left;
  }

  private andExpr(): Expr {
    let left = this.notExpr();
    while (this.eat("keyword", "AND")) left = { kind: "binary", op: "AND", left, right: this.notExpr() };
    return left;
  }

  private notExpr(): Expr {
    if (this.eat("keyword", "NOT")) return { kind: "not", expr: this.notExpr() };
    return this.comparison();
  }

  private comparison(): Expr {
    const left = this.additive();
    const negated = this.eat("keyword", "NOT");

    if (this.eat("keyword", "IN")) {
      this.rejectSubquery("IN");
      this.expect("punct", "(");
      const list = [this.additive()];
      while (this.eat("punct", ",")) list.push(this.additive());
      this.expect("punct", ")");
      return { kind: "in", expr: left, list, negated };
    }
    if (this.eat("keyword", "BETWEEN")) {
      const lo = this.additive();
      this.expect("keyword", "AND");
      return { kind: "between", expr: left, lo, hi: this.additive(), negated };
    }
    if (this.eat("keyword", "LIKE")) {
      return { kind: "like", expr: left, pattern: this.additive(), negated };
    }
    if (negated) throw this.err("expected IN, BETWEEN, or LIKE after NOT");

    if (this.eat("keyword", "IS")) {
      const neg = this.eat("keyword", "NOT");
      this.expect("keyword", "NULL");
      return { kind: "isnull", expr: left, negated: neg };
    }
    if (this.at("op") && ["=", "!=", "<", ">", "<=", ">="].includes(this.peek().text)) {
      const op = this.next().text as CompareOp;
      return { kind: "binary", op, left, right: this.additive() };
    }
    return left;
  }

  private additive(): Expr {
    let left = this.multiplicative();
    while (this.at("op") && ["+", "-", "||", "->>"].includes(this.peek().text)) {
      const op = this.next().text as "+" | "-" | "||" | "->>";
      left = { kind: "binary", op, left, right: this.multiplicative() };
    }
    return left;
  }

  private multiplicative(): Expr {
    let left = this.primary();
    while (this.at("punct", "*") || (this.at("op") && this.peek().text === "/")) {
      const op = this.next().text as "*" | "/";
      left = { kind: "binary", op, left, right: this.primary() };
    }
    return left;
  }

  private primary(): Expr {
    if (this.eat("punct", "(")) {
      this.rejectSubquery("an expression");
      const inner = this.expr();
      this.expect("punct", ")");
      return inner;
    }
    if (this.eat("keyword", "CASE")) return this.caseExpr();
    if (this.at("param")) {
      this.next();
      return { kind: "param", index: this.paramCount++ };
    }
    if (this.at("number")) return { kind: "literal", value: Number(this.next().text) };
    if (this.at("string")) return { kind: "literal", value: this.next().text };
    if (this.eat("keyword", "NULL")) return { kind: "literal", value: null };
    if (this.eat("keyword", "CURRENT_TIMESTAMP")) return { kind: "func", name: "NOW", args: [] };
    if (this.eat("keyword", "TRUE")) return { kind: "literal", value: true };
    if (this.eat("keyword", "FALSE")) return { kind: "literal", value: false };
    if (this.at("punct", "-") || (this.at("op") && this.peek().text === "-")) {
      throw this.err("negative literals: write the sign inside the number, e.g. -5 as a parameter");
    }
    if (this.at("ident") && this.peek(1).type === "punct" && this.peek(1).text === "(") {
      return this.functionCall();
    }
    if (this.at("ident")) return this.columnRef();
    if (this.at("keyword", "SELECT")) {
      throw new SqlError("UNSUPPORTED_FEATURE", "subqueries are not supported in Larva v1; run the inner query first and interpolate its result");
    }
    throw this.err("expected a value, column, or parenthesized expression");
  }

  private functionCall(): Expr {
    const func = this.next().text.toUpperCase();
    this.expect("punct", "(");

    if (func === "CAST") return this.castExpr();

    if (AGG_FUNCS.has(func)) {
      if (this.aggDepth > 0) {
        throw new SqlError(
          "UNSUPPORTED_FEATURE",
          `aggregates cannot be nested (found ${func} inside another aggregate); compute the inner aggregate in a separate query`,
        );
      }
      const distinct = this.eat("keyword", "DISTINCT");
      let arg: Expr | null = null;
      if (this.eat("punct", "*")) {
        if (func !== "COUNT") throw this.err(`${func}(*) is not valid; ${func} needs a column or expression`);
        if (distinct) throw this.err("COUNT(DISTINCT *) is not valid; name a column");
      } else {
        this.aggDepth++;
        arg = this.expr();
        this.aggDepth--;
      }
      let sep: Expr | undefined;
      if (this.eat("punct", ",")) {
        if (func !== "GROUP_CONCAT") throw this.err(`${func} takes a single argument (only GROUP_CONCAT accepts a separator)`);
        sep = this.additive();
      }
      this.expect("punct", ")");
      if (this.at("keyword", "OVER")) throw unsupported("OVER");
      return { kind: "aggregate", func: func as AggFunc, arg, distinct, sep };
    }

    const arity = SCALAR_FUNCS[func];
    if (arity) {
      const args: Expr[] = [];
      if (!this.at("punct", ")")) {
        do {
          args.push(this.expr());
        } while (this.eat("punct", ","));
      }
      this.expect("punct", ")");
      const [min, max] = arity;
      if (args.length < min || args.length > max) {
        const want = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min} to ${max}`;
        throw new SqlError("WRONG_ARGUMENT_COUNT", `${func} takes ${want} argument${min === 1 && max === 1 ? "" : "s"}, got ${args.length}`);
      }
      return { kind: "func", name: func as ScalarFunc, args };
    }

    const hint = FUNC_HINTS[func];
    throw new SqlError("UNKNOWN_FUNCTION", `function "${func}" is not available; ${hint ?? `Larva supports ${FUNC_LIST}`}`);
  }

  /** CAST(expr AS type) — the opening paren is already consumed. */
  private castExpr(): Expr {
    const expr = this.expr();
    this.expect("keyword", "AS");
    const raw = this.ident("type name").toLowerCase();
    const TYPES: Record<string, CastType> = {
      text: "text", varchar: "text", timestamp: "text", datetime: "text",
      integer: "integer", int: "integer",
      real: "real", float: "real", double: "real",
      boolean: "boolean", bool: "boolean",
    };
    const to = TYPES[raw];
    if (!to) throw new SqlError("UNKNOWN_TYPE", `CAST target "${raw}" is not available; use text, integer, real, or boolean`);
    this.expect("punct", ")");
    return { kind: "cast", expr, to };
  }

  private caseExpr(): Expr {
    // Simple CASE (CASE x WHEN v THEN …) desugars to searched CASE (WHEN x = v THEN …).
    const operand = this.at("keyword", "WHEN") ? undefined : this.expr();
    const branches: { when: Expr; then: Expr }[] = [];
    while (this.eat("keyword", "WHEN")) {
      let when = this.expr();
      this.expect("keyword", "THEN");
      if (operand) when = { kind: "binary", op: "=", left: operand, right: when };
      branches.push({ when, then: this.expr() });
    }
    if (branches.length === 0) throw this.err("CASE requires at least one WHEN … THEN branch");
    const els = this.eat("keyword", "ELSE") ? this.expr() : undefined;
    this.expect("keyword", "END");
    return { kind: "case", branches, else: els };
  }
}
