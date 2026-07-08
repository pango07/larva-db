import { SqlError } from "./errors";

export type TokenType = "keyword" | "ident" | "number" | "string" | "op" | "punct" | "param" | "eof";

export interface Token {
  type: TokenType;
  /** Keywords are uppercased; identifiers keep their case. */
  text: string;
  pos: number;
}

const KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "BETWEEN", "LIKE", "IS", "NULL",
  "ORDER", "BY", "ASC", "DESC", "LIMIT", "OFFSET", "GROUP", "INNER", "LEFT", "RIGHT",
  "FULL", "OUTER", "CROSS", "JOIN", "ON", "AS", "INSERT", "INTO", "VALUES", "RETURNING",
  "UPDATE", "SET", "DELETE", "CREATE", "DROP", "TABLE", "PRIMARY", "KEY", "UNIQUE",
  "REFERENCES", "TRUE", "FALSE", "HAVING", "UNION", "INTERSECT", "EXCEPT", "OVER",
  "ALTER", "VIEW", "TRIGGER", "INDEX", "DISTINCT",
]);

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const err = (msg: string) =>
    new SqlError("PARSE_ERROR", `${msg} at position ${i}: …${sql.slice(Math.max(0, i - 15), i + 15)}…`);

  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "'") {
      const start = i++;
      let value = "";
      for (;;) {
        if (i >= sql.length) throw err("unterminated string literal");
        if (sql[i] === "'" && sql[i + 1] === "'") {
          value += "'";
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          value += sql[i++];
        }
      }
      tokens.push({ type: "string", text: value, pos: start });
    } else if (
      /[0-9]/.test(c) ||
      (c === "." && /[0-9]/.test(sql[i + 1] ?? "")) ||
      (c === "-" && /[0-9.]/.test(sql[i + 1] ?? ""))
    ) {
      const start = i;
      if (c === "-") i++;
      while (i < sql.length && /[0-9.eE+-]/.test(sql[i])) {
        // stop signs like `1+1`: only consume +/- right after an exponent marker
        if ((sql[i] === "+" || sql[i] === "-") && !/[eE]/.test(sql[i - 1])) break;
        i++;
      }
      const text = sql.slice(start, i);
      if (Number.isNaN(Number(text))) throw err(`invalid number "${text}"`);
      tokens.push({ type: "number", text, pos: start });
    } else if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i++;
      const word = sql.slice(start, i);
      const upper = word.toUpperCase();
      tokens.push(
        KEYWORDS.has(upper)
          ? { type: "keyword", text: upper, pos: start }
          : { type: "ident", text: word, pos: start },
      );
    } else if (c === "?") {
      tokens.push({ type: "param", text: "?", pos: i++ });
    } else if (c === "!" && sql[i + 1] === "=") {
      tokens.push({ type: "op", text: "!=", pos: i });
      i += 2;
    } else if (c === "<" && sql[i + 1] === ">") {
      tokens.push({ type: "op", text: "!=", pos: i });
      i += 2;
    } else if ((c === "<" || c === ">") && sql[i + 1] === "=") {
      tokens.push({ type: "op", text: `${c}=`, pos: i });
      i += 2;
    } else if (c === "=" || c === "<" || c === ">" || c === "+" || c === "-" || c === "/") {
      tokens.push({ type: "op", text: c, pos: i++ });
    } else if ("(),.;*".includes(c)) {
      tokens.push({ type: "punct", text: c, pos: i++ });
    } else {
      throw err(`unexpected character "${c}"`);
    }
  }
  tokens.push({ type: "eof", text: "", pos: i });
  return tokens;
}
