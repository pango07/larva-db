import { agentPrompt } from "@/app/lib/agent-prompt";

export const dynamic = "force-static";

export async function GET() {
  return new Response(agentPrompt(), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
