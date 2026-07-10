import { NextResponse } from "next/server";
import { del, list } from "@vercel/blob";
import { demoDb, resetDemo } from "@/app/lib/demo";

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

export async function POST() {
  await resetDemo();
  const swept = await sweepHarnessLeftovers().catch(() => 0);
  const db = await demoDb();
  return NextResponse.json({ ok: true, version: await db.currentVersion(), swept });
}
