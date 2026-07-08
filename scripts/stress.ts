/**
 * Commit-protocol stress test: concurrent writers hammer one Larva database
 * on a real Vercel Blob store; asserts zero lost updates.
 *
 *   bun scripts/stress.ts --writers 10 --commits 20 --mode mixed
 *
 * Requires BLOB_READ_WRITE_TOKEN (bun auto-loads .env.local).
 */
import { runStress, DEFAULTS, StressConfig } from "../lib/larva/stress";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN is not set. Run: vercel env pull .env.local");
  process.exit(1);
}

const mode = (arg("mode") ?? DEFAULTS.mode) as StressConfig["mode"];
if (!["append", "counter", "mixed"].includes(mode)) {
  console.error(`invalid --mode ${mode}`);
  process.exit(1);
}

const config: Partial<StressConfig> = {
  writers: Number(arg("writers") ?? DEFAULTS.writers),
  commitsPerWriter: Number(arg("commits") ?? DEFAULTS.commitsPerWriter),
  rowsPerCommit: Number(arg("rows") ?? DEFAULTS.rowsPerCommit),
  maxAttempts: Number(arg("max-attempts") ?? DEFAULTS.maxAttempts),
  mode,
  cleanup: !process.argv.includes("--keep"),
};

console.log("larva commit-protocol stress test");
console.log(config);

const report = await runStress(config, (msg) => console.log(`  ${msg}`));

console.log("\n--- checks ---");
for (const c of report.checks) {
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
}
console.log("\n--- commits ---");
console.log(report.commits);
console.log("--- contention ---");
console.log(report.contention);
console.log(
  `\n${report.durationMs} ms, ${report.commitsPerSec} commits/sec, run ${report.runId}`,
);
if (report.errors.length > 0) console.log("loud failures:", report.errors);

console.log(report.pass ? "\n✅ ZERO LOST UPDATES" : "\n❌ CORRECTNESS FAILURE");
process.exit(report.pass ? 0 : 1);
