import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { fileToImageDict, errText } from "./_helpers.js";
import type { ToolContext } from "./types.js";

const mediaType = z.enum(["text", "image", "audio", "video"]);

async function describeMany(
  ctx: ToolContext,
  type: string,
  prompt: string,
  paths: string[],
  compact: boolean,
): Promise<string> {
  ctx.checkApiKey();
  await ctx.checkRate();
  return ctx.lock.runExclusive(async () => {
    const images = [];
    for (const p of paths) {
      if (!existsSync(p)) {
        return `Error: File not found: ${p}`;
      }
      images.push(await fileToImageDict(p, type));
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
    paths: z.array(z.string()).describe("List of local file paths."),
    compact: z
      .boolean()
      .optional()
      .describe("If true, compact history and reconnect after this request."),
  };

  mcp.registerTool(
    "vision_from_files",
    {
      description: "Describe multiple files in one Gemini session.",
      inputSchema,
    },
    async ({ type, prompt, paths, compact }) => {
      try {
        const text = await describeMany(ctx, type, prompt, paths, compact ?? false);
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        console.error(`vision_from_files failed: ${e}`);
        return { content: [{ type: "text" as const, text: errText(e) }] };
      }
    },
  );

  mcp.registerTool(
    "from_files",
    {
      description: "Alias for vision_from_files - describe multiple files using Gemini.",
      inputSchema,
    },
    async ({ type, prompt, paths, compact }) => {
      try {
        const text = await describeMany(ctx, type, prompt, paths, compact ?? false);
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        console.error(`from_files failed: ${e}`);
        return { content: [{ type: "text" as const, text: errText(e) }] };
      }
    },
  );
}
