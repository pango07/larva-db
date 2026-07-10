/**
 * The larva CLI — the Design §13 API surface, runnable from a shell:
 *
 *   npx larva sql "SELECT * FROM customers LIMIT 5"
 *   npx larva export --format postgres --out export.sql
 *   npx larva upgrade
 *   npx larva rollback 41
 *   npx larva vacuum --retain-days 7
 *   npx larva version
 *
 * Credentials come from BLOB_READ_WRITE_TOKEN; .env.local / .env in the
 * working directory are loaded automatically (Next.js does this for the app,
 * but nothing does it for a bare CLI). The store's embedded schema is
 * authoritative — no schema file needed.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

import { larva } from "./db";
import { ConflictError, FormatError } from "./core";
import { SchemaError } from "./schema";
import { SqlError } from "./sql/errors";

const HELP = `larva — a tiny SQL database inside your object store (@larva-db/core)

usage: larva <command> [options]

commands:
  sql "STATEMENT"       run one statement; rows print as a table
  export                write the whole database to a file
                          --format postgres|sqlite|json|csv (required)
                          --out FILE (default larva-export.<ext>; csv writes one file per table)
  upgrade               flip the store to format 3, the ordered commit log (one-way, atomic)
  rollback VERSION      restore a past version (itself a new, undoable commit)
  vacuum                reclaim storage outside retention
                          --retain-days N (default 7)  --retain-versions N (default 50)
  version               print the current database version

options:
  --prefix PATH         blob prefix the database lives under (default "larva/")
  --allow-full-table    permit UPDATE/DELETE without a WHERE clause
  -h, --help            this text

credentials: BLOB_READ_WRITE_TOKEN (auto-loaded from .env.local / .env in cwd)`;

function loadDotEnv(): void {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith("#")) continue;
      const value = m[2].replace(/^["']|["']$/g, "");
      process.env[m[1]] ??= value;
    }
  }
}

function fail(message: string): never {
  console.error(`larva: ${message}`);
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) fail(`--${name} needs a value`);
  args.splice(i, 2);
  return v;
}

function boolFlag(args: string[], name: string): boolean {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(HELP);
    return;
  }

  loadDotEnv();
  const prefix = flag(args, "prefix") ?? "larva/";
  const allowFullTable = boolFlag(args, "allow-full-table");
  const command = args.shift();

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    fail("BLOB_READ_WRITE_TOKEN is not set — run `vercel env pull .env.local` or export it");
  }
  const db = larva({ prefix });

  switch (command) {
    case "sql": {
      const statement = args.shift();
      if (!statement) fail('sql needs a statement: larva sql "SELECT * FROM t"');
      const started = Date.now();
      const rows = await db.query(statement, [], { allowFullTable });
      const ms = Date.now() - started;
      if (rows.length > 0) console.table(rows);
      const stats = db.lastQueryStats;
      console.log(
        `${rows.length} row${rows.length === 1 ? "" : "s"} in ${ms}ms` +
          (stats.chunksTotal > 0 ? ` — read ${stats.chunksFetched}/${stats.chunksTotal} chunks` : ""),
      );
      return;
    }

    case "export": {
      const format = flag(args, "format");
      if (format !== "postgres" && format !== "sqlite" && format !== "json" && format !== "csv") {
        fail("export needs --format postgres|sqlite|json|csv");
      }
      const defaults = { postgres: "larva-export.sql", sqlite: "larva-export.db", json: "larva-export.json", csv: "larva-export" };
      const out = flag(args, "out") ?? defaults[format];
      if (format === "csv") {
        const tables = await db.export({ format: "csv" });
        for (const [table, csv] of Object.entries(tables)) {
          const file = `${out.replace(/\.csv$/, "")}-${table}.csv`;
          writeFileSync(file, csv);
          console.log(`wrote ${file}`);
        }
        return;
      }
      if (format === "json") writeFileSync(out, JSON.stringify(await db.export({ format: "json" }), null, 2));
      else if (format === "sqlite") writeFileSync(out, await db.export({ format: "sqlite" }));
      else writeFileSync(out, await db.export({ format: "postgres" }));
      console.log(`wrote ${out}`);
      if (format === "postgres") console.log(`load it with:  psql $DATABASE_URL < ${out}`);
      return;
    }

    case "upgrade": {
      const result = await db.upgrade();
      console.log(`format ${result.formatVersion} (the ordered commit log), version ${result.version}`);
      return;
    }

    case "rollback": {
      const version = Number(args.shift());
      if (!Number.isInteger(version) || version < 0) fail("rollback needs a version number: larva rollback 41");
      const result = await db.rollbackTo(version);
      console.log(`restored v${version} as new version ${result.version} (undo with: larva rollback ${result.version - 1})`);
      return;
    }

    case "vacuum": {
      const retainDays = flag(args, "retain-days");
      const retainVersions = flag(args, "retain-versions");
      const report = await db.vacuum({
        ...(retainDays !== undefined ? { retainDays: Number(retainDays) } : {}),
        ...(retainVersions !== undefined ? { retainVersions: Number(retainVersions) } : {}),
      });
      console.log(
        `dropped ${report.historyDeleted} history object${report.historyDeleted === 1 ? "" : "s"} and ` +
          `${report.chunksDeleted} chunk${report.chunksDeleted === 1 ? "" : "s"}; ${report.retainedVersions} versions retained`,
      );
      return;
    }

    case "version": {
      console.log(await db.currentVersion());
      return;
    }

    default:
      fail(`unknown command "${command}" — run larva --help`);
  }
}

main().catch((err: unknown) => {
  if (err instanceof SqlError || err instanceof SchemaError || err instanceof FormatError || err instanceof ConflictError) {
    fail(err.message);
  }
  fail(err instanceof Error ? err.message : String(err));
});
