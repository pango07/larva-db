import { NextRequest, NextResponse } from "next/server";
import { SqlError } from "@larva-db/core";
import { demoDb } from "@/app/lib/demo";

export const maxDuration = 60;

/**
 * Read-only physical layout of the demo store at one version (db.inspect,
 * Design §13): per-table chunk lists with zone-map min/max. Powers the
 * viewer's internals panel and version scrubber. `?version=N` time-travels;
 * `currentVersion` is always returned so the scrubber knows its upper bound.
 */
export async function GET(req: NextRequest) {
  const versionParam = req.nextUrl.searchParams.get("version");
  try {
    const db = await demoDb();
    let version: number | undefined;
    if (versionParam !== null) {
      version = Number(versionParam);
      if (!Number.isInteger(version) || version < 0) {
        return NextResponse.json({ error: { code: "BAD_VERSION", message: "version must be a non-negative integer" } }, { status: 400 });
      }
    }
    const currentVersion = await db.currentVersion();
    const layout = await db.inspect(version);
    return NextResponse.json({ ...layout, currentVersion });
  } catch (err) {
    if (err instanceof SqlError) {
      const status = err.code === "VERSION_NOT_FOUND" ? 404 : 400;
      return NextResponse.json({ error: { code: err.code, message: err.message } }, { status });
    }
    return NextResponse.json({ error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) } }, { status: 500 });
  }
}
