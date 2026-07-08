"use client";

import { useEffect, useRef, useState } from "react";
import type { StressConfig, StressReport } from "larvadb/testing";
import { Console } from "./console";

type Mode = StressConfig["mode"];

export default function Home() {
  const [writers, setWriters] = useState(10);
  const [commits, setCommits] = useState(10);
  const [mode, setMode] = useState<Mode>("mixed");
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [report, setReport] = useState<StressReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (running) {
      const started = Date.now();
      timer.current = setInterval(() => setElapsed(Date.now() - started), 250);
    } else if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [running]);

  async function run() {
    setRunning(true);
    setReport(null);
    setError(null);
    try {
      const res = await fetch("/api/stress", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ writers, commitsPerWriter: commits, mode }),
      });
      const body = (await res.json()) as StressReport | { error: string };
      if ("error" in body) setError(body.error);
      else setReport(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          Larva <span className="text-ink-muted font-normal">/ test lab</span>
        </h1>
        <p className="text-ink-secondary mt-2 max-w-2xl text-sm leading-relaxed">
          A SQL database living entirely inside Vercel Blob storage. Try the dialect in the
          console, export the escape hatch, then hammer the commit protocol with concurrent
          writers below.
        </p>
      </header>

      <Console />

      <h2 className="text-ink-secondary mt-10 mb-3 text-sm font-medium tracking-wide uppercase">
        Commit-protocol stress lab
      </h2>
      <p className="text-ink-secondary mb-4 max-w-2xl text-sm leading-relaxed">
        Concurrent writers hammer one Larva database — appends exercise the rebase path,
        shared-counter increments force full re-execution — then the final state is audited for
        lost updates, duplicates, and version drift. Design §6, tested for real.
      </p>

      <section className="border-hairline bg-surface rounded-xl border p-5">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Writers">
            <NumberInput value={writers} onChange={setWriters} min={1} max={20} />
          </Field>
          <Field label="Commits / writer">
            <NumberInput value={commits} onChange={setCommits} min={1} max={30} />
          </Field>
          <Field label="Workload">
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as Mode)}
              className="border-hairline bg-background h-9 rounded-md border px-2 text-sm"
            >
              <option value="mixed">mixed — appends + shared counter</option>
              <option value="append">append — disjoint writes only</option>
              <option value="counter">counter — every write overlaps</option>
            </select>
          </Field>
          <button
            onClick={run}
            disabled={running}
            className="bg-foreground text-background h-9 rounded-md px-5 text-sm font-medium transition-opacity hover:opacity-85 disabled:opacity-40"
          >
            {running ? "Running…" : "Run stress test"}
          </button>
          {running && (
            <span className="text-ink-muted text-sm tabular-nums">
              {(elapsed / 1000).toFixed(1)}s — all commits serialize through one CAS; this takes a
              while on purpose
            </span>
          )}
        </div>
      </section>

      {error && (
        <section className="border-hairline bg-surface mt-6 rounded-xl border p-5">
          <p className="text-critical text-sm font-medium">✕ run failed: {error}</p>
        </section>
      )}

      {report && <Results report={report} />}

      <footer className="text-ink-muted mt-10 text-xs leading-relaxed">
        Every run creates a throwaway database under <code>stress/&lt;runId&gt;/</code> in the
        Blob store and deletes it on pass. Failed runs keep their blobs for inspection.
      </footer>
    </main>
  );
}

