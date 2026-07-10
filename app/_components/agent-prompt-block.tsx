import { agentPrompt } from "@/app/lib/agent-prompt";

/** The canonical agent prompt (docs/larva-for-agents.md), rendered in the docs
 * site as one copyable block — single source with /llms.txt, never forked. */
export function AgentPromptBlock() {
  return (
    <pre
      style={{ whiteSpace: "pre-wrap", maxHeight: "28rem", overflow: "auto" }}
      className="x:my-4 x:rounded-md x:border x:p-4 x:text-xs"
    >
      {agentPrompt()}
    </pre>
  );
}
