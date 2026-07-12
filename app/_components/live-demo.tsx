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
    sql: `SELECT customers.name, orders.total, orders.status\nFROM orders\nINNER JOIN customers ON orders.customerId = customers.id\nWHERE orders.total > 100\nORDER BY orders.total DESC\nLIMIT 5`,
  },
  {
    label: "revenue by day",
    sql: `SELECT DATE(createdAt) AS day, SUM(total) AS revenue\nFROM orders\nGROUP BY DATE(createdAt)\nORDER BY day`,
  },
  {
    label: "insert + RETURNING",
    sql: `INSERT INTO customers (name, email, city, createdAt)\nVALUES ('Annie Easley', 'annie@example.com', 'Cleveland', '2026-07-08T12:00:00Z')\nRETURNING *`,
  },
  {
    label: "pruned date range",
    sql: `SELECT COUNT(*) AS n, SUM(total) AS revenue\nFROM orders\nWHERE createdAt BETWEEN '2026-07-01' AND '2026-07-31'`,
  },
  {
    label: "an agent-grade error",
    sql: `SELECT name, RANK() OVER (ORDER BY total) FROM orders`,
  },
];

export function LiveDemo() {
  const [sql, setSql] = useState(EXAMPLES[0].sql);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<SqlErrorBody | null>(null);

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

  const columns = result && result.rows.length > 0 ? Object.keys(result.rows[0]) : [];

  return (
    <div className="border-hairline bg-surface overflow-hidden rounded-2xl border shadow-2xl shadow-black/40">
      {/* window chrome */}
      <div className="border-hairline flex items-center gap-2 border-b px-4 py-3">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
        <span className="text-ink-muted ml-3 font-mono text-xs">
          query.sql — a live database in Vercel Blob
        </span>
      </div>

      <div className="p-4">
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              onClick={() => {
                setSql(ex.sql);
                setResult(null);
                setError(null);
              }}
              className="border-hairline text-ink-secondary hover:border-accent/60 hover:text-foreground rounded-full border px-3 py-1 text-xs transition-colors"
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
          className="border-hairline bg-background focus:border-accent/50 mt-3 w-full resize-y rounded-lg border p-3 font-mono text-sm outline-none"
        />

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            onClick={run}
            disabled={running}
            className="bg-accent text-accent-ink h-9 rounded-lg px-5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {running ? "Running…" : "Run it (⌘↵)"}
          </button>
          {result && (
            <span className="text-ink-muted text-xs tabular-nums">
              {result.rows.length} row{result.rows.length === 1 ? "" : "s"} · {result.ms} ms · read{" "}
              {result.stats.chunksFetched}/{result.stats.chunksTotal} chunks · db v{result.version}
            </span>
          )}
        </div>

        {error && (
          <div className="border-critical/40 mt-4 rounded-lg border p-3 text-left">
            <p className="text-sm">
              <code className="text-critical bg-critical/10 rounded px-1.5 py-0.5 font-mono text-xs">
                {error.code}
              </code>
              <span className="text-ink-secondary ml-2">{error.message}</span>
            </p>
          </div>
        )}

        {result && result.rows.length > 0 && (
          <div className="border-hairline mt-4 max-h-64 overflow-auto rounded-lg border text-left">
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
          <p className="text-ink-muted mt-4 text-left text-sm">statement ran; no rows returned</p>
        )}
      </div>
    </div>
  );
}
