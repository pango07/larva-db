import { NextRequest, NextResponse } from "next/server";
import { del, list } from "@vercel/blob";
import { demoDb, resetDemo } from "@/app/lib/demo";
import { clientIp, crossOrigin, guard, rateLimit } from "@/app/lib/guard";

export const maxDuration = 60;

/** Failed stress/property runs keep their blobs for inspection — on a public
 * lab that inspection never happens, so the reset button is also the janitor. */
async function sweepHarnessLeftovers(): Promise<number> {
  let deleted = 0;
  for (const prefix of ["stress/", "property/"]) {
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor });
      if (page.blobs.length > 0) {
        await del(page.blobs.map((b) => b.url));
        deleted += page.blobs.length;
      }
      cursor = page.cursor;
    } while (cursor);
  }
  return deleted;
}

export async function POST(req: NextRequest) {
  // Reset restarts the per-reset write budget, so an unguarded reset is a
  // budget laundry: [burn 400 commits, reset, repeat] runs up blob operations
  // forever while storage stays innocent-looking. Cooldown + daily cap close
  // that loop; the daily commit budget in /api/sql is reset-proof regardless.
  if (!rateLimit("reset", clientIp(req), 2)) {
    return NextResponse.json(
      { error: { code: "RATE_LIMITED", message: "too many reset requests — give it a minute" } },
      { status: 429 },
    );
  }
  if (crossOrigin(req)) {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "resets are not accepted from other origins" } },
      { status: 403 },
    );
  }
  const gate = await guard.takeReset();
  if (!gate.ok) {
    return NextResponse.json({ error: { code: gate.code, message: gate.message } }, { status: 429 });
  }

  await resetDemo();
  const swept = await sweepHarnessLeftovers().catch(() => 0);
  const db = await demoDb();
  return NextResponse.json({ ok: true, version: await db.currentVersion(), swept });
}
