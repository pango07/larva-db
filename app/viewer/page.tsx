"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Scalar } from "@larva-db/core";

interface ChunkView {
  id: string;
  rows: number;
  pk: { min: Scalar; max: Scalar } | null;
  partition: { min: Scalar; max: Scalar | null } | null;
}
interface TableView {
  rowCount: number;
  chunkCount: number;
  chunks: ChunkView[];
}
interface Inspection {
  version: number;
  committedAt: string;
  formatVersion: number;
  isCurrent: boolean;
  currentVersion: number;
  tables: Record<string, TableView>;
}
interface RowsResponse {
  table: string;
  columns: string[];
  primaryKey: string;
  partitionColumn: string | null;
  types: Record<string, string>;
  rows: Record<string, Scalar>[];
  total: number;
  limit: number;
  offset: number;
  orderBy: string;
  dir: "asc" | "desc";
  version: number;
  isCurrent: boolean;
  stats: { chunksTotal: number; chunksFetched: number };
}
interface ErrBody {
  code: string;
  message: string;
}

const PAGE = 50;

export default function Viewer() {
  const [layout, setLayout] = useState<Inspection | null>(null);
  const [head, setHead] = useState<number | null>(null); // live current version
  const [version, setVersion] = useState<number | null>(null); // committed selection
  const [scrub, setScrub] = useState<number | null>(null); // live slider position
  const [table, setTable] = useState<string | null>(null);
  const [data, setData] = useState<RowsResponse | null>(null);
  const [offset, setOffset] = useState(0);
  const [orderBy, setOrderBy] = useState<string | null>(null);
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [error, setError] = useState<ErrBody | null>(null);
  const [loadingRows, setLoadingRows] = useState(false);

  // --- inspect: layout for the selected version (and, on first load, the head) ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/inspect${version === null ? "" : `?version=${version}`}`);
      const body = (await res.json()) as Inspection | { error: ErrBody };
      if (cancelled) return;
      if ("error" in body) {
        setError(body.error);
        return;
      }
      setError(null);
      setLayout(body);
      setHead(body.currentVersion);
      setVersion((v) => (v === null ? body.version : v));
      setScrub((s) => (s === null ? body.version : s));
      setTable((t) => (t === null ? Object.keys(body.tables)[0] ?? null : t));
    })();
    return () => {
      cancelled = true;
    };
  }, [version]);

  // --- rows: a page of the selected table at the selected version ---
  useEffect(() => {
    if (table === null || version === null) return;
    let cancelled = false;
    (async () => {
      setLoadingRows(true);
      const params = new URLSearchParams({ table, version: String(version), limit: String(PAGE), offset: String(offset) });
      if (orderBy) params.set("orderBy", orderBy);
      params.set("dir", dir);
      try {
        const res = await fetch(`/api/viewer-rows?${params}`);
        const body = (await res.json()) as RowsResponse | { error: ErrBody };
        if (cancelled) return;
        if ("error" in body) {
          setError(body.error);
          setData(null);
        } else {
          setError(null);
          setData(body);
        }
      } finally {
        if (!cancelled) setLoadingRows(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [table, version, offset, orderBy, dir]);

  const commitScrub = () => {
    if (scrub !== null && scrub !== version) {
      setVersion(scrub);
      setOffset(0);
    }
  };
  const toLive = () => {
    if (head !== null) {
      setScrub(head);
      setVersion(head);
      setOffset(0);
    }
  };
  const pickTable = (t: string) => {
    setTable(t);
    setOffset(0);
    setOrderBy(null);
    setDir("asc");
  };
  const sortBy = (col: string) => {
    if (orderBy === col || (orderBy === null && data?.primaryKey === col)) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setOrderBy(col);
      setDir("asc");
    }
    setOffset(0);
  };

  const isPast = layout !== null && head !== null && layout.version !== head;
  const tableNames = layout ? Object.keys(layout.tables) : [];
  const tv = layout && table ? layout.tables[table] : null;

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <header className="mb-8">
        <div className="flex items-baseline gap-4">
          <h1 className="grow text-2xl font-semibold tracking-tight">
            Larva <span className="text-ink-muted font-normal">/ data viewer</span>
          </h1>
          <Link href="/" className="text-ink-secondary hover:text-foreground text-sm underline underline-offset-4">
            stress lab
          </Link>
          <Link href="/docs" className="text-ink-secondary hover:text-foreground text-sm underline underline-offset-4">
            docs
          </Link>
        </div>
        <p className="text-ink-secondary mt-2 max-w-2xl text-sm leading-relaxed">
          Browse the live demo store, scrub back through every commit (time travel is a byproduct
          of the architecture — old manifests are complete snapshots), and watch the chunk zone
          maps that make queries prune. Read-only: nothing here can write.
        </p>
      </header>

      {error && (
        <section className="border-critical/40 bg-surface mb-6 rounded-xl border p-4">
          <p className="text-sm">
            <span className="text-critical font-mono font-medium">{error.code}</span>
            <span className="text-ink-secondary ml-2">{error.message}</span>
          </p>
        </section>
      )}

      {/* --- version scrubber --- */}
      {layout && head !== null && (
        <section className="border-hairline bg-surface mb-6 rounded-xl border p-5">
          <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="text-sm font-medium">
              version <span className="tabular-nums">{scrub ?? layout.version}</span>
              <span className="text-ink-muted"> / {head}</span>
            </span>
            {isPast ? (
              <span className="text-series-1 border-series-1/40 rounded-full border px-2 py-0.5 text-xs font-medium">
                time-travelling — {new Date(layout.committedAt).toLocaleString()}
              </span>
            ) : (
              <span className="text-good-text text-xs font-medium">● live head · {new Date(layout.committedAt).toLocaleString()}</span>
            )}
            <span className="text-ink-muted grow text-right text-xs">format {layout.formatVersion} · commit log</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-ink-muted text-xs tabular-nums">v0</span>
            <input
              type="range"
              min={0}
              max={head}
              value={scrub ?? head}
              onChange={(e) => setScrub(Number(e.target.value))}
              onPointerUp={commitScrub}
              onKeyUp={commitScrub}
              className="accent-series-1 h-1 grow cursor-pointer"
              aria-label="database version"
            />
            <span className="text-ink-muted text-xs tabular-nums">v{head}</span>
            <button
              onClick={toLive}
              disabled={!isPast}
              className="bg-foreground text-background rounded-md px-3 py-1 text-xs font-medium transition-opacity hover:opacity-85 disabled:opacity-30"
            >
              jump to live
            </button>
          </div>
        </section>
      )}

      {/* --- table tabs --- */}
      {tableNames.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {tableNames.map((t) => {
            const active = t === table;
            return (
              <button
                key={t}
                onClick={() => pickTable(t)}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "border-foreground bg-foreground text-background"
                    : "border-hairline bg-surface text-ink-secondary hover:text-foreground"
                }`}
              >
                {t}
                <span className={`ml-2 tabular-nums ${active ? "opacity-70" : "text-ink-muted"}`}>
                  {layout?.tables[t]?.rowCount ?? 0}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* --- rows grid --- */}
      {data && (
        <section className="border-hairline bg-surface mb-6 overflow-hidden rounded-xl border">
          <div className="border-hairline flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-5 py-3 text-xs">
            <span className="text-ink-secondary">
              rows{" "}
              <span className="tabular-nums">
                {data.total === 0 ? 0 : data.offset + 1}–{Math.min(data.offset + data.limit, data.total)}
              </span>{" "}
              of <span className="tabular-nums">{data.total}</span>
            </span>
            <span className="text-ink-muted">
              scanned <span className="tabular-nums">{data.stats.chunksFetched}</span> of{" "}
              <span className="tabular-nums">{data.stats.chunksTotal}</span> chunk
              {data.stats.chunksTotal === 1 ? "" : "s"}
              {data.stats.chunksFetched < data.stats.chunksTotal && " — zone maps pruned the rest"}
            </span>
            {loadingRows && <span className="text-ink-muted">loading…</span>}
            <span className="text-ink-muted grow text-right">
              ordered by {data.orderBy} {data.dir}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-background sticky top-0">
                <tr className="text-ink-muted text-left text-xs">
                  {data.columns.map((c) => (
                    <th key={c} className="font-medium">
                      <button
                        onClick={() => sortBy(c)}
                        className="hover:text-foreground flex w-full items-center gap-1 px-3 py-2 text-left font-medium"
                      >
                        {c}
                        {c === data.primaryKey && <span className="text-ink-muted/60" title="primary key">pk</span>}
                        {c === data.partitionColumn && <span className="text-series-1/70" title="partition column">part</span>}
                        {data.orderBy === c && <span>{data.dir === "asc" ? "↑" : "↓"}</span>}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, i) => (
                  <tr key={i} className="border-hairline border-t">
                    {data.columns.map((c) => (
                      <td key={c} className="max-w-xs truncate px-3 py-1.5 whitespace-nowrap" title={cellTitle(row[c])}>
                        <Cell value={row[c]} />
                      </td>
                    ))}
                  </tr>
                ))}
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={data.columns.length} className="text-ink-muted px-3 py-6 text-center text-sm">
                      no rows at this version
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {data.total > data.limit && (
            <div className="border-hairline flex items-center justify-between border-t px-5 py-3 text-xs">
              <button
                onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
                disabled={data.offset === 0}
                className="border-hairline hover:text-foreground text-ink-secondary rounded-md border px-3 py-1 transition-colors disabled:opacity-30"
              >
                ← prev
              </button>
              <span className="text-ink-muted tabular-nums">
                page {Math.floor(data.offset / data.limit) + 1} of {Math.max(1, Math.ceil(data.total / data.limit))}
              </span>
              <button
                onClick={() => setOffset((o) => o + PAGE)}
                disabled={data.offset + data.limit >= data.total}
                className="border-hairline hover:text-foreground text-ink-secondary rounded-md border px-3 py-1 transition-colors disabled:opacity-30"
              >
                next →
              </button>
            </div>
          )}
        </section>
      )}

      {/* --- chunk / zone-map internals --- */}
      {tv && table && (
        <section className="border-hairline bg-surface rounded-xl border p-5">
          <div className="mb-1 flex items-baseline gap-2">
            <h2 className="text-sm font-medium">chunks &amp; zone maps</h2>
            <span className="text-ink-muted text-xs">
              {tv.chunkCount} chunk{tv.chunkCount === 1 ? "" : "s"} · {tv.rowCount} rows · <code>{table}</code> @ v{layout?.version}
            </span>
          </div>
          <p className="text-ink-muted mb-4 text-xs leading-relaxed">
            Every chunk is an immutable blob. The manifest stores each one&apos;s row count and the
            min/max of the primary key{data?.partitionColumn ? ` and the partition column (${data.partitionColumn})` : ""} —
            the zone maps a query uses to skip chunks it can&apos;t match.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-ink-muted border-hairline border-b text-left text-xs">
                  <th className="px-3 py-2 font-medium">chunk</th>
                  <th className="px-3 py-2 text-right font-medium">rows</th>
                  <th className="px-3 py-2 font-medium">{data?.primaryKey ?? "pk"} min → max</th>
                  <th className="px-3 py-2 font-medium">
                    {data?.partitionColumn ? `${data.partitionColumn} min → max` : "partition"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {tv.chunks.map((ch) => (
                  <tr key={ch.id} className="border-hairline border-b last:border-0">
                    <td className="px-3 py-1.5 font-mono text-xs" title={ch.id}>
                      {ch.id.slice(0, 8)}…
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{ch.rows}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">
                      {ch.pk ? <ZoneRange min={ch.pk.min} max={ch.pk.max} /> : <span className="text-ink-muted">—</span>}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs">
                      {ch.partition ? <ZoneRange min={ch.partition.min} max={ch.partition.max} /> : <span className="text-ink-muted">—</span>}
                    </td>
                  </tr>
                ))}
                {tv.chunks.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-ink-muted px-3 py-6 text-center">
                      no chunks — this table is empty at v{layout?.version}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <footer className="text-ink-muted mt-10 text-xs leading-relaxed">
        Reads only. Rows come from <code>db.query</code> (and <code>db.asOf</code> for past versions);
        the chunk layout from <code>db.inspect</code> — a read-only projection of the manifest.
        Both hit the same demo store as the console and stress lab.
      </footer>
    </main>
  );
}

function Cell({ value }: { value: Scalar }) {
  if (value === null || value === undefined) return <span className="text-ink-muted italic">NULL</span>;
  if (typeof value === "boolean") return <span className="tabular-nums">{value ? "true" : "false"}</span>;
  if (typeof value === "number") return <span className="tabular-nums">{value}</span>;
  return <>{String(value)}</>;
}

function cellTitle(value: Scalar): string {
  if (value === null || value === undefined) return "NULL";
  return String(value);
}

function ZoneRange({ min, max }: { min: Scalar; max: Scalar | null }) {
  const fmt = (v: Scalar) => (v === null || v === undefined ? "∅" : String(v));
  const a = fmt(min);
  const b = fmt(max);
  return (
    <span title={`${a} → ${b}`}>
      {trunc(a)} <span className="text-ink-muted">→</span> {trunc(b)}
    </span>
  );
}

function trunc(s: string): string {
  return s.length > 22 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;
}
