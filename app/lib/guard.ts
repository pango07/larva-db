import type { NextRequest } from "next/server";
import { CasConflictError, VercelBlobAdapter, type StorageAdapter } from "@larva-db/core";

/**
 * Abuse guards for the public demo endpoints. The write budget in demo.ts
 * bounds *storage between resets*; these bound *operations over time* — the
 * dimension a reset can't launder. Three layers:
 *
 *   1. Per-IP sliding windows (in-memory, per instance) absorb bursts for free.
 *      Fluid Compute reuses instances, so this catches most hammering, but an
 *      attacker can spread across instances — hence layer 3.
 *   2. Cross-origin refusal on mutations: other sites can't farm our endpoints
 *      out to their visitors' browsers.
 *   3. Durable global daily budgets in one tiny guard blob, updated with the
 *      same CAS the commit protocol uses. Contention or store trouble fails
 *      CLOSED for guarded (i.e. expensive) actions.
 */

// ---------- layer 1: per-IP sliding windows ----------

const WINDOW_MS = 60_000;
const windows = new Map<string, number[]>();

export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

/** True if this hit is allowed; false = rate the caller limited. */
export function rateLimit(bucket: string, ip: string, perMinute: number, now = Date.now()): boolean {
  if (windows.size > 10_000) {
    for (const [k, hits] of windows) {
      if ((hits[hits.length - 1] ?? 0) < now - WINDOW_MS) windows.delete(k);
    }
  }
  const key = `${bucket}:${ip}`;
  const hits = (windows.get(key) ?? []).filter((t) => t > now - WINDOW_MS);
  windows.set(key, hits);
  if (hits.length >= perMinute) return false;
  hits.push(now);
  return true;
}

// ---------- layer 2: same-origin check for mutations ----------

/** True when a browser sent the request from a foreign origin. Requests with
 * no Origin header (curl, agents) pass — layers 1 and 3 still apply to them. */
export function crossOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.get("host");
  } catch {
    return true;
  }
}

// ---------- layer 3: durable global daily budgets ----------

export const LIMITS = {
  /** Console write commits per UTC day, across all resets. With the 5,000-char
   * statement cap and the 2,000-row table ceiling this bounds daily blob churn
   * to single-digit GB even for a worst-case pathological writer. */
  dailyCommits: 600,
  /** Reset is the janitor, not a budget laundry: cooldown + daily cap. */
  dailyResets: 24,
  resetCooldownMs: 5 * 60_000,
  /** Stress runs are the most expensive request in the app (~600 commits of
   * blob ops each): one at a time, bounded per day. */
  dailyStressRuns: 30,
  stressLeaseMs: 6 * 60_000,
} as const;

interface GuardState {
  day: string; // UTC date the counters cover
  commits: number;
  resets: number;
  stressRuns: number;
  lastResetAt: number; // epoch ms
  stressLeaseUntil: number; // epoch ms — single-flight lease
}

export type GuardVerdict = { ok: true } | { ok: false; code: string; message: string };

const FRESH: GuardState = {
  day: "",
  commits: 0,
  resets: 0,
  stressRuns: 0,
  lastResetAt: 0,
  stressLeaseUntil: 0,
};

export function createGuard(store: StorageAdapter, path = "demo/guard/state.json") {
  /** Read → check/mutate → CAS-write, with retries. `fn` returns a rejection
   * verdict or null (= allowed, state mutated in place). Anything that stops
   * the state from advancing — contention, store errors — fails closed. */
  async function mutate(
    fn: (s: GuardState, now: number) => GuardVerdict | null,
    now = Date.now(),
  ): Promise<GuardVerdict> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const got = await store.get(path, { fresh: true });
        const state: GuardState = got ? (JSON.parse(got.body) as GuardState) : { ...FRESH };
        const day = new Date(now).toISOString().slice(0, 10);
        if (state.day !== day) {
          state.day = day;
          state.commits = 0;
          state.resets = 0;
          state.stressRuns = 0;
        }
        const rejected = fn(state, now);
        if (rejected) return rejected;
        await store.put(
          path,
          JSON.stringify(state),
          got ? { ifMatch: got.etag } : { createOnly: true },
        );
        return { ok: true };
      } catch (err) {
        if (err instanceof CasConflictError) {
          await new Promise((r) => setTimeout(r, Math.random() * 100 * (attempt + 1)));
          continue;
        }
        break; // store trouble → fail closed below
      }
    }
    return {
      ok: false,
      code: "GUARD_BUSY",
      message: "the demo is under heavy load — try again in a few seconds",
    };
  }

  return {
    /** One console write commit. */
    takeCommit: (now?: number) =>
      mutate(
        (s) =>
          s.commits >= LIMITS.dailyCommits
            ? {
                ok: false,
                code: "DAILY_WRITE_BUDGET",
                message: `the public demo has used its ${LIMITS.dailyCommits} write commits for today (UTC) — reads still work, or clone the repo and bring your own store`,
              }
            : ((s.commits++), null),
        now,
      ),
    /** One demo reset (destroy + reseed + sweep). */
    takeReset: (now?: number) =>
      mutate((s, t) => {
        const wait = s.lastResetAt + LIMITS.resetCooldownMs - t;
        if (wait > 0) {
          return {
            ok: false,
            code: "RESET_COOLDOWN",
            message: `the demo was reset ${Math.round((t - s.lastResetAt) / 1000)}s ago — try again in ${Math.ceil(wait / 1000)}s`,
          };
        }
        if (s.resets >= LIMITS.dailyResets) {
          return {
            ok: false,
            code: "DAILY_RESET_BUDGET",
            message: `the demo has been reset ${LIMITS.dailyResets} times today (UTC) — that's the daily cap`,
          };
        }
        s.resets++;
        s.lastResetAt = t;
        return null;
      }, now),
    /** Acquire the single-flight stress lease. Release when the run ends;
     * abandoned leases expire on their own. */
    takeStress: (now?: number) =>
      mutate((s, t) => {
        if (t < s.stressLeaseUntil) {
          return {
            ok: false,
            code: "STRESS_BUSY",
            message: `a stress run is already in flight (lease expires in ${Math.ceil((s.stressLeaseUntil - t) / 1000)}s) — one at a time keeps the blob bill honest`,
          };
        }
        if (s.stressRuns >= LIMITS.dailyStressRuns) {
          return {
            ok: false,
            code: "DAILY_STRESS_BUDGET",
            message: `the lab has run ${LIMITS.dailyStressRuns} stress tests today (UTC) — that's the daily cap; the harness also ships in the package: import { runStress } from "@larva-db/core/testing"`,
          };
        }
        s.stressRuns++;
        s.stressLeaseUntil = t + LIMITS.stressLeaseMs;
        return null;
      }, now),
    releaseStress: (now?: number) => mutate((s) => ((s.stressLeaseUntil = 0), null), now),
  };
}

/** The production guard, on the same adapter the commit protocol trusts. */
export const guard = createGuard(new VercelBlobAdapter());
