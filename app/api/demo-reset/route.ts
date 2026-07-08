import { NextResponse } from "next/server";
import { demoDb, resetDemo } from "@/app/lib/demo";

export const maxDuration = 60;

export async function POST() {
  await resetDemo();
  const db = await demoDb();
  return NextResponse.json({ ok: true, version: await db.currentVersion() });
}
