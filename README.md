# larva-db

Prototype repo for **Larva** (`larvadb`) — a tiny SQL database that lives inside Vercel Blob. See [`LARVA-DESIGN.md`](./LARVA-DESIGN.md) for the full design and [`LARVA-QUICKSTART.md`](./LARVA-QUICKSTART.md) for the product vision.

## What's here now

The highest-risk piece of the design is being prototyped first, in isolation: the **commit protocol** (Design §6) — copy-on-write chunks plus one compare-and-swap on the manifest, with rebase/re-execute conflict handling. No SQL layer yet.

- `lib/larva/storage.ts` — the four-operation `StorageAdapter` contract + Vercel Blob implementation (`ifMatch` CAS, conflict classification)
- `lib/larva/core.ts` — manifest, immutable chunks, and the stage → CAS → rebase/re-execute/backoff commit loop
- `lib/larva/stress.ts` — concurrent-writer stress harness asserting zero lost updates
- `scripts/stress.ts` — CLI runner
- `app/` — Next.js 16 test dashboard ("stress lab") to run and visualize stress tests

## Running

```bash
bun install
vercel env pull .env.local        # needs the linked private Blob store
bun scripts/stress.ts --writers 10 --commits 20 --mode mixed
```

Modes: `append` (disjoint writes → rebase path), `counter` (every write overlaps → re-execution path), `mixed` (both). Each run creates a throwaway database under `stress/<runId>/` in the Blob store and cleans up on pass; failed runs keep their blobs for inspection.

The dashboard (`bun run dev`, or the deployed URL) runs the same harness from a Vercel function.
