import { NextRequest, NextResponse } from "next/server";
import { parse, SchemaError, SqlError } from "@larva-db/core";
import { demoDb, WRITE_BUDGET } from "@/app/lib/demo";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { sql?: string; allowFullTable?: boolean };
  const sql = body.sql?.trim();
  if (!sql) return NextResponse.json({ error: { code: "EMPTY", message: "no SQL provided" } }, { status: 400 });
  if (sql.length > 5000) {
    return NextResponse.json({ error: { code: "TOO_LONG", message: "query too long for the demo console" } }, { status: 400 });
  }
  try {
    const db = await demoDb();
    // Write budget: every commit bumps the version, and a statement is capped
    // at 5,000 chars, so version × statement size bounds what this public demo
    // can ever put in the blob store. Reads stay free; reset restarts the budget.
    if (parse(sql).kind !== "select") {
      const version = await db.currentVersion();
      if (version >= WRITE_BUDGET) {
        return NextResponse.json(
          {
            error: {
              code: "WRITE_BUDGET_EXHAUSTED",
              message: `the demo database has taken ${version} write commits since its last reset (budget: ${WRITE_BUDGET}) — hit "Reset demo data" to keep writing`,
            },
          },
          { status: 429 },
        );
      }
    }
    const started = Date.now();
    const rows = await db.query(sql, [], { allowFullTable: body.allowFullTable });
    const ms = Date.now() - started;
    return NextResponse.json({ rows, ms, stats: db.lastQueryStats, version: await db.currentVersion() });
  } catch (err) {
    if (err instanceof SqlError || err instanceof SchemaError) {
      return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: 400 });
    }
    return NextResponse.json(
      { error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) } },
      { status: 500 },
    );
  }
}
