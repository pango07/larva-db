import Image from "next/image";
import Link from "next/link";
import { CopyButton } from "./_components/copy-button";
import { LiveDemo } from "./_components/live-demo";
import { SiteNav } from "./_components/site-nav";
import pkg from "@/packages/larvadb/package.json";

const INSTALL = "bun add @larva-db/core";

const FEATURES: { title: string; body: React.ReactNode }[] = [
  {
    title: "Real SQL",
    body: (
      <>
        Joins, transactions, aggregates, upserts, subqueries, secondary indexes — a closed,
        documented dialect that is a strict subset of Postgres. What runs here runs there.
      </>
    ),
  },
  {
    title: "No lost writes. Ever.",
    body: (
      <>
        Every commit is one compare-and-swap on the manifest. Concurrent writers rebase or re-run;
        after that, conflicts fail <em>loudly</em>. Silent data loss is a bug class Larva
        doesn&rsquo;t have.
      </>
    ),
  },
  {
    title: "Time travel built in",
    body: (
      <>
        Every commit is a complete snapshot. Query the database as of ten minutes ago, or roll back
        to any retained version — the rollback is itself undoable.
      </>
    ),
  },
  {
    title: "Built for AI agents",
    body: (
      <>
        Unsupported SQL returns machine-readable errors that name the feature and the alternative,
        so agents self-correct. The whole manual ships at{" "}
        <code className="font-mono text-xs">/llms.txt</code>.
      </>
    ),
  },
  {
    title: "Private by construction",
    body: (
      <>
        Every data blob is written private; Larva never mints a public URL for your rows. The only
        secret is the storage token you already have.
      </>
    ),
  },
  {
    title: "The escape hatch",
    body: (
      <>
        <code className="font-mono text-xs">larva export</code> emits a pg_dump-shaped file —{" "}
        <code className="font-mono text-xs">psql &lt; export.sql</code> is the whole migration.
        Outgrowing Larva is a supported feature, not a trap.
      </>
    ),
  },
];

const STATS: { value: string; label: string }[] = [
  { value: "297", label: "automated checks on every push" },
  { value: "1", label: "CAS swap per commit — the whole write path" },
  { value: "3", label: "storage backends: Vercel Blob, S3, R2" },
  { value: "0", label: "servers, containers, connection strings" },
];

const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: "01",
    title: "Rows live in immutable chunks",
    body: "Gzipped JSON blobs, ULID-named, never modified after they're written. Updates produce replacement chunks — which is why caching them can never go stale.",
  },
  {
    n: "02",
    title: "One manifest describes everything",
    body: "A single JSON file holds the schema, every table's chunk list, and zone-map stats for pruning. Its ETag is the concurrency token for the whole database.",
  },
  {
    n: "03",
    title: "A commit is one conditional swap",
    body: "Stage new chunks (touches nothing live), then compare-and-swap the manifest. Losers rebase if disjoint, re-execute if overlapping, and fail loudly after that.",
  },
];

