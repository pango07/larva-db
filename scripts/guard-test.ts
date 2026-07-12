/**
 * Demo-endpoint abuse guards (app/lib/guard.ts), offline. The public lab must
 * be un-griefable: per-IP sliding windows, and durable global daily budgets
 * (commits / resets / stress runs) updated via CAS on a fake storage adapter —
 * including the properties that matter under attack: exact counting during
 * concurrent contention, fail-closed when the store misbehaves, cooldowns
 * that a reset loop can't launder.
 *
 *   bun scripts/guard-test.ts
 */
import type { StorageAdapter, GetResult, ListedObject, PutOptions } from "@larva-db/core";
import { CasConflictError } from "@larva-db/core";
import { createGuard, rateLimit, LIMITS } from "../app/lib/guard";

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? ` — ${detail}` : ""}`);
};

// ---------- fake CAS store ----------
class FakeStore implements StorageAdapter {
  objects = new Map<string, { body: string; etag: string }>();
  etagCounter = 0;
  alwaysConflict = false;
  failReads = false;

  async get(path: string): Promise<GetResult | null> {
    // yield twice so concurrent mutate() calls interleave get→put for real
    await new Promise((r) => setTimeout(r, Math.random() * 2));
    if (this.failReads) throw new Error("store is down");
    const obj = this.objects.get(path);
    return obj ? { body: obj.body, etag: obj.etag } : null;
  }
  async put(path: string, body: string, opts?: PutOptions): Promise<{ etag: string }> {
    await new Promise((r) => setTimeout(r, Math.random() * 2));
    if (this.alwaysConflict) throw new CasConflictError(path);
    const current = this.objects.get(path);
    if (opts?.createOnly && current) throw new CasConflictError(path);
    if (opts?.ifMatch && current?.etag !== opts.ifMatch) throw new CasConflictError(path);
    const etag = `"${++this.etagCounter}"`;
    this.objects.set(path, { body, etag });
    return { etag };
  }
  async del(): Promise<void> {}
  async list(): Promise<ListedObject[]> {
    return [];
  }
}

const DAY1 = Date.parse("2026-07-12T10:00:00Z");
const DAY2 = Date.parse("2026-07-13T10:00:00Z");

// ---------- per-IP sliding window ----------
{
  let allowed = 0;
  for (let i = 0; i < 7; i++) if (rateLimit("t1", "1.2.3.4", 5, DAY1 + i * 100)) allowed++;
  ok("window allows exactly the per-minute quota", allowed === 5, `allowed ${allowed}`);
  ok("window blocks while full", !rateLimit("t1", "1.2.3.4", 5, DAY1 + 1000));
  ok("window slides — old hits expire", rateLimit("t1", "1.2.3.4", 5, DAY1 + 61_000));
  ok("other IPs are unaffected", rateLimit("t1", "5.6.7.8", 5, DAY1 + 1000));
  ok("other buckets are unaffected", rateLimit("t2", "1.2.3.4", 5, DAY1 + 1000));
}

// ---------- daily commit budget ----------
{
  const store = new FakeStore();
  const g = createGuard(store);
  let granted = 0;
  for (let i = 0; i < LIMITS.dailyCommits; i++) if ((await g.takeCommit(DAY1)).ok) granted++;
  ok("grants exactly the daily commit budget", granted === LIMITS.dailyCommits, `granted ${granted}`);
  const over = await g.takeCommit(DAY1);
  ok("commit over budget is rejected", !over.ok && over.code === "DAILY_WRITE_BUDGET");
  const nextDay = await g.takeCommit(DAY2);
  ok("budget resets on UTC day rollover", nextDay.ok);
}

// ---------- concurrent contention counts exactly ----------
{
  const store = new FakeStore();
  const g = createGuard(store);
  const results = await Promise.all(Array.from({ length: 25 }, () => g.takeCommit(DAY1)));
  const granted = results.filter((r) => r.ok).length;
  const state = JSON.parse(store.objects.get("demo/guard/state.json")!.body) as { commits: number };
  ok(
    "25 racing commits: every grant is counted (no CAS lost updates)",
    granted === state.commits && granted > 0,
    `granted ${granted}, counted ${state.commits}`,
  );
}

// ---------- reset cooldown + daily cap ----------
{
  const store = new FakeStore();
  const g = createGuard(store);
  ok("first reset is granted", (await g.takeReset(DAY1)).ok);
  const tooSoon = await g.takeReset(DAY1 + 60_000);
  ok("reset inside the cooldown is rejected", !tooSoon.ok && tooSoon.code === "RESET_COOLDOWN");
  ok("reset after the cooldown is granted", (await g.takeReset(DAY1 + LIMITS.resetCooldownMs)).ok);
  let t = DAY1 + LIMITS.resetCooldownMs;
  let granted = 2;
  while (granted < LIMITS.dailyResets) {
    t += LIMITS.resetCooldownMs;
    if ((await g.takeReset(t)).ok) granted++;
  }
  const overCap = await g.takeReset(t + LIMITS.resetCooldownMs);
  ok("reset over the daily cap is rejected", !overCap.ok && overCap.code === "DAILY_RESET_BUDGET");
  ok("resets restart next day", (await g.takeReset(DAY2)).ok);
}

// ---------- stress single-flight lease ----------
{
  const store = new FakeStore();
  const g = createGuard(store);
  ok("stress lease is granted when free", (await g.takeStress(DAY1)).ok);
  const second = await g.takeStress(DAY1 + 1000);
  ok("second run while leased is rejected", !second.ok && second.code === "STRESS_BUSY");
  await g.releaseStress(DAY1 + 5000);
  ok("release frees the lease", (await g.takeStress(DAY1 + 6000)).ok);
  const abandoned = await g.takeStress(DAY1 + 6000 + LIMITS.stressLeaseMs + 1);
  ok("abandoned lease expires on its own", abandoned.ok);
  let granted = 3;
  let t = DAY1 + 6000 + LIMITS.stressLeaseMs + 1;
  while (granted < LIMITS.dailyStressRuns) {
    await g.releaseStress(t);
    t += 1000;
    if ((await g.takeStress(t)).ok) granted++;
  }
  await g.releaseStress(t + 1000);
  const overCap = await g.takeStress(t + 2000);
  ok("stress over the daily cap is rejected", !overCap.ok && overCap.code === "DAILY_STRESS_BUDGET");
}

// ---------- fail closed ----------
{
  const store = new FakeStore();
  store.alwaysConflict = true;
  const g = createGuard(store);
  const verdict = await g.takeCommit(DAY1);
  ok("permanent CAS contention fails closed", !verdict.ok && verdict.code === "GUARD_BUSY");
}
{
  const store = new FakeStore();
  store.failReads = true;
  const g = createGuard(store);
  const verdict = await g.takeCommit(DAY1);
  ok("store errors fail closed", !verdict.ok && verdict.code === "GUARD_BUSY");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
