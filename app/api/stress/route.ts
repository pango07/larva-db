import { NextRequest, NextResponse } from "next/server";
import { runStress, StressConfig } from "@larva-db/core/testing";
import { clientIp, crossOrigin, guard, rateLimit } from "@/app/lib/guard";

export const maxDuration = 300;

// Keep web-triggered runs comfortably inside the function time limit.
const CAPS = { writers: 20, commitsPerWriter: 30, rowsPerCommit: 100 } as const;

export async function POST(req: NextRequest) {
  // A stress run is the most expensive request in the app — hundreds of
  // commits of blob ops for one cheap POST. Burst-limit per IP, refuse
  // foreign browser origins, then take the global single-flight lease (one
  // run at a time, bounded per day, shared across instances).
  if (!rateLimit("stress", clientIp(req), 3)) {
    return NextResponse.json(
      { error: "too many stress requests from your address — runs go one at a time anyway" },
      { status: 429 },
    );
  }
  if (crossOrigin(req)) {
    return NextResponse.json(
      { error: "stress runs are not accepted from other origins" },
      { status: 403 },
    );
  }
  const lease = await guard.takeStress();
  if (!lease.ok) return NextResponse.json({ error: lease.message }, { status: 429 });

  const body = (await req.json().catch(() => ({}))) as Partial<StressConfig>;
  const config: Partial<StressConfig> = {
    writers: Math.min(Math.max(1, body.writers ?? 10), CAPS.writers),
    commitsPerWriter: Math.min(Math.max(1, body.commitsPerWriter ?? 10), CAPS.commitsPerWriter),
    rowsPerCommit: Math.min(Math.max(1, body.rowsPerCommit ?? 5), CAPS.rowsPerCommit),
    mode: body.mode ?? "mixed",
    maxAttempts: Math.min(Math.max(1, body.maxAttempts ?? 50), 100),
    // Never caller-controlled: a public endpoint that can leave 60k rows of
    // blobs per call is a storage-bill grief vector. Failed runs still keep
    // their blobs for inspection; /api/demo-reset sweeps those.
    cleanup: true,
  };
  try {
    const report = await runStress(config);
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  } finally {
    await guard.releaseStress();
  }
}
