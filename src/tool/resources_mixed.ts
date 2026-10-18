import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchUrl, errText } from "./_helpers.js";
import type { ToolContext } from "./types.js";

const mediaType = z.enum(["text", "image", "audio", "video"]);

async function describeMixed(
  ctx: ToolContext,
  types: string[],
  prompt: string,
  resources: string[],
  compact: boolean,
): Promise<string> {
  ctx.checkApiKey();
  await ctx.checkRate();
  return ctx.lock.runExclusive(async () => {
    if (types.length !== resources.length) {
      return `Error: types (${types.length}) and resources (${resources.length}) must have same length`;
    }
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
    types: z
      .array(mediaType)
      .describe("List of media categories, one per resource (text, image, audio, video)."),
    prompt: z.string().describe("Instructions to the model (what to describe/extract)."),
    resources: z.array(z.string()).describe("List of URLs (must match length of types)."),
    compact: z
      .boolean()
      .optional()
      .describe("If true, compact history and reconnect after this request."),
  };

  mcp.registerTool(
    "vision_from_resources_mixed",
    {
      description: "Describe multiple URL resources of mixed types in one Gemini session.",
      inputSchema,
    },
    async ({ types, prompt, resources, compact }) => {
      try {
        const text = await describeMixed(ctx, types, prompt, resources, compact ?? false);
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        console.error(`vision_from_resources_mixed failed: ${e}`);
        return { content: [{ type: "text" as const, text: errText(e) }] };
      }
    },
  );

  mcp.registerTool(
    "from_resources_mixed",
    {
      description:
        "Alias for vision_from_resources_mixed - describe mixed-type URLs using Gemini.",
      inputSchema,
    },
    async ({ types, prompt, resources, compact }) => {
      try {
        const text = await describeMixed(ctx, types, prompt, resources, compact ?? false);
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        console.error(`from_resources_mixed failed: ${e}`);
        return { content: [{ type: "text" as const, text: errText(e) }] };
      }
    },
  );
}
