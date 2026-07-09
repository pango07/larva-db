<!-- Thanks for contributing to Larva! Keep it small and correct. -->

## What & why

<!-- What does this change do, and what problem does it solve? Link any issue. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / internal
- [ ] Docs only
- [ ] Storage adapter

## Checklist

- [ ] `bunx tsc --noEmit` passes (includes the compile-only type-inference tests)
- [ ] `bun run lint` passes
- [ ] `bun scripts/s3-adapter-test.ts` passes (offline, no credentials)
- [ ] Live suites run against a real Blob store, or I've noted why not: `sql-smoke`, `api-smoke`, `stress`, `property`
- [ ] If I touched the write path (Design §6), the stress and property suites still pass
- [ ] If I changed the storage format, public API, or an invariant, I updated `LARVA-DESIGN.md` in this PR
- [ ] New SQL support includes a parser change, an executor change, **and** a named rejection message for the nearest still-unsupported feature

## Notes for the reviewer

<!-- Anything worth calling out: tricky edge cases, perf, follow-ups deferred, etc. -->
