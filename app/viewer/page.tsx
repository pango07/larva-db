"use client";

import Link from "next/link";
import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
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
interface TableMeta {
  columns: string[];
  types: Record<string, string>;
  primaryKey: string;
  partitionColumn: string | null;
}
interface Inspection {
  version: number;
  committedAt: string;
  formatVersion: number;
  isCurrent: boolean;
  currentVersion: number;
  tables: Record<string, TableView>;
  schema: Record<string, TableMeta>;
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

const PAGE = 50;
const SKELETON_ROWS = 8;

class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json();
  if (body && typeof body === "object" && "error" in body) {
    throw new ApiError(body.error.code, body.error.message);
  }
  return body as T;
}

export default function Viewer() {
  // UI selections. `null` means "follow the default" (head version / first table),
  // so the derived values below stay correct even before the first fetch lands —
  // no effects, no setState-in-effect.
  const [userVersion, setUserVersion] = useState<number | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [userTable, setUserTable] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [orderBy, setOrderBy] = useState<string | null>(null);
  const [dir, setDir] = useState<"asc" | "desc">("asc");

  const inspectQuery = useQuery({
    queryKey: ["inspect", userVersion],
    queryFn: () => getJSON<Inspection>(`/api/inspect${userVersion === null ? "" : `?version=${userVersion}`}`),
    placeholderData: keepPreviousData,
  });

  const inspect = inspectQuery.data;
  const head = inspect?.currentVersion ?? null;
  const version = userVersion ?? head; // the version being viewed
  const schema = inspect?.schema ?? {};
  const tableNames = Object.keys(schema);
  const table = userTable ?? tableNames[0] ?? null;
  const meta = table ? schema[table] ?? null : null;

  const rowsQuery = useQuery({
    queryKey: ["rows", table, version, offset, orderBy, dir],
    queryFn: () => {
      const params = new URLSearchParams({ table: table!, version: String(version), limit: String(PAGE), offset: String(offset), dir });
      if (orderBy) params.set("orderBy", orderBy);
      return getJSON<RowsResponse>(`/api/viewer-rows?${params}`);
    },
    enabled: table !== null && version !== null,
    placeholderData: keepPreviousData,
  });

  const rows = rowsQuery.data;
  // Only trust row data that belongs to the table+version currently selected.
  // On a table/version switch the previous data lingers (keepPreviousData) but
  // must not be painted under the new headers — show the skeleton instead.
  // Within a table+version (pagination) it matches and stays for a smooth swap.
  const rowsMatch = rows != null && rows.table === table && rows.version === version;
  const tv = inspect && table ? inspect.tables[table] ?? null : null;
  const chunksMatch = inspect != null && inspect.version === version;

  const error = (inspectQuery.error ?? rowsQuery.error) as ApiError | null;
  const isPast = version !== null && head !== null && version !== head;
  const sliderValue = scrub ?? version ?? 0;

  const commitScrub = () => {
    if (scrub !== null && scrub !== version) {
      setUserVersion(scrub);
      setOffset(0);
    }
  };
  const toLive = () => {
    setUserVersion(null);
    setScrub(null);
    setOffset(0);
  };
  const pickTable = (t: string) => {
    setUserTable(t);
    setOffset(0);
    setOrderBy(null);
    setDir("asc");
  };
  const sortBy = (col: string) => {
    const activeCol = orderBy ?? meta?.primaryKey;
    if (activeCol === col) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setOrderBy(col);
      setDir("asc");
    }
    setOffset(0);
  };

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
      <section className="border-hairline bg-surface mb-6 rounded-xl border p-5">
        {inspect && head !== null ? (
          <>
            <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="text-sm font-medium">
                version <span className="tabular-nums">{sliderValue}</span>
                <span className="text-ink-muted"> / {head}</span>
              </span>
              {isPast ? (
                <span className="text-series-1 border-series-1/40 rounded-full border px-2 py-0.5 text-xs font-medium">
                  time-travelling — {new Date(inspect.committedAt).toLocaleString()}
                </span>
              ) : (
                <span className="text-good-text text-xs font-medium">● live head · {new Date(inspect.committedAt).toLocaleString()}</span>
              )}
              <span className="text-ink-muted grow text-right text-xs">format {inspect.formatVersion} · commit log</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-ink-muted text-xs tabular-nums">v0</span>
              <input
                type="range"
                min={0}
                max={head}
                value={sliderValue}
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
          </>
        ) : (
          <div className="flex items-center gap-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-1 grow" />
            <Skeleton className="h-6 w-20" />
          </div>
        )}
      </section>

      {/* --- table tabs --- */}
      <div className="mb-4 flex flex-wrap gap-2">
        {tableNames.length > 0
          ? tableNames.map((t) => {
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
                    {inspect?.tables[t]?.rowCount ?? 0}
                  </span>
                </button>
              );
            })
          : [0, 1, 2].map((i) => <Skeleton key={i} className="h-8 w-24 rounded-md" />)}
      </div>

      {/* --- rows grid: structure always present; body skeletons while loading --- */}
      <section className="border-hairline bg-surface mb-6 overflow-hidden rounded-xl border">
        <div className="border-hairline flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-5 py-3 text-xs">
          {rowsMatch ? (
            <>
              <span className="text-ink-secondary">
                rows{" "}
                <span className="tabular-nums">
                  {rows!.total === 0 ? 0 : rows!.offset + 1}–{Math.min(rows!.offset + rows!.limit, rows!.total)}
                </span>{" "}
                of <span className="tabular-nums">{rows!.total}</span>
              </span>
              <span className="text-ink-muted">
                scanned <span className="tabular-nums">{rows!.stats.chunksFetched}</span> of{" "}
                <span className="tabular-nums">{rows!.stats.chunksTotal}</span> chunk
                {rows!.stats.chunksTotal === 1 ? "" : "s"}
                {rows!.stats.chunksFetched < rows!.stats.chunksTotal && " — zone maps pruned the rest"}
              </span>
            </>
          ) : (
            <Skeleton className="h-3.5 w-64" />
          )}
          {rowsQuery.isFetching && <span className="text-ink-muted">loading…</span>}
          {meta && (
            <span className="text-ink-muted grow text-right">
              ordered by {rowsMatch ? `${rows!.orderBy} ${rows!.dir}` : `${orderBy ?? meta.primaryKey} ${dir}`}
            </span>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-background sticky top-0">
              <tr className="text-ink-muted text-left text-xs">
                {meta
                  ? meta.columns.map((c) => (
                      <th key={c} className="font-medium">
                        <button
                          onClick={() => sortBy(c)}
                          className="hover:text-foreground flex w-full items-center gap-1 px-3 py-2 text-left font-medium"
                        >
                          {c}
                          {c === meta.primaryKey && <span className="text-ink-muted/60" title="primary key">pk</span>}
                          {c === meta.partitionColumn && <span className="text-series-1/70" title="partition column">part</span>}
                          {rowsMatch && rows!.orderBy === c && <span>{rows!.dir === "asc" ? "↑" : "↓"}</span>}
                        </button>
                      </th>
                    ))
                  : SKELETON_COLS.map((i) => (
                      <th key={i} className="font-medium">
                        <div className="px-3 py-2">
                          <Skeleton className="h-3 w-16" />
                        </div>
                      </th>
                    ))}
              </tr>
            </thead>
            <tbody>
              {rowsMatch ? (
                rows!.rows.length > 0 ? (
                  rows!.rows.map((row, i) => (
                    <tr key={i} className="border-hairline border-t">
                      {rows!.columns.map((c) => (
                        <td key={c} className="max-w-xs truncate px-3 py-1.5 whitespace-nowrap" title={cellTitle(row[c])}>
                          <Cell value={row[c]} />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={rows!.columns.length} className="text-ink-muted px-3 py-6 text-center text-sm">
                      no rows at this version
                    </td>
                  </tr>
                )
              ) : (
                <SkeletonRows cols={(meta?.columns ?? SKELETON_COLS).length} />
              )}
            </tbody>
          </table>
        </div>
        {rowsMatch && rows!.total > rows!.limit && (
          <div className="border-hairline flex items-center justify-between border-t px-5 py-3 text-xs">
            <button
              onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
              disabled={rows!.offset === 0}
              className="border-hairline hover:text-foreground text-ink-secondary rounded-md border px-3 py-1 transition-colors disabled:opacity-30"
            >
              ← prev
            </button>
            <span className="text-ink-muted tabular-nums">
              page {Math.floor(rows!.offset / rows!.limit) + 1} of {Math.max(1, Math.ceil(rows!.total / rows!.limit))}
            </span>
            <button
              onClick={() => setOffset((o) => o + PAGE)}
              disabled={rows!.offset + rows!.limit >= rows!.total}
              className="border-hairline hover:text-foreground text-ink-secondary rounded-md border px-3 py-1 transition-colors disabled:opacity-30"
            >
              next →
            </button>
          </div>
        )}
      </section>

      {/* --- chunk / zone-map internals --- */}
      <section className="border-hairline bg-surface rounded-xl border p-5">
        <div className="mb-1 flex items-baseline gap-2">
          <h2 className="text-sm font-medium">chunks &amp; zone maps</h2>
          <span className="text-ink-muted text-xs">
            {tv && chunksMatch ? (
              <>
                {tv.chunkCount} chunk{tv.chunkCount === 1 ? "" : "s"} · {tv.rowCount} rows · <code>{table}</code> @ v{inspect?.version}
              </>
            ) : (
              <>loading layout…</>
            )}
          </span>
        </div>
        <p className="text-ink-muted mb-4 text-xs leading-relaxed">
          Every chunk is an immutable blob. The manifest stores each one&apos;s row count and the
          min/max of the primary key{meta?.partitionColumn ? ` and the partition column (${meta.partitionColumn})` : ""} —
          the zone maps a query uses to skip chunks it can&apos;t match.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-ink-muted border-hairline border-b text-left text-xs">
                <th className="px-3 py-2 font-medium">chunk</th>
                <th className="px-3 py-2 text-right font-medium">rows</th>
                <th className="px-3 py-2 font-medium">{meta?.primaryKey ?? "pk"} min → max</th>
                <th className="px-3 py-2 font-medium">
                  {meta?.partitionColumn ? `${meta.partitionColumn} min → max` : "partition"}
                </th>
              </tr>
            </thead>
            <tbody>
              {tv && chunksMatch ? (
                tv.chunks.length > 0 ? (
                  tv.chunks.map((ch) => (
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
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="text-ink-muted px-3 py-6 text-center">
                      no chunks — this table is empty at v{inspect?.version}
                    </td>
                  </tr>
                )
              ) : (
                <SkeletonRows cols={4} count={3} />
              )}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="text-ink-muted mt-10 text-xs leading-relaxed">
        Reads only, fetched with React Query. Rows come from <code>db.query</code> (and{" "}
        <code>db.asOf</code> for past versions); the chunk layout from <code>db.inspect</code> — a
        read-only projection of the manifest. Both hit the same demo store as the console and stress lab.
      </footer>
    </main>
  );
}

const SKELETON_COLS = [0, 1, 2, 3, 4];

function Skeleton({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`bg-ink-muted/20 animate-pulse rounded ${className}`} style={style} />;
}

function SkeletonRows({ cols, count = SKELETON_ROWS }: { cols: number; count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, r) => (
        <tr key={r} className="border-hairline border-t">
          {Array.from({ length: cols }, (_, c) => (
            <td key={c} className="px-3 py-2">
              <Skeleton className="h-3 rounded" style={{ width: `${skelWidth(r, c)}%` }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// Deterministic pseudo-random widths so the skeleton looks like data, not a grid.
function skelWidth(row: number, col: number): number {
  const widths = [80, 55, 40, 65, 48, 72, 35, 60];
  return widths[(row * 3 + col * 5) % widths.length];
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
