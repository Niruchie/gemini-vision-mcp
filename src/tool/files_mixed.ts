import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { fileToImageDict, errText } from "./_helpers.js";
import type { ToolContext } from "./types.js";

const mediaType = z.enum(["text", "image", "audio", "video"]);

async function describeMixed(
  ctx: ToolContext,
  types: string[],
  prompt: string,
  paths: string[],
  compact: boolean,
): Promise<string> {
  ctx.checkApiKey();
  await ctx.checkRate();
  return ctx.lock.runExclusive(async () => {
    if (types.length !== paths.length) {
      return `Error: types (${types.length}) and paths (${paths.length}) must have same length`;
    }
    const images = [];
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (!existsSync(p)) {
        return `Error: File not found: ${p}`;
      }
      images.push(await fileToImageDict(p, types[i]));
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
      .describe("List of media categories, one per file (text, image, audio, video)."),
    prompt: z.string().describe("Instructions to the model (what to describe/extract)."),
    paths: z.array(z.string()).describe("List of local file paths (must match length of types)."),
    compact: z
      .boolean()
      .optional()
      .describe("If true, compact history and reconnect after this request."),
  };

  mcp.registerTool(
    "vision_from_files_mixed",
    {
      description: "Describe multiple files of mixed types in one Gemini session.",
      inputSchema,
    },
    async ({ types, prompt, paths, compact }) => {
      try {
        const text = await describeMixed(ctx, types, prompt, paths, compact ?? false);
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        console.error(`vision_from_files_mixed failed: ${e}`);
        return { content: [{ type: "text" as const, text: errText(e) }] };
      }
    },
  );

  mcp.registerTool(
    "from_files_mixed",
    {
      description:
        "Alias for vision_from_files_mixed - describe mixed-type files using Gemini.",
      inputSchema,
    },
    async ({ types, prompt, paths, compact }) => {
      try {
        const text = await describeMixed(ctx, types, prompt, paths, compact ?? false);
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        console.error(`from_files_mixed failed: ${e}`);
        return { content: [{ type: "text" as const, text: errText(e) }] };
      }
    },
  );
}
