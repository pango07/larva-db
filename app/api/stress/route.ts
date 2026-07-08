import { NextRequest, NextResponse } from "next/server";
import { runStress, StressConfig } from "@larva-db/core/testing";

export const maxDuration = 300;

// Keep web-triggered runs comfortably inside the function time limit.
const CAPS = { writers: 20, commitsPerWriter: 30, rowsPerCommit: 100 } as const;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Partial<StressConfig>;
  const config: Partial<StressConfig> = {
    writers: Math.min(Math.max(1, body.writers ?? 10), CAPS.writers),
    commitsPerWriter: Math.min(Math.max(1, body.commitsPerWriter ?? 10), CAPS.commitsPerWriter),
    rowsPerCommit: Math.min(Math.max(1, body.rowsPerCommit ?? 5), CAPS.rowsPerCommit),
    mode: body.mode ?? "mixed",
    maxAttempts: Math.min(Math.max(1, body.maxAttempts ?? 50), 100),
    cleanup: body.cleanup ?? true,
  };
  try {
    const report = await runStress(config);
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
