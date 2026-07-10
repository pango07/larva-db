# The Larva test lab

The Next.js app in this repo is a working demo **and** the project's test
bench. It runs a real Larva database (seeded with demo `customers` and
`orders`) inside your own Vercel Blob store — nothing is mocked.

Live pages:

| Route | What it is |
|---|---|
| `/` | SQL console + commit-protocol stress lab |
| `/docs` | this documentation, rendered, with a copy-the-agent-prompt button |
| `/llms.txt` | the agent prompt as raw markdown — point an agent straight at it |

## The SQL console

Type any statement in the supported dialect and run it against the live demo
database — which runs on **format 3, the ordered commit log**, so you are
exercising the newest write path. The example chips walk the dialect: joins +
`GROUP BY`, zone-map-pruned date ranges, `INSERT ... RETURNING`, revenue-by-day
(`GROUP BY DATE(...)`), `HAVING` + `CASE`, upsert via `ON CONFLICT`, an
auto-numbered insert into the `invoices` table (`t.sequence()` — omit the
column, read it back with `RETURNING`), and one deliberately unsupported query
so you can see an agent-grade error message.

Every result row comes back with timing, how many chunks the query actually
read (pruning in action), and the database version it saw.

**Export buttons** produce real files from the live database: Postgres
(`.sql`, load with `psql $DATABASE_URL < larva-demo.sql`), JSON, and per-table
CSV. **Reset demo data** rebuilds the seed rows if you've mangled them —
mangle freely, that's the point.

### Guardrails (it's a public toy, not a public liability)

- Statements are capped at 5,000 characters.
- Writes draw from a **budget of 400 commits between resets** — every commit
  bumps the database version, so budget × statement cap bounds total storage
  no matter what gets thrown at the console. Exhausting it returns
  `WRITE_BUDGET_EXHAUSTED` (HTTP 429); the reset button restarts it.
- Stress runs always clean up after themselves (the `cleanup` flag is not
  caller-controlled), and **Reset demo data** also sweeps blobs left behind
  by failed harness runs.

## The stress lab

The bottom of the home page hammers one Larva database with concurrent
writers, then audits the final state for lost updates, duplicates, and
version drift — the commit protocol's core promise, tested against the real
store on every click.

- **append** — disjoint writes; exercises the cheap *rebase* recovery path
- **counter** — every write overlaps; forces full *re-execute* recovery
- **mixed** — both at once

## API routes (what the buttons call)

| Route | Method | Does |
|---|---|---|
| `/api/sql` | POST `{ sql, params? }` | run one statement, return rows + stats |
| `/api/export?format=postgres\|json` | GET | download the live database |
| `/api/export?format=csv&table=NAME` | GET | download one table as CSV |
| `/api/demo-reset` | POST | drop and re-seed the demo tables |
| `/api/stress` | POST `{ writers, commitsPerWriter, mode }` | run the concurrent-writer audit |

## Run your own

```bash
git clone https://github.com/pango07/larva-db && cd larva-db
bun install
vercel link
vercel blob store add my-larva-store --access private --yes
vercel env pull .env.local        # gets BLOB_READ_WRITE_TOKEN
bun run dev                       # http://localhost:3000
vercel deploy --prod --yes        # or ship it
```

## Development commands

```bash
bunx tsc --noEmit                  # typecheck (includes compile-only type tests)
bun run lint                       # eslint

# offline — no credentials needed
bun scripts/s3-adapter-test.ts     # storage contract + injected chaos
bun scripts/group-commit-test.ts   # commit coalescing + conflict matrix

# live — need BLOB_READ_WRITE_TOKEN in .env.local
bun scripts/sql-smoke.ts           # the whole dialect, end to end
bun scripts/api-smoke.ts           # transactions, exports, vacuum
bun scripts/stress.ts --writers 4 --commits 6    # add --log for format 3
bun scripts/property.ts --writers 4 --ops 10     # add --log for format 3
bun scripts/bench.ts               # throughput benchmark, both formats (simulated latency)
```

CI runs all of it on every push and PR; merges to `main` publish to npm
(a `package.json` version bump ships as `latest`, anything else as `canary`).
