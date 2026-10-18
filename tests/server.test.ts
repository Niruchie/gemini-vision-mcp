import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

async function loadApp(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import("../src/server.js");
}

async function connectClient(env: Record<string, string>) {
  const { createApp } = await loadApp(env);
  const { server } = createApp();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const NO_KEY = { GOOGLE_API_KEY: "" };
const DUMMY_KEY = { GOOGLE_API_KEY: "dummy" };

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ text?: string }> }).content;
  return content.map((c) => c.text ?? "").join("\n");
}

describe("server", () => {
  it("registers all 15 tools", async () => {
    const client = await connectClient(NO_KEY);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "compact",
        "from_file",
        "from_files",
        "from_files_mixed",
        "from_resource",
        "from_resources",
        "from_resources_mixed",
        "gemini_usage",
        "new_vision",
        "vision_from_file",
        "vision_from_files",
        "vision_from_files_mixed",
        "vision_from_resource",
        "vision_from_resources",
        "vision_from_resources_mixed",
      ].sort(),
    );
    await client.close();
  });

  it("exposes the config resource", async () => {
    const client = await connectClient(NO_KEY);
    const { contents } = await client.readResource({ uri: "config://gemini-vision" });
    const text = (contents[0] as { text: string }).text;
    const config = JSON.parse(text) as { name: string; tools: string[] };
    expect(config.name).toBe("gemini-vision");
    expect(config.tools).toContain("vision_from_file");
    await client.close();
  });

  it("rejects calls without an API key", async () => {
    const client = await connectClient(NO_KEY);
    const result = await client.callTool({ name: "gemini_usage", arguments: {} });
    expect(textOf(result)).toBe("Error: GOOGLE_API_KEY not set");
    await client.close();
  });

  it("reports missing files without spending API calls", async () => {
    const client = await connectClient(DUMMY_KEY);
    const result = await client.callTool({
      name: "vision_from_file",
      arguments: { type: "image", prompt: "x", path: "C:/definitely-not-here.png" },
    });
    expect(textOf(result)).toMatch(/^Error: File not found/);
    await client.close();
  });

  it("enforces the sliding-window rate limit", async () => {
    const client = await connectClient({ ...DUMMY_KEY, RATE_LIMIT_REQUESTS: "1" });
    const args = { type: "image", prompt: "x", path: "C:/nope.png" };
    const first = await client.callTool({ name: "vision_from_file", arguments: args });
    expect(textOf(first)).toMatch(/^Error: File not found/);
    const second = await client.callTool({ name: "vision_from_file", arguments: args });
    expect(textOf(second)).toMatch(/^Error: Rate limit exceeded/);
    await client.close();
  });
});
