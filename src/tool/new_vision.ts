import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./types.js";
import { errText } from "./_helpers.js";

export function register(mcp: McpServer, ctx: ToolContext): void {
  mcp.registerTool(
    "new_vision",
    {
      description:
        "Force a fresh Gemini Live session.\n\nCall this to reset the connection if it's stale or returns errors. Existing conversation history is lost.",
    },
    async () => {
      try {
        ctx.checkApiKey();
        await ctx.resetGemini();
        return {
          content: [
            {
              type: "text" as const,
              text: "Session reset. Call any vision tool to start a fresh session.",
            },
          ],
        };
      } catch (e) {
        console.error(`new_vision failed: ${e}`);
        return { content: [{ type: "text" as const, text: errText(e) }] };
      }
    },
  );
}