export default function Landing() {
  return (
    <div className="theme-dark min-h-screen">
      <SiteNav />

      <main className="mx-auto w-full max-w-6xl px-6">
        {/* hero */}
        <section className="grid grid-cols-1 items-center gap-10 py-20 md:grid-cols-[1.2fr_1fr] md:py-28">
          <div>
            <p className="rise text-accent font-mono text-sm" style={{ "--stagger": 0 } as React.CSSProperties}>
              v{pkg.version} · MIT · npm: @larva-db/core
            </p>
            <h1
              className="rise mt-4 text-4xl font-semibold tracking-tight text-balance sm:text-5xl md:text-6xl"
              style={{ "--stagger": 1 } as React.CSSProperties}
            >
              A real SQL database, living in{" "}
              <span className="text-accent">your object store</span>
            </h1>
            <p
              className="rise text-ink-secondary mt-5 max-w-xl text-lg leading-relaxed"
              style={{ "--stagger": 2 } as React.CSSProperties}
            >
              Larva turns Vercel Blob, S3, or R2 into a durable SQL database with transactions,
              time travel, and a Postgres escape hatch. No server to run, no connection string to
              leak — just the bucket you already have.
            </p>

            <div
              className="rise mt-8 flex flex-wrap items-center gap-3"
              style={{ "--stagger": 3 } as React.CSSProperties}
            >
              <Link
                href="/docs/quickstart"
                className="bg-accent text-accent-ink h-11 rounded-lg px-6 text-sm leading-11 font-semibold transition-opacity hover:opacity-90"
              >
                Get started
              </Link>
              <Link
                href="/lab"
                className="border-hairline hover:border-accent/60 h-11 rounded-lg border px-6 text-sm leading-11 font-medium transition-colors"
              >
                Open the test lab
              </Link>
            </div>

            <div
              className="rise border-hairline bg-surface mt-8 inline-flex max-w-full items-center gap-3 rounded-lg border py-2.5 pr-2 pl-4 font-mono text-sm"
              style={{ "--stagger": 4 } as React.CSSProperties}
            >
              <span className="text-accent select-none">$</span>
              <span className="overflow-x-auto whitespace-nowrap">{INSTALL}</span>
              <CopyButton text={INSTALL} />
            </div>
          </div>

          <div className="rise relative hidden justify-center md:flex" style={{ "--stagger": 2 } as React.CSSProperties}>
            <div
              aria-hidden
              className="absolute top-1/2 left-1/2 size-105 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-25 blur-3xl"
              style={{ background: "radial-gradient(circle, #b8d431 0%, transparent 65%)" }}
            />
            <Image
              src="/larva-mark.png"
              alt="the larvadb larva"
              width={380}
              height={380}
              priority
              className="relative mix-blend-lighten"
            />
          </div>
        </section>

        {/* stats band */}
        <section className="border-hairline grid grid-cols-2 gap-px overflow-hidden rounded-2xl border md:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.label} className="bg-surface p-6">
              <p className="text-accent text-4xl font-semibold tabular-nums">{s.value}</p>
              <p className="text-ink-muted mt-2 text-sm leading-snug">{s.label}</p>
            </div>
          ))}
        </section>

        {/* live demo */}
        <section className="py-24">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              This page is a database. <span className="text-accent">Query it.</span>
            </h2>
            <p className="text-ink-secondary mt-4 leading-relaxed">
              A seeded demo store — customers, orders, sequence-numbered invoices — living in a
              private Vercel Blob store. Every run below hits it for real: watch the chunk pruning,
              the version counter, and the errors that teach.
            </p>
          </div>
          <div className="mx-auto mt-10 max-w-3xl">
            <LiveDemo />
          </div>
          <p className="text-ink-muted mt-4 text-center text-sm">
            Want to write to it, stress it, or time-travel through it?{" "}
            <Link href="/lab" className="text-accent hover:underline">
              The test lab
            </Link>{" "}
            and{" "}
            <Link href="/viewer" className="text-accent hover:underline">
              data viewer
            </Link>{" "}
            run on the same store.
          </p>
        </section>

        {/* code showcase */}
        <section className="pb-24">
          <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
                Schema in code. Queries in SQL. Nothing in between.
              </h2>
              <p className="text-ink-secondary mt-4 leading-relaxed">
                Define tables with typed columns and get inference for free — every row that comes
                back is already typed. Sequences and UUIDs assign themselves; a nullable column
                added in code migrates the store on connect.
              </p>
              <p className="text-ink-secondary mt-3 leading-relaxed">
                The tagged template is the whole API: parameters are extracted, never
                concatenated, and multiple statements per string are rejected outright.
              </p>
              <Link
                href="/docs/api"
                className="text-accent mt-6 inline-block text-sm font-medium hover:underline"
              >
                The entire API fits on one screen →
              </Link>
            </div>
            <CodeWindow />
          </div>
        </section>

        {/* features */}
        <section className="pb-24">
          <h2 className="text-center text-3xl font-semibold tracking-tight sm:text-4xl">
            Small on purpose. Honest everywhere.
          </h2>
          <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="border-hairline bg-surface hover:border-accent/40 rounded-2xl border p-6 transition-colors"
              >
                <h3 className="font-semibold">{f.title}</h3>
                <p className="text-ink-secondary mt-2 text-sm leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* how it works */}
        <section className="pb-24">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Delta Lake, miniaturized
            </h2>
            <p className="text-ink-secondary mt-4 leading-relaxed">
              The same architecture trusted for petabyte lakehouses, shrunk until it fits in a
              bucket: immutable data, one tiny mutable pointer, and optimistic concurrency on that
              pointer alone.
            </p>
          </div>
          <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.n} className="border-hairline bg-surface rounded-2xl border p-6">
                <p className="text-accent font-mono text-sm">{s.n}</p>
                <h3 className="mt-3 font-semibold">{s.title}</h3>
                <p className="text-ink-secondary mt-2 text-sm leading-relaxed">{s.body}</p>
              </div>
            ))}
          </div>
          <p className="mt-8 text-center">
            <Link
              href="/docs/how-it-works"
              className="text-accent text-sm font-medium hover:underline"
            >
              Read how it works — including what it deliberately doesn&rsquo;t do →
            </Link>
          </p>
        </section>

        {/* agents strip */}
        <section className="pb-24">
          <div className="border-accent/25 bg-surface relative overflow-hidden rounded-2xl border p-8 md:p-10">
            <div
              aria-hidden
              className="absolute -top-20 -right-20 size-64 rounded-full opacity-15 blur-3xl"
              style={{ background: "radial-gradient(circle, #b8d431 0%, transparent 70%)" }}
            />
            <div className="relative grid grid-cols-1 items-center gap-8 md:grid-cols-[1.4fr_1fr]">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                  Building with an agent? Hand it the manual.
                </h2>
                <p className="text-ink-secondary mt-3 leading-relaxed">
                  The complete dialect, the error catalog, and the rules of thumb are served as one
                  plain-text prompt at{" "}
                  <a href="/llms.txt" className="text-accent hover:underline">
                    /llms.txt
                  </a>
                  . Paste it into any agent and it writes correct Larva on the first try — and when
                  it doesn&rsquo;t, the error message is the documentation.
                </p>
              </div>
              <div className="border-hairline bg-background flex min-w-0 items-center gap-3 rounded-lg border py-2.5 pr-2 pl-4 font-mono text-sm">
                <span className="text-accent select-none">$</span>
                <span className="overflow-x-auto whitespace-nowrap">
                  curl larvadb.dev/llms.txt
                </span>
                <CopyButton text="curl https://larvadb.dev/llms.txt" />
              </div>
            </div>
          </div>
        </section>

        {/* final CTA */}
        <section className="pb-28 text-center">
          <Image
            src="/larva-lockup.png"
            alt="larvadb"
            width={309}
            height={171}
            className="mx-auto"
          />
          <p className="text-ink-secondary mx-auto mt-2 max-w-md leading-relaxed">
            Your first table is one <code className="font-mono text-sm">bun add</code> and one
            token away.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/docs/quickstart"
              className="bg-accent text-accent-ink h-11 rounded-lg px-6 text-sm leading-11 font-semibold transition-opacity hover:opacity-90"
            >
              Quickstart
            </Link>
            <a
              href="https://github.com/pango07/larva-db"
              className="border-hairline hover:border-accent/60 h-11 rounded-lg border px-6 text-sm leading-11 font-medium transition-colors"
            >
              Star it on GitHub
            </a>
          </div>
        </section>
      </main>

      <footer className="border-hairline border-t">
        <div className="text-ink-muted mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-8 text-sm">
          <span>MIT © larvadb</span>
          <span className="grow" />
          <Link href="/docs" className="hover:text-foreground transition-colors">
            Docs
          </Link>
          <Link href="/lab" className="hover:text-foreground transition-colors">
            Test lab
          </Link>
          <Link href="/viewer" className="hover:text-foreground transition-colors">
            Data viewer
          </Link>
          <a
            href="https://www.npmjs.com/package/@larva-db/core"
            className="hover:text-foreground transition-colors"
          >
            npm
          </a>
          <a
            href="https://github.com/pango07/larva-db"
            className="hover:text-foreground transition-colors"
          >
            GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}

