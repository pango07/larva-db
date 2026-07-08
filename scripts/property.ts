/**
 * Property-based conflict test: concurrent random workloads (insert/update/
 * delete own rows + shared hot-row RMW) verified against a sequential model.
 *
 *   bun scripts/property.ts --writers 8 --ops 25
 */
import { PROPERTY_DEFAULTS, runProperty } from "@larva-db/core/testing";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN is not set. Run: vercel env pull .env.local");
  process.exit(1);
}

const config = {
  writers: Number(arg("writers") ?? PROPERTY_DEFAULTS.writers),
  opsPerWriter: Number(arg("ops") ?? PROPERTY_DEFAULTS.opsPerWriter),
  maxAttempts: Number(arg("max-attempts") ?? PROPERTY_DEFAULTS.maxAttempts),
  cleanup: !process.argv.includes("--keep"),
};

console.log("larva property-based conflict test");
console.log(config);

const report = await runProperty(config, (msg) => console.log(`  ${msg}`));

console.log("\n--- checks ---");
for (const c of report.checks) {
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
}
console.log("\nops:", report.ops, "\noutcomes:", report.outcomes);
console.log(`${report.durationMs} ms, ${report.commitsPerSec} commits/sec, run ${report.runId}`);
console.log(report.pass ? "\n✅ MODEL HOLDS" : "\n❌ MODEL VIOLATION");
process.exit(report.pass ? 0 : 1);
