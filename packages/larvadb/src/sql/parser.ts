import {
  Aggregate,
  ColumnRef,
  CompareOp,
  Expr,
  SelectItem,
  SelectStmt,
  Statement,
  TableRef,
} from "./ast";
import { SqlError, unsupported } from "./errors";
import { Token, tokenize } from "./lexer";

const AGG_FUNCS = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX"]);

/**
 * Hand-written recursive-descent / Pratt parser for the Larva v1 dialect
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
    for (const feature of ["HAVING", "UNION", "INTERSECT", "EXCEPT", "ALTER"]) {
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
    if (this.eat("keyword", "DISTINCT")) {
      throw new SqlError("UNSUPPORTED_FEATURE", "SELECT DISTINCT is not supported in Larva v1; deduplicate in application code");
    }

    let items: SelectItem[] | null = null;
    if (!this.eat("punct", "*")) {
      items = [this.selectItem()];
      while (this.eat("punct", ",")) items.push(this.selectItem());
    }

    this.expect("keyword", "FROM");
    this.rejectSubquery("FROM");
    const from = this.tableRef();
    const stmt: SelectStmt = { kind: "select", items, from };

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

    if (this.eat("keyword", "WHERE")) stmt.where = this.expr();

    if (this.eat("keyword", "GROUP")) {
      this.expect("keyword", "BY");
      stmt.groupBy = [this.columnRef()];
      while (this.eat("punct", ",")) stmt.groupBy.push(this.columnRef());
    }
    if (this.at("keyword", "HAVING")) throw unsupported("HAVING");

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

    return { kind: "insert", table, columns, rows, returning: this.returning() };
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
    let expr: ColumnRef | Aggregate;
    if (this.at("ident") && this.peek(1).type === "punct" && this.peek(1).text === "(") {
      const func = this.next().text.toUpperCase();
      if (!AGG_FUNCS.has(func)) {
        throw new SqlError(
          "UNKNOWN_FUNCTION",
          `function "${func}" is not available; Larva v1 supports COUNT, SUM, AVG, MIN, MAX`,
        );
      }
      this.expect("punct", "(");
      const arg = this.eat("punct", "*") ? null : this.columnRef();
      this.expect("punct", ")");
      if (this.at("keyword", "OVER")) throw unsupported("OVER");
      expr = { kind: "aggregate", func: func as Aggregate["func"], arg };
    } else {
      expr = this.columnRef();
    }
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

  // --- expressions (Pratt: OR < AND < NOT < comparison) ---
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
    while (this.at("op") && (this.peek().text === "+" || this.peek().text === "-")) {
      const op = this.next().text as "+" | "-";
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
    if (this.at("param")) {
      this.next();
      return { kind: "param", index: this.paramCount++ };
    }
    if (this.at("number")) return { kind: "literal", value: Number(this.next().text) };
    if (this.at("string")) return { kind: "literal", value: this.next().text };
    if (this.eat("keyword", "NULL")) return { kind: "literal", value: null };
    if (this.eat("keyword", "TRUE")) return { kind: "literal", value: true };
    if (this.eat("keyword", "FALSE")) return { kind: "literal", value: false };
    if (this.at("punct", "-") || (this.at("op") && this.peek().text === "-")) {
      throw this.err("negative literals: write the sign inside the number, e.g. -5 as a parameter");
    }
    if (this.at("ident")) return this.columnRef();
    if (this.at("keyword", "SELECT")) {
      throw new SqlError("UNSUPPORTED_FEATURE", "subqueries are not supported in Larva v1; run the inner query first and interpolate its result");
    }
    throw this.err("expected a value, column, or parenthesized expression");
  }
}