function CodeWindow() {
  const kw = "text-accent";
  const str = "text-amber";
  const dim = "text-ink-muted";
  return (
    <div className="border-hairline bg-surface min-w-0 overflow-hidden rounded-2xl border shadow-2xl shadow-black/40">
      <div className="border-hairline flex items-center gap-2 border-b px-4 py-3">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
        <span className="text-ink-muted ml-3 font-mono text-xs">db.ts</span>
      </div>
      <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed">
        <code>
          <span className={kw}>import</span> {"{ defineSchema, larva, t }"}{" "}
          <span className={kw}>from</span> <span className={str}>&quot;@larva-db/core&quot;</span>
          {";\n\n"}
          <span className={kw}>const</span> db = larva({"{"}
          {"\n  schema: defineSchema({\n    invoices: {\n      number: t.sequence().primaryKey(),\n      customer: t.text(),\n      total: t.real(),\n      createdAt: t.timestamp().partitionBy(),\n    },\n  }),\n});\n\n"}
          <span className={dim}>{"// typed rows out, params extracted — never concatenated\n"}</span>
          <span className={kw}>const</span> [invoice] = <span className={kw}>await</span> db.sql
          <span className={str}>{"`"}</span>
          <span className={str}>{"\n  INSERT INTO invoices (customer, total)\n  VALUES ("}</span>
          {"${"}name{"}"}
          <span className={str}>, </span>
          {"${"}total{"}"}
          <span className={str}>{")\n  RETURNING number, customer`"}</span>
          {";\n\n"}
          <span className={dim}>{"// the database, ten minutes ago\n"}</span>
          <span className={kw}>const</span> past = <span className={kw}>await</span> db.asOf(
          <span className={kw}>new</span> Date(Date.now() - <span className={str}>600_000</span>
          ));
        </code>
      </pre>
    </div>
  );
}
