import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchUrl, errText } from "./_helpers.js";
import type { ToolContext } from "./types.js";

const mediaType = z.enum(["text", "image", "audio", "video"]);

async function describeResources(
  ctx: ToolContext,
  _type: string,
  prompt: string,
  resources: string[],
  compact: boolean,
): Promise<string> {
  ctx.checkApiKey();
  await ctx.checkRate();
  return ctx.lock.runExclusive(async () => {
    const images = [];
    for (const url of resources) {
      images.push(await fetchUrl(url));
    }
    return ctx.getGemini().describeImages(
      images.map((img) => ({ data: img.data, mimeType: img.mime_type })),
      prompt,
      45,
      compact,
    );
  });
}

export function register(mcp: McpServer, ctx: ToolContext): void {
  const inputSchema = {
    type: mediaType.describe("Media category - text, image, audio, or video."),
    prompt: z.string().describe("Instructions to the model (what to describe/extract)."),
    resources: z.array(z.string()).describe("List of URLs to fetch."),
    compact: z
      .boolean()
      .optional()
      .describe("If true, compact history and reconnect after this request."),
  };

  mcp.registerTool(
    "vision_from_resources",
    {
      description: "Describe multiple URL resources in one Gemini session.",
      inputSchema,
    },
    async ({ type, prompt, resources, compact }) => {
      try {
        const text = await describeResources(ctx, type, prompt, resources, compact ?? false);
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        console.error(`vision_from_resources failed: ${e}`);
        return { content: [{ type: "text" as const, text: errText(e) }] };
      }
    },
  );

  mcp.registerTool(
    "from_resources",
    {
      description: "Alias for vision_from_resources - describe multiple URLs using Gemini.",
      inputSchema,
    },
    async ({ type, prompt, resources, compact }) => {
      try {
        const text = await describeResources(ctx, type, prompt, resources, compact ?? false);
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        console.error(`from_resources failed: ${e}`);
        return { content: [{ type: "text" as const, text: errText(e) }] };
      }
    },
  );
}
