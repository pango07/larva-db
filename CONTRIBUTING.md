# Contributing to Larva

Thanks for considering a contribution. Larva is small on purpose, and the "honest about its limits" philosophy applies to the codebase too: the goal is a tiny, correct, well-understood database — not a big one. Contributions that keep it that way are very welcome.

## Prerequisites

- [Bun](https://bun.sh) (the package manager and test runner for this repo)
- A **private Vercel Blob store** token for the live test suites. Any private store works; the tests create and delete throwaway databases under their own prefixes.

## Setup

```bash
git clone https://github.com/pango07/larva-db && cd larva-db
bun install
vercel env pull .env.local   # writes BLOB_READ_WRITE_TOKEN for the live suites
```

The library lives in `packages/larvadb` (published as `@larva-db/core`) and is imported as `@larva-db/core` throughout the app and scripts via workspace resolution.

## Running the tests

Correctness risk concentrates in the concurrent commit/retry path, so that is where the tests concentrate. Green CI is the bar for every PR.

```bash
bunx tsc --noEmit               # typecheck, incl. compile-only type-inference tests
bun run lint                    # eslint
bun scripts/s3-adapter-test.ts  # offline — fake S3 with 409/500 chaos, no credentials

# these need BLOB_READ_WRITE_TOKEN (a real private Blob store):
bun scripts/sql-smoke.ts        # full dialect + error catalog + pruning + time travel
bun scripts/api-smoke.ts        # transactions, export round-trip, vacuum
bun scripts/stress.ts --writers 4 --commits 6
bun scripts/property.ts --writers 4 --ops 10
```

CI runs all of the above on every pull request. The live suites are skipped automatically when no Blob token is available (e.g. on fork PRs), so they never block outside contributors — but a maintainer will run them before merge.

## Ground rules

These are the invariants that keep Larva correct and small. A PR that touches them needs a corresponding update to `LARVA-DESIGN.md` (the spec of record) in the same PR.

- **Read [`LARVA-DESIGN.md`](LARVA-DESIGN.md) §6 before touching anything in the write path.** The commit protocol is the heart of the system; the stress and property suites are the referee. If your change affects commits, it must pass them.
- **Chunks are immutable.** All mutation is copy-on-write plus one manifest compare-and-swap. Never modify a chunk in place.
- **Conflicts fail loudly.** No silently lost writes, ever. If a commit can't land, it throws — it never no-ops.
- **The public API stays small** — small enough to fit on one screen (Design §13). PRs that grow the API surface need a design-doc rationale in the same PR.
- **New SQL features come in threes:** the parser change, the executor change, *and* a named, helpful rejection message for whatever adjacent thing is still unsupported. Agents self-correct from specific errors — that error quality is a feature, not a nicety.
- **Private stores only; the escape hatch is sacred.** Larva never emits public URLs for data blobs, and `db.export()` must keep working — never trap a user's data.
- **Keep `LARVA-DESIGN.md` in sync.** It documents *why*, not just *what*.

## How releases work

You don't publish manually. Merging to `main` does it:

- CI runs the full suite, then publishes `@larva-db/core` to npm via **npm Trusted Publishing (OIDC)** — there are no npm tokens anywhere in the pipeline.
- A new version in `packages/larvadb/package.json` publishes as `latest`. Every other commit to `main` publishes a unique `canary` (`<version>-canary.<run>.<sha>`).
- To cut a real release, bump the version in `packages/larvadb/package.json` in your PR.

`main` is protected: no direct pushes, and every change lands through a reviewed PR with green CI.

## Good first issues

- Additional storage adapters (Azure Blob, Google Cloud Storage). The `StorageAdapter` contract is four operations — the existing `S3Adapter` is ~200 lines and a good template.
- A columnar chunk format (v2 storage optimization).
- Secondary index blobs.
- `ALTER TABLE` with a migration story that respects time travel (see Design §14).

## Reporting a security issue

Please do **not** open a public issue for security problems. Since Larva publishes to npm, supply-chain and data-safety reports matter — report them privately via [GitHub Security Advisories](https://github.com/pango07/larva-db/security/advisories/new).