function Results({ report }: { report: StressReport }) {
  const c = report.contention;
  const histogram = Object.entries(c.attemptsHistogram)
    .map(([attempts, count]) => ({ attempts: Number(attempts), count }))
    .sort((a, b) => a.attempts - b.attempts);
  const maxCount = Math.max(...histogram.map((b) => b.count), 1);

  return (
    <>
      <section
        className={`mt-6 rounded-xl border p-5 ${
          report.pass ? "border-good/40" : "border-critical/40"
        } bg-surface`}
      >
        <p className={`text-lg font-semibold ${report.pass ? "text-good-text" : "text-critical"}`}>
          {report.pass ? "✓ PASS — zero lost updates" : "✕ FAIL — correctness violation"}
        </p>
        <p className="text-ink-secondary mt-1 text-sm">
          run <code className="font-mono">{report.runId}</code> · {report.config.writers} writers ×{" "}
          {report.config.commitsPerWriter} commits · {report.config.mode} ·{" "}
          {(report.durationMs / 1000).toFixed(1)}s · {report.commitsPerSec} commits/sec
        </p>
      </section>

      <section className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="commits landed" value={report.commits.succeeded} />
        <StatTile
          label="failed loudly"
          value={report.commits.failedLoudly}
          alert={report.commits.failedLoudly > 0}
        />
        <StatTile label="CAS conflicts" value={c.casConflicts} />
        <StatTile label="throughput" value={report.commitsPerSec} unit="commits/s" />
        <StatTile label="rebases (disjoint)" value={c.rebases} />
        <StatTile label="re-executions (overlap)" value={c.reExecutions} />
        <StatTile label="commits that retried" value={c.retriedCommits} />
        <StatTile label="worst attempts" value={c.maxAttemptsSeen} />
      </section>

      <section className="border-hairline bg-surface mt-6 rounded-xl border p-5">
        <h2 className="text-sm font-medium">Attempts to land a commit</h2>
        <p className="text-ink-muted mb-4 text-xs">
          how many CAS rounds each successful commit needed
        </p>
        <div className="border-baseline flex h-40 items-end gap-2 border-b pb-px">
          {histogram.map((bucket) => (
            <div
              key={bucket.attempts}
              className="group relative flex flex-1 flex-col items-center justify-end gap-1"
            >
              <span className="text-ink-secondary text-xs tabular-nums">{bucket.count}</span>
              <div
                className="bg-series-1 w-full max-w-10 rounded-t transition-opacity group-hover:opacity-80"
                style={{ height: `${(bucket.count / maxCount) * 100}%` }}
              />
              <div className="bg-foreground text-background pointer-events-none absolute -top-8 hidden rounded px-2 py-1 text-xs whitespace-nowrap group-hover:block">
                {bucket.count} commit{bucket.count === 1 ? "" : "s"} took {bucket.attempts} attempt
                {bucket.attempts === 1 ? "" : "s"}
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-2 pt-1">
          {histogram.map((bucket) => (
            <span
              key={bucket.attempts}
              className="text-ink-muted flex-1 text-center text-xs tabular-nums"
            >
              {bucket.attempts}
            </span>
          ))}
        </div>
      </section>

      <section className="border-hairline bg-surface mt-6 overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-hairline text-ink-muted border-b text-left text-xs">
              <th className="px-5 py-3 font-medium">correctness check</th>
              <th className="px-5 py-3 font-medium">result</th>
              <th className="px-5 py-3 font-medium">detail</th>
            </tr>
          </thead>
          <tbody>
            {report.checks.map((check) => (
              <tr key={check.name} className="border-hairline border-b last:border-0">
                <td className="px-5 py-3">{check.name}</td>
                <td
                  className={`px-5 py-3 font-medium ${check.pass ? "text-good-text" : "text-critical"}`}
                >
                  {check.pass ? "✓ pass" : "✕ FAIL"}
                </td>
                <td className="text-ink-secondary px-5 py-3 font-mono text-xs">{check.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {report.errors.length > 0 && (
        <section className="border-hairline bg-surface mt-6 rounded-xl border p-5">
          <h2 className="mb-2 text-sm font-medium">Loud failures (allowed — never silent)</h2>
          <ul className="text-ink-secondary space-y-1 font-mono text-xs">
            {report.errors.map((err) => (
              <li key={err}>{err}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-ink-muted text-xs">{label}</span>
      {children}
    </label>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={(e) => onChange(Number(e.target.value))}
      className="border-hairline bg-background h-9 w-24 rounded-md border px-2 text-sm tabular-nums"
    />
  );
}

function StatTile({
  label,
  value,
  unit,
  alert,
}: {
  label: string;
  value: number;
  unit?: string;
  alert?: boolean;
}) {
  return (
    <div className="border-hairline bg-surface rounded-xl border p-4">
      <p className={`text-2xl font-semibold ${alert ? "text-critical" : ""}`}>
        {value}
        {unit && <span className="text-ink-muted ml-1 text-sm font-normal">{unit}</span>}
      </p>
      <p className="text-ink-muted mt-1 text-xs">{label}</p>
    </div>
  );
}
