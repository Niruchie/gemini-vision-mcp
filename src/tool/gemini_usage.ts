import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./types.js";
import { errText } from "./_helpers.js";

export function register(mcp: McpServer, ctx: ToolContext): void {
  mcp.registerTool(
    "gemini_usage",
    {
      description:
        "Get current Gemini API usage statistics.\n\nReturns token usage stats including input/output tokens and rate limit status.",
    },
    async () => {
      try {
        ctx.checkApiKey();
        const gemini = ctx.getGemini();
        if (!gemini) return { content: [{ type: "text" as const, text: "No active session" }] };
        const text = JSON.stringify(gemini.usage.toDict(), null, 2);
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        console.error(`gemini_usage failed: ${e}`);
        return { content: [{ type: "text" as const, text: errText(e) }] };
      }
    },
  );
}
