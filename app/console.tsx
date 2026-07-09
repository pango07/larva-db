"use client";

import { useState } from "react";
import type { Scalar } from "@larva-db/core";

interface SqlResult {
  rows: Record<string, Scalar>[];
  ms: number;
  stats: { chunksTotal: number; chunksFetched: number };
  version: number;
}

interface SqlErrorBody {
  code: string;
  message: string;
}

const EXAMPLES: { label: string; sql: string }[] = [
  {
    label: "join + filter",
    sql: `SELECT customers.name, orders.total, orders.status\nFROM orders\nINNER JOIN customers ON orders.customerId = customers.id\nWHERE orders.total > 100\nORDER BY orders.total DESC\nLIMIT 10`,
  },
  {
    label: "revenue by customer",
    sql: `SELECT customerId, COUNT(*) AS orders, SUM(total) AS revenue\nFROM orders\nGROUP BY customerId\nORDER BY revenue DESC`,
  },
  {
    label: "pruned date range",
    sql: `SELECT COUNT(*) AS n, SUM(total) AS revenue\nFROM orders\nWHERE createdAt BETWEEN '2026-07-01' AND '2026-07-31'`,
  },
  {
    label: "insert a row",
    sql: `INSERT INTO customers (name, email, city, createdAt)\nVALUES ('Annie Easley', 'annie@example.com', 'Cleveland', '2026-07-08T12:00:00Z')\nRETURNING *`,
  },
  {
    label: "revenue by day",
    sql: `SELECT DATE(createdAt) AS day, SUM(total) AS revenue
FROM orders
GROUP BY DATE(createdAt)
ORDER BY day`,
  },
  {
    label: "HAVING + CASE",
    sql: `SELECT customerId, SUM(total) AS revenue,\n  CASE WHEN SUM(total) > 500 THEN 'vip' ELSE 'standard' END AS tier\nFROM orders\nGROUP BY customerId\nHAVING revenue > 100\nORDER BY revenue DESC`,
  },
  {
    label: "upsert",
    sql: `INSERT INTO customers (name, email, city, createdAt)\nVALUES ('Annie Easley', 'annie@example.com', 'Cleveland', '2026-07-08T12:00:00Z')\nON CONFLICT (email) DO UPDATE SET city = excluded.city\nRETURNING *`,
  },
  {
    label: "an agent-grade error",
    sql: `SELECT name FROM customers\nWHERE id IN (SELECT customerId FROM orders)`,
  },
];

export function Console() {
  const [sql, setSql] = useState(EXAMPLES[0].sql);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<SqlErrorBody | null>(null);
  const [csvTable, setCsvTable] = useState("orders");
  const [resetting, setResetting] = useState(false);

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/sql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql }),
      });
      const body = (await res.json()) as SqlResult | { error: SqlErrorBody };
      if ("error" in body) setError(body.error);
      else setResult(body);
    } catch (err) {
      setError({ code: "NETWORK", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setRunning(false);
    }
  }

  async function reset() {
    setResetting(true);
    try {
      await fetch("/api/demo-reset", { method: "POST" });
      setResult(null);
      setError(null);
    } finally {
      setResetting(false);
    }
  }

  const columns = result && result.rows.length > 0 ? Object.keys(result.rows[0]) : [];

  return (
    <section className="border-hairline bg-surface rounded-xl border p-5">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium">SQL console</h2>
          <p className="text-ink-muted mt-1 text-xs">
            a seeded demo database (customers, orders) living entirely in Blob storage — full v1
            dialect, honest errors
          </p>
        </div>
        <button
          onClick={reset}
          disabled={resetting}
          className="text-ink-muted hover:text-foreground text-xs underline underline-offset-2 disabled:opacity-40"
        >
          {resetting ? "resetting…" : "reset demo data"}
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex.label}
            onClick={() => setSql(ex.sql)}
            className="border-hairline text-ink-secondary hover:text-foreground rounded-full border px-3 py-1 text-xs"
          >
            {ex.label}
          </button>
        ))}
      </div>

      <textarea
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run();
        }}
        spellCheck={false}
        rows={6}
        className="border-hairline bg-background mt-3 w-full resize-y rounded-md border p-3 font-mono text-sm"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          onClick={run}
          disabled={running}
          className="bg-foreground text-background h-9 rounded-md px-5 text-sm font-medium transition-opacity hover:opacity-85 disabled:opacity-40"
        >
          {running ? "Running…" : "Run (⌘↵)"}
        </button>
        {result && (
          <span className="text-ink-muted text-xs tabular-nums">
            {result.rows.length} row{result.rows.length === 1 ? "" : "s"} · {result.ms} ms · read{" "}
            {result.stats.chunksFetched}/{result.stats.chunksTotal} chunks · db v{result.version}
          </span>
        )}
        <span className="grow" />
        <a
          href="/api/export?format=postgres"
          title="pg_dump-shaped .sql — load with: psql $DATABASE_URL < larva-demo.sql"
          className="border-hairline text-ink-secondary hover:text-foreground rounded-md border px-3 py-1.5 text-xs"
        >
          Export Postgres
        </a>
        <a
          href="/api/export?format=json"
          className="border-hairline text-ink-secondary hover:text-foreground rounded-md border px-3 py-1.5 text-xs"
        >
          Export JSON
        </a>
        <span className="flex items-center gap-1">
          <a
            href={`/api/export?format=csv&table=${csvTable}`}
            className="border-hairline text-ink-secondary hover:text-foreground rounded-md border px-3 py-1.5 text-xs"
          >
            Export CSV
          </a>
          <select
            value={csvTable}
            onChange={(e) => setCsvTable(e.target.value)}
            className="border-hairline bg-background h-7 rounded-md border px-1 text-xs"
          >
            <option value="customers">customers</option>
            <option value="orders">orders</option>
          </select>
        </span>
      </div>

      {error && (
        <div className="border-critical/40 mt-4 rounded-md border p-3">
          <p className="text-sm">
            <code className="text-critical bg-critical/10 rounded px-1.5 py-0.5 font-mono text-xs">
              {error.code}
            </code>
            <span className="text-ink-secondary ml-2">{error.message}</span>
          </p>
        </div>
      )}

      {result && result.rows.length > 0 && (
        <div className="border-hairline mt-4 max-h-80 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-background sticky top-0">
              <tr className="text-ink-muted border-hairline border-b text-left text-xs">
                {columns.map((c) => (
                  <th key={c} className="px-3 py-2 font-medium whitespace-nowrap">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {result.rows.map((row, i) => (
                <tr key={i} className="border-hairline border-b last:border-0">
                  {columns.map((c) => (
                    <td key={c} className="px-3 py-1.5 whitespace-nowrap">
                      {row[c] === null ? (
                        <span className="text-ink-muted">∅</span>
                      ) : (
                        String(row[c])
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result && result.rows.length === 0 && (
        <p className="text-ink-muted mt-4 text-sm">statement ran; no rows returned</p>
      )}
    </section>
  );
}
