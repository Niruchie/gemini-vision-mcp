import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchUrl, errText } from "./_helpers.js";
import type { ToolContext } from "./types.js";

const mediaType = z.enum(["text", "image", "audio", "video"]);

async function describeResource(
  ctx: ToolContext,
  _type: string,
  prompt: string,
  resource: string,
  compact: boolean,
): Promise<string> {
  ctx.checkApiKey();
  await ctx.checkRate();
  return ctx.lock.runExclusive(async () => {
    const img = await fetchUrl(resource);
    return ctx.getGemini().describeImage(img.data, img.mime_type, prompt, 30, compact);
  });
}

export function register(mcp: McpServer, ctx: ToolContext): void {
  const inputSchema = {
    type: mediaType.describe("Media category - text, image, audio, or video."),
    prompt: z.string().describe("Instructions to the model (what to describe/extract)."),
    resource: z.string().describe("URL to fetch."),
    compact: z
      .boolean()
      .optional()
      .describe("If true, compact history and reconnect after this request."),
  };

  mcp.registerTool(
    "vision_from_resource",
    {
      description: "Describe a URL resource using Gemini.",
      inputSchema,
    },
    async ({ type, prompt, resource, compact }) => {
      try {
        const text = await describeResource(ctx, type, prompt, resource, compact ?? false);
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        console.error(`vision_from_resource failed: ${e}`);
        return { content: [{ type: "text" as const, text: errText(e) }] };
      }
    },
  );

  mcp.registerTool(
    "from_resource",
    {
      description: "Alias for vision_from_resource - describe a URL using Gemini.",
      inputSchema,
    },
    async ({ type, prompt, resource, compact }) => {
      try {
        const text = await describeResource(ctx, type, prompt, resource, compact ?? false);
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        console.error(`from_resource failed: ${e}`);
        return { content: [{ type: "text" as const, text: errText(e) }] };
      }
    },
  );
}
