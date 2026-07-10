import type { Metadata } from "next";
import Link from "next/link";
import { agentPrompt } from "@/app/lib/agent-prompt";
import { CopyButton } from "./copy-button";

export const metadata: Metadata = {
  title: "Larva — docs & agent prompt",
  description:
    "How the Larva test lab works, every command, and the prompt to paste into your AI agent — also served raw at /llms.txt.",
};

const COMMANDS: [string, string][] = [
  ["bun install", "setup — bun is the package manager"],
  ["bun run dev", "run this dashboard locally"],
  ["bunx tsc --noEmit", "typecheck (includes compile-only type tests)"],
  ["bun run lint", "eslint"],
  ["bun scripts/s3-adapter-test.ts", "storage contract + chaos — offline, no credentials"],
  ["bun scripts/group-commit-test.ts", "commit coalescing + conflict matrix — offline"],
  ["bun scripts/sql-smoke.ts", "the whole dialect, live against the real store"],
  ["bun scripts/api-smoke.ts", "transactions, exports, vacuum — live"],
  ["bun scripts/cli-smoke.ts", "the larva CLI end to end — live"],
  ["bun scripts/stress.ts --writers 4 --commits 6", "concurrent-writer audit — live; add --log for format 3"],
  ["bun scripts/property.ts --writers 4 --ops 10", "randomized workloads vs. a model — live; add --log for format 3"],
  ["bun scripts/bench.ts", "write-throughput benchmark, both formats — offline"],
];

const ROUTES: [string, string, string][] = [
  ["/api/sql", "POST { sql, params? }", "run one statement, get rows + chunk-read stats"],
  ["/api/export?format=postgres | json", "GET", "download the live database"],
  ["/api/export?format=csv&table=NAME", "GET", "download one table as CSV"],
  ["/api/demo-reset", "POST", "drop and re-seed the demo tables; restarts the write budget"],
  ["/api/stress", "POST { writers, commitsPerWriter, mode }", "run the concurrent-writer audit"],
];

export default function DocsPage() {
  const prompt = agentPrompt();

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          Larva <span className="text-ink-muted font-normal">/ docs</span>
        </h1>
        <p className="text-ink-secondary mt-2 max-w-2xl text-sm leading-relaxed">
          How this test lab works, the commands to run everything yourself, and the prompt that
          teaches your AI agent to use Larva correctly.
        </p>
        <Link
          href="/"
          className="text-ink-secondary hover:text-foreground mt-3 inline-block text-sm underline underline-offset-4"
        >
          ← back to the console
        </Link>
      </header>

      <section className="border-hairline bg-surface mb-8 rounded-xl border p-5">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-ink-secondary grow text-sm font-medium tracking-wide uppercase">
            The prompt for your agent
          </h2>
          <a
            href="/llms.txt"
            className="border-hairline text-ink-secondary hover:text-foreground rounded-md border px-3 py-1.5 text-xs"
          >
            View as markdown (/llms.txt)
          </a>
          <CopyButton text={prompt} />
        </div>
        <p className="text-ink-secondary mb-3 max-w-2xl text-sm leading-relaxed">
          Paste this into your agent&apos;s instructions — CLAUDE.md, AGENTS.md, .cursorrules, or a
          system prompt. It covers the supported SQL, the guardrails, and the performance rules of
          thumb. Agents can also fetch it directly from{" "}
          <a href="/llms.txt" className="underline underline-offset-4">/llms.txt</a>.
        </p>
        <pre className="border-hairline bg-background max-h-96 overflow-auto rounded-md border p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {prompt}
        </pre>
      </section>

      <section className="mb-8">
        <h2 className="text-ink-secondary mb-3 text-sm font-medium tracking-wide uppercase">
          What this lab is
        </h2>
        <p className="text-ink-secondary mb-3 max-w-2xl text-sm leading-relaxed">
          A real Larva database (seeded <code className="font-mono">customers</code>,{" "}
          <code className="font-mono">orders</code>, and auto-numbered{" "}
          <code className="font-mono">invoices</code>) living in a private Vercel Blob store on
          format 3, the ordered commit log — nothing mocked. The <Link href="/" className="underline underline-offset-4">console</Link> runs any
          statement in the dialect and reports timing, chunks read (zone-map pruning in action), and
          the database version. The export buttons produce real files — the Postgres one loads with{" "}
          <code className="font-mono">psql $DATABASE_URL &lt; larva-demo.sql</code>. The stress lab
          hammers the commit protocol with concurrent writers and audits for lost updates. Mangle
          the demo data freely; <em>Reset demo data</em> re-seeds it. Writes draw from a budget of
          400 commits between resets (statements cap at 5,000 chars), so the store stays a toy no
          matter what the console is fed.
        </p>
        <div className="border-hairline bg-surface overflow-x-auto rounded-xl border">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-ink-secondary border-hairline border-b text-xs uppercase">
                <th className="px-4 py-2 font-medium">route</th>
                <th className="px-4 py-2 font-medium">call</th>
                <th className="px-4 py-2 font-medium">does</th>
              </tr>
            </thead>
            <tbody>
              {ROUTES.map(([route, call, does]) => (
                <tr key={route} className="border-hairline border-b last:border-0">
                  <td className="px-4 py-2 font-mono text-xs">{route}</td>
                  <td className="text-ink-secondary px-4 py-2 font-mono text-xs">{call}</td>
                  <td className="text-ink-secondary px-4 py-2">{does}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-ink-secondary mb-3 text-sm font-medium tracking-wide uppercase">
          Every command
        </h2>
        <div className="border-hairline bg-surface overflow-x-auto rounded-xl border">
          <table className="w-full text-left text-sm">
            <tbody>
              {COMMANDS.map(([cmd, what]) => (
                <tr key={cmd} className="border-hairline border-b last:border-0">
                  <td className="px-4 py-2 font-mono text-xs whitespace-nowrap">{cmd}</td>
                  <td className="text-ink-secondary px-4 py-2">{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-ink-secondary mt-3 text-sm">
          The <code className="font-mono">larva</code> CLI (<code className="font-mono">npx larva sql | export | upgrade | rollback | vacuum</code>) has its own reference:{" "}
          <a
            href="https://github.com/pango07/larva-db/blob/main/docs/cli.md"
            className="underline underline-offset-4"
          >
            docs/cli.md
          </a>
          . Full docs live in the repo:{" "}
          <a
            href="https://github.com/pango07/larva-db/blob/main/docs/test-lab.md"
            className="underline underline-offset-4"
          >
            docs/test-lab.md
          </a>{" "}
          · the design of record is{" "}
          <a
            href="https://github.com/pango07/larva-db/blob/main/LARVA-DESIGN.md"
            className="underline underline-offset-4"
          >
            LARVA-DESIGN.md
          </a>
          .
        </p>
      </section>
    </main>
  );
}
