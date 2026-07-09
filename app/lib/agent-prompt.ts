import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The canonical agent prompt lives in docs/larva-for-agents.md (one source
 * of truth for the repo, /docs, and /llms.txt). The path is a static literal
 * so Vercel's file tracing bundles it with the functions that read it.
 */
export function agentPrompt(): string {
  const raw = readFileSync(path.join(process.cwd(), "docs", "larva-for-agents.md"), "utf8");
  return raw.replace(/^<!--[\s\S]*?-->\s*/, ""); // drop the HTML comment header
}
