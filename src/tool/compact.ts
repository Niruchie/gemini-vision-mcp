import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./types.js";
import { errText } from "./_helpers.js";

export function register(mcp: McpServer, ctx: ToolContext): void {
  mcp.registerTool(
    "compact",
    {
      description:
        "Compact conversation history and reconnect.\n\nSummarizes older turns, keeps recent ones verbatim, and replays into a fresh Gemini Live session so context carries over. Use instead of new_vision when you want to preserve context.",
    },
    async () => {
      try {
        ctx.checkApiKey();
        await ctx.acquireRate();
        const gemini = ctx.getGemini();
        if (!gemini) return { content: [{ type: "text" as const, text: "No active session" }] };
        const text = await gemini.compact();
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        console.error(`compact failed: ${e}`);
        return { content: [{ type: "text" as const, text: errText(e) }] };
      }
    },
  );
}
