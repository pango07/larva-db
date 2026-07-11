/**
 * CLI smoke test: drives the actual `larva` command (src/cli.ts, the same
 * code that ships as the npm bin) as a subprocess against a throwaway prefix
 * on the real Blob store — arguments, exit codes, stdout, files on disk.
 *
 *   bun scripts/cli-smoke.ts
 */
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { larva, ulid } from "@larva-db/core";

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? ` — ${detail}` : ""}`);
};

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN is not set. Run: vercel env pull .env.local");
  process.exit(1);
}

const CLI = path.resolve("packages/larvadb/src/cli.ts");
const workDir = mkdtempSync(path.join(tmpdir(), "larva-cli-"));
const prefix = `clitest/${ulid()}/`;
console.log(`database at ${prefix}, files in ${workDir}`);

function run(...args: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["bun", CLI, ...args, "--prefix", prefix], {
    cwd: workDir,
    env: { ...process.env },
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

// help + argument handling
const help = Bun.spawnSync(["bun", CLI, "--help"], { cwd: workDir, env: { ...process.env } });
ok("--help prints usage and exits 0", help.exitCode === 0 && help.stdout.toString().includes("usage: larva"));
const unknown = run("frobnicate");
ok("unknown command fails loudly", unknown.code === 1 && unknown.err.includes("--help"), unknown.err);

// create + insert + select through the CLI (schemaless store; CREATE TABLE is the schema)
ok("sql: CREATE TABLE", run("sql", "CREATE TABLE notes (id text PRIMARY KEY, body text, score integer)").code === 0);
const ins = run("sql", "INSERT INTO notes (id, body, score) VALUES ('a', 'hello from the CLI', 1), ('b', 'second', 2) RETURNING id");
ok("sql: INSERT RETURNING prints rows", ins.code === 0 && ins.out.includes("2 rows"), ins.out + ins.err);
const sel = run("sql", "SELECT id, body FROM notes ORDER BY id");
ok("sql: SELECT prints a table", sel.code === 0 && sel.out.includes("hello from the CLI"), sel.out + sel.err);

// guardrails surface through the CLI
const noWhere = run("sql", "UPDATE notes SET score = 0");
ok("sql: UPDATE without WHERE is rejected, hint uses the CLI flag", noWhere.code === 1 && noWhere.err.includes("add --allow-full-table"), noWhere.err);
ok("sql: --allow-full-table permits it", run("sql", "UPDATE notes SET score = 0", "--allow-full-table").code === 0);
const badSql = run("sql", "SELECT SUM(score) OVER () FROM notes");
ok("sql: agent-grade error on stderr", badSql.code === 1 && badSql.err.includes("window"), badSql.err);

// exports land on disk
const pg = run("export", "--format", "postgres", "--out", "out.sql");
const pgFile = existsSync(path.join(workDir, "out.sql")) ? readFileSync(path.join(workDir, "out.sql"), "utf8") : "";
ok("export postgres: pg_dump-shaped file", pg.code === 0 && pgFile.startsWith("-- Larva export") && pgFile.includes("COPY"), pg.err);
const js = run("export", "--format", "json");
const jsonFile = path.join(workDir, "larva-export.json");
ok(
  "export json: default filename, parses, has the rows",
  js.code === 0 && existsSync(jsonFile) && (JSON.parse(readFileSync(jsonFile, "utf8")) as { notes: unknown[] }).notes.length === 2,
  js.err,
);
const csv = run("export", "--format", "csv");
ok("export csv: one file per table", csv.code === 0 && existsSync(path.join(workDir, "larva-export-notes.csv")), csv.err);
ok("export without --format fails loudly", run("export").code === 1);

// version / upgrade / rollback / vacuum
const v1 = run("version");
const versionBefore = Number(v1.out.trim());
ok("version prints an integer", v1.code === 0 && Number.isInteger(versionBefore), v1.out);
const up = run("upgrade");
ok("upgrade flips to the top format", up.code === 0 && up.out.includes("format 4"), up.out + up.err);
ok("upgrade is idempotent", run("upgrade").code === 0);
ok("sql: writes work after upgrade (log mode)", run("sql", "INSERT INTO notes (id, body, score) VALUES ('c', 'post-upgrade', 3)").code === 0);
const preRollback = Number(run("version").out.trim());
const rb = run("rollback", String(preRollback - 1));
ok("rollback restores a past version", rb.code === 0 && rb.out.includes("restored"), rb.out + rb.err);
const afterRb = run("sql", "SELECT COUNT(*) AS n FROM notes");
ok("rollback took effect", afterRb.code === 0 && afterRb.out.includes("1 row"), afterRb.out);
const vac = run("vacuum", "--retain-versions", "5");
ok("vacuum reports retention", vac.code === 0 && vac.out.includes("versions retained"), vac.out + vac.err);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed === 0) await larva({ prefix }).destroy();
else console.log(`keeping ${prefix} for inspection`);
process.exit(failed === 0 ? 0 : 1);
