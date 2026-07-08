import { NextRequest, NextResponse } from "next/server";
import { SchemaError, SqlError } from "@larva-db/core";
import { demoDb } from "@/app/lib/demo";

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
