import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { fileToImageDict, errText } from "./_helpers.js";
import type { ToolContext } from "./types.js";

const mediaType = z.enum(["text", "image", "audio", "video"]);

async function describeSingle(
  ctx: ToolContext,
  type: string,
  prompt: string,
  path: string,
  compact: boolean,
): Promise<string> {
  ctx.checkApiKey();
  await ctx.checkRate();
  return ctx.lock.runExclusive(async () => {
    if (!existsSync(path)) {
      return `Error: File not found: ${path}`;
    }
    const img = await fileToImageDict(path, type);
    return ctx.getGemini().describeImage(img.data, img.mime_type, prompt, 30, compact);
  });
}

export function register(mcp: McpServer, ctx: ToolContext): void {
  mcp.registerTool(
    "vision_from_file",
    {
      description:
        "Describe a single file (image, audio, video, or text) using Gemini.",
      inputSchema: {
        type: mediaType.describe("Media category - text, image, audio, or video."),
        prompt: z.string().describe("Instructions to the model (what to describe/extract)."),
        path: z.string().describe("Local file path to read."),
        compact: z
          .boolean()
          .optional()
          .describe("If true, compact history and reconnect after this request."),
      },
    },
    async ({ type, prompt, path, compact }) => {
      try {
        const text = await describeSingle(ctx, type, prompt, path, compact ?? false);
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        console.error(`vision_from_file failed: ${e}`);
        return { content: [{ type: "text" as const, text: errText(e) }] };
      }
    },
  );

  mcp.registerTool(
    "from_file",
    {
      description: "Alias for vision_from_file - describe a single file using Gemini.",
      inputSchema: {
        type: mediaType.describe("Media category - text, image, audio, or video."),
        prompt: z.string().describe("Instructions to the model (what to describe/extract)."),
        path: z.string().describe("Local file path to read."),
        compact: z
          .boolean()
          .optional()
          .describe("If true, compact history and reconnect after this request."),
      },
    },
    async ({ type, prompt, path, compact }) => {
      try {
        const text = await describeSingle(ctx, type, prompt, path, compact ?? false);
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        console.error(`from_file failed: ${e}`);
        return { content: [{ type: "text" as const, text: errText(e) }] };
      }
    },
  );
}
