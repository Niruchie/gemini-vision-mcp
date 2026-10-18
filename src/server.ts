import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GeminiLiveClient } from "./gemini-live.js";
import { RateLimiter } from "./rate-limiter.js";
import * as toolCompact from "./tool/compact.js";
import * as toolFile from "./tool/file.js";
import * as toolFiles from "./tool/files.js";
import * as toolFilesMixed from "./tool/files_mixed.js";
import * as toolGeminiUsage from "./tool/gemini_usage.js";
import * as toolNewVision from "./tool/new_vision.js";
import * as toolResource from "./tool/resource.js";
import * as toolResources from "./tool/resources.js";
import * as toolResourcesMixed from "./tool/resources_mixed.js";
import type { ToolContext } from "./tool/types.js";
import { startTpmMonitor, type ClientHolder } from "./event/index.js";

export const API_KEY = process.env.GOOGLE_API_KEY ?? "";
export const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-live-preview";
export const RATE_LIMIT = Number(process.env.RATE_LIMIT_REQUESTS ?? "10");
export const RATE_WINDOW = Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? "60");
export const TPM_LIMIT = Number(process.env.GEMINI_TPM_LIMIT ?? "4000000");

export const LLM_INSTRUCTIONS = `## Gemini Vision MCP Server

Tools for describing media content using Gemini Live API.
Persistent WebSocket connection - one session shared across all tool calls.

### Tools

| Tool | Description |
|------|-------------|
| \`vision_from_file\` | Describe a single file (image, audio, video, or text) |
| \`from_file\` | Alias for \`vision_from_file\` |
| \`vision_from_files\` | Describe multiple files in one request |
| \`from_files\` | Alias for \`vision_from_files\` |
| \`vision_from_resource\` | Describe a URL resource |
| \`from_resource\` | Alias for \`vision_from_resource\` |
| \`vision_from_resources\` | Describe multiple URL resources |
| \`from_resources\` | Alias for \`vision_from_resources\` |
| \`vision_from_files_mixed\` / \`from_files_mixed\` | Multiple files with different types |
| \`vision_from_resources_mixed\` / \`from_resources_mixed\` | Multiple URLs with different types |
| \`new_vision\` | Force a fresh Gemini Live session (loses context) |
| \`compact\` | Summarize history via model, reconnect with summary |
| \`gemini_usage\` | Report current token usage and TPM status |

### Parameters

- \`type\`: Media category - \`text\`, \`image\`, \`audio\`, or \`video\`
- \`prompt\`: Instructions to the model (what to describe/extract)
- \`path\`: Local file path (file tools)
- \`resource\`: URL to fetch (resource tools)
- \`compact\`: If true, auto-compact history after this request (vision tools only)

### Usage

1. Use \`type\` to specify the media category
2. Provide a clear \`prompt\` - e.g., "Extract all text from this image" or "Describe the UI layout"
3. Use plural tools (\`from_files\`, \`from_resources\`) for batch processing
4. Call \`compact\` to summarize history and keep the session alive
5. Call \`new_vision\` to reset completely (loses all context)
6. Auto-compaction triggers at 70% TPM, hard refresh at 75%
7. Rate limit: ${RATE_LIMIT} requests per ${RATE_WINDOW} seconds (configurable via RATE_LIMIT_REQUESTS env var)
`;

/** Serializes Gemini requests so only one turn is in flight at a time. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export interface AppState {
  server: McpServer;
  clientHolder: ClientHolder;
  getGemini: () => GeminiLiveClient;
  limiter: RateLimiter;
  lock: Mutex;
}

/**
 * Build the MCP server, its tools and shared state.
 *
 * @param sharedLimiter Optional limiter shared across sessions (HTTP transport
 *   passes one so opening a new session cannot reset the rate limit).
 */
export function createApp(sharedLimiter?: RateLimiter): AppState {
  const server = new McpServer(
    { name: "gemini-vision", version: "0.1.0" },
    { instructions: LLM_INSTRUCTIONS },
  );

  let gemini: GeminiLiveClient | null = null;
  const limiter = sharedLimiter ?? new RateLimiter(RATE_LIMIT, RATE_WINDOW);
  const lock = new Mutex();
  const clientHolder: ClientHolder = { client: null };

  function getGemini(): GeminiLiveClient {
    if (gemini === null) {
      gemini = new GeminiLiveClient(API_KEY, MODEL, TPM_LIMIT);
    }
    clientHolder.client = gemini;
    return gemini;
  }

  function checkApiKey(): void {
    if (!API_KEY) {
      throw new Error("GOOGLE_API_KEY not set");
    }
  }

  async function resetGemini(): Promise<void> {
    if (gemini !== null) {
      try {
        await gemini.close();
      } catch {
        // ignore close errors during reset
      }
    }
    gemini = null;
    clientHolder.client = null;
  }

  async function acquireRate(): Promise<void> {
    if (!limiter.acquire()) {
      throw new Error(
        `Rate limit exceeded. Try again in ${RATE_WINDOW}s. (${limiter.remaining} remaining)`,
      );
    }
  }

  async function checkRate(): Promise<void> {
    await acquireRate();
    const g = clientHolder.client;
    if (g && g.usage.needsRefresh) {
      throw new Error(
        `TPM limit exceeded (${g.usage.tpmUsagePct}%). Call new_vision to reset session.`,
      );
    }
  }

  const ctx: ToolContext = {
    getGemini,
    resetGemini,
    checkApiKey,
    checkRate,
    acquireRate,
    lock,
    clientHolder,
  };

  toolFile.register(server, ctx);
  toolFiles.register(server, ctx);
  toolFilesMixed.register(server, ctx);
  toolResource.register(server, ctx);
  toolResources.register(server, ctx);
  toolResourcesMixed.register(server, ctx);
  toolNewVision.register(server, ctx);
  toolGeminiUsage.register(server, ctx);
  toolCompact.register(server, ctx);

  server.resource("server-info", "config://gemini-vision", async (uri) => ({
    contents: [
      {
        uri: uri.href,
        text: JSON.stringify(
          {
            name: "gemini-vision",
            model: MODEL,
            rate_limit: `${RATE_LIMIT} requests / ${RATE_WINDOW}s`,
            remaining: limiter.remaining,
            tools: [
              "vision_from_file",
              "from_file",
              "vision_from_files",
              "from_files",
              "vision_from_files_mixed",
              "from_files_mixed",
              "vision_from_resource",
              "from_resource",
              "vision_from_resources",
              "from_resources",
              "vision_from_resources_mixed",
              "from_resources_mixed",
              "new_vision",
              "compact",
              "gemini_usage",
            ],
          },
          null,
          2,
        ),
      },
    ],
  }));

  return { server, clientHolder, getGemini, limiter, lock };
}

export async function main(): Promise<void> {
  const { server, clientHolder } = createApp();
  startTpmMonitor(clientHolder);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[gemini-vision] MCP server running on stdio");
}
