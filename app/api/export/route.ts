import { NextRequest, NextResponse } from "next/server";
import { demoDb } from "@/app/lib/demo";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const format = req.nextUrl.searchParams.get("format") ?? "json";
  const db = await demoDb();

  if (format === "json") {
    const tables = await db.export({ format: "json" });
    return new NextResponse(JSON.stringify(tables, null, 2), {
      headers: {
        "content-type": "application/json",
        "content-disposition": 'attachment; filename="larva-demo.json"',
      },
    });
  }
  if (format === "csv") {
    const table = req.nextUrl.searchParams.get("table") ?? "";
    const tables = await db.export({ format: "csv" });
    if (!(table in tables)) {
      return NextResponse.json(
        { error: { code: "UNKNOWN_TABLE", message: `pick a table: ${Object.keys(tables).join(", ")}` } },
        { status: 400 },
      );
    }
    return new NextResponse(tables[table], {
      headers: {
        "content-type": "text/csv",
        "content-disposition": `attachment; filename="${table}.csv"`,
      },
    });
  }
  if (format === "postgres") {
    const sql = await db.export({ format: "postgres" });
    return new NextResponse(sql, {
      headers: {
        "content-type": "application/sql",
        "content-disposition": 'attachment; filename="larva-demo.sql"',
      },
    });
  }
  return NextResponse.json(
    { error: { code: "UNKNOWN_FORMAT", message: "format must be json, csv, or postgres (sqlite export runs via the CLI: bun scripts/api-smoke.ts shows how)" } },
    { status: 400 },
  );
}
