import { NextRequest, NextResponse } from "next/server";
import { SqlError } from "@larva-db/core";
import { demoDb, demoSchema } from "@/app/lib/demo";
import { tableMeta } from "@/app/lib/viewer";

export const maxDuration = 60;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

/**
 * A page of rows from one demo table, optionally at a past version (time
 * travel via asOf). Read-only. Table and sort column are whitelisted against
 * the code-first schema, and page bounds are coerced to integers, so the only
 * thing interpolated into SQL are validated identifiers — no user values reach
 * the query string (and the parser rejects statement stacking regardless).
 * Returns the fetch's pruning stats (chunks scanned vs. total) so the UI can
 * show the zone maps doing their job.
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const table = p.get("table") ?? "";
  const spec = demoSchema[table];
  if (!spec) {
    return NextResponse.json(
      { error: { code: "UNKNOWN_TABLE", message: `pick a table: ${Object.keys(demoSchema).join(", ")}` } },
      { status: 400 },
    );
  }
  const columns = Object.keys(spec.columns);
  const orderByParam = p.get("orderBy");
  const orderBy = orderByParam && columns.includes(orderByParam) ? orderByParam : spec.primaryKey;
  const dir = p.get("dir") === "desc" ? "DESC" : "ASC";
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.trunc(Number(p.get("limit"))) || DEFAULT_PAGE));
  const offset = Math.max(0, Math.trunc(Number(p.get("offset"))) || 0);
  const versionParam = p.get("version");

  try {
    const db = await demoDb();
    const currentVersion = await db.currentVersion();
    const wantsPast = versionParam !== null && Number(versionParam) !== currentVersion;
    if (versionParam !== null && !Number.isInteger(Number(versionParam))) {
      return NextResponse.json({ error: { code: "BAD_VERSION", message: "version must be an integer" } }, { status: 400 });
    }
    const version = wantsPast ? Number(versionParam) : currentVersion;
    const src = wantsPast ? await db.asOf(version) : db;

    const rows = await src.query(`SELECT * FROM ${table} ORDER BY ${orderBy} ${dir} LIMIT ${limit} OFFSET ${offset}`);
    const stats = db.lastQueryStats; // capture before the COUNT query overwrites it
    const [{ n }] = await src.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);

    return NextResponse.json({
      table,
      ...tableMeta(table)!,
      rows,
      total: Number(n),
      limit,
      offset,
      orderBy,
      dir: dir.toLowerCase(),
      version,
      isCurrent: !wantsPast,
      stats,
    });
  } catch (err) {
    if (err instanceof SqlError) {
      const status = err.code === "VERSION_NOT_FOUND" ? 404 : 400;
      return NextResponse.json({ error: { code: err.code, message: err.message } }, { status });
    }
    return NextResponse.json({ error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) } }, { status: 500 });
  }
}
