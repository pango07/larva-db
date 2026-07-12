import { NextRequest, NextResponse } from "next/server";
import { parse, SchemaError, SqlError } from "@larva-db/core";
import { demoDb, WRITE_BUDGET } from "@/app/lib/demo";
import { clientIp, crossOrigin, guard, rateLimit } from "@/app/lib/guard";

export const maxDuration = 60;

/** The public console runs plain DML only. DDL is blocked not because it's
 * dangerous to the data (it's a demo) but because it's an op amplifier:
 * CREATE INDEX backfills index blobs and re-stages them on every later
 * commit, CREATE TABLE grows the manifest forever, sequences burn CAS
 * ranges. The full dialect is one `git clone` away. */
const ALLOWED_KINDS = new Set(["select", "insert", "update", "delete"]);

/** Storage ceilings: rows per INSERT and rows per table. Together with the
 * 5,000-char statement cap and the daily commit budget these bound worst-case
 * blob churn no matter what the console is fed. */
const MAX_INSERT_ROWS = 50;
const MAX_TABLE_ROWS = 2000;

const err = (code: string, message: string, status: number) =>
  NextResponse.json({ error: { code, message } }, { status });

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  if (!rateLimit("sql", ip, 60)) {
    return err("RATE_LIMITED", "too many queries from your address — slow down a little", 429);
  }

  const body = (await req.json().catch(() => ({}))) as { sql?: string; allowFullTable?: boolean };
  const sql = body.sql?.trim();
  if (!sql) return err("EMPTY", "no SQL provided", 400);
  if (sql.length > 5000) return err("TOO_LONG", "query too long for the demo console", 400);

  try {
    const stmt = parse(sql);
    const isWrite = stmt.kind !== "select";

    if (isWrite) {
      if (crossOrigin(req)) {
        return err("FORBIDDEN", "writes are not accepted from other origins", 403);
      }
      if (!rateLimit("sql-write", ip, 15)) {
        return err("RATE_LIMITED", "too many writes from your address — slow down a little", 429);
      }
      if (!ALLOWED_KINDS.has(stmt.kind)) {
        return err(
          "DEMO_STATEMENT_BLOCKED",
          "the public console runs SELECT, INSERT, UPDATE, and DELETE only — schema statements (CREATE, ALTER, DROP, CREATE INDEX) are disabled here to keep the demo's storage bill honest; clone the repo and bring your own store for the full dialect",
          403,
        );
      }
      if (stmt.kind === "insert" && stmt.rows.length > MAX_INSERT_ROWS) {
        return err(
          "DEMO_ROW_CAP",
          `the demo caps INSERT at ${MAX_INSERT_ROWS} rows per statement (got ${stmt.rows.length})`,
          400,
        );
      }
    }

    const db = await demoDb();

    if (isWrite) {
      // Table ceiling — checked from manifest stats only, no chunk reads.
      if (stmt.kind === "insert") {
        const inspection = await db.inspect();
        const current = inspection.tables[stmt.table]?.rowCount ?? 0;
        if (current + stmt.rows.length > MAX_TABLE_ROWS) {
          return err(
            "DEMO_TABLE_FULL",
            `"${stmt.table}" holds ${current} rows and the demo caps tables at ${MAX_TABLE_ROWS} — hit "Reset demo data" to start fresh`,
            429,
          );
        }
      }
      // Per-reset budget: version × 5,000-char statements bounds storage
      // between resets.
      const version = await db.currentVersion();
      if (version >= WRITE_BUDGET) {
        return err(
          "WRITE_BUDGET_EXHAUSTED",
          `the demo database has taken ${version} write commits since its last reset (budget: ${WRITE_BUDGET}) — hit "Reset demo data" to keep writing`,
          429,
        );
      }
      // Global daily budget: durable, shared across instances, and NOT
      // restarted by reset — the ceiling a reset loop can't launder.
      const gate = await guard.takeCommit();
      if (!gate.ok) return err(gate.code, gate.message, 429);
    }

    const started = Date.now();
    const rows = await db.query(sql, [], { allowFullTable: body.allowFullTable });
    const ms = Date.now() - started;
    return NextResponse.json({ rows, ms, stats: db.lastQueryStats, version: await db.currentVersion() });
  } catch (e) {
    if (e instanceof SqlError || e instanceof SchemaError) {
      return err(e.code, e.message, 400);
    }
    return err("INTERNAL", e instanceof Error ? e.message : String(e), 500);
  }
}
