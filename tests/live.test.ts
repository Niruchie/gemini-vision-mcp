import "dotenv/config";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Full live integration test: every tool against the real Gemini Live API.
// Requires dist/ build, network, and a real key. Costs ~15k input tokens.
// Run with: pnpm test:live
const LIVE = process.env.LIVE_TEST === "1" && Boolean(process.env.GOOGLE_API_KEY);

const LOGO_2X = "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png";
const LOGO_1X = "https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png";

// 1x1 red PNG fallback if the network fetch for local fixtures fails.
const FALLBACK_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function textOf(result: unknown): string {
  return ((result as { content: Array<{ text?: string }> }).content ?? [])
    .map((c) => c.text ?? "")
    .join("\n");
}

function expectOk(text: string): void {
  expect(text).not.toMatch(/^Error:/);
  expect(text.length).toBeGreaterThan(0);
}

describe.skipIf(!LIVE)("live (all tools)", () => {
  let client: Client;
  let imgPath: string;
  let imgPath2: string;
  let txtPath: string;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "gv-live-"));
    imgPath = join(dir, "logo.png");
    imgPath2 = join(dir, "logo2.png");
    txtPath = join(dir, "note.txt");
    try {
      const [a, b] = await Promise.all([
        fetch(LOGO_2X).then((r) => Buffer.from(r.arrayBuffer())),
        fetch(LOGO_1X).then((r) => Buffer.from(r.arrayBuffer())),
      ]);
      writeFileSync(imgPath, a);
      writeFileSync(imgPath2, b);
    } catch {
      const buf = Buffer.from(FALLBACK_PNG_B64, "base64");
      writeFileSync(imgPath, buf);
      writeFileSync(imgPath2, buf);
    }
    writeFileSync(txtPath, "The quick brown fox jumps over the lazy dog.");

    const transport = new StdioClientTransport({
      command: "node",
      args: ["dist/index.js"],
      // The suite makes ~20 calls in well under a minute; don't let the
      // default 10 req/60s limiter interfere with tool coverage.
      env: { ...process.env, RATE_LIMIT_REQUESTS: "100" },
    });
    client = new Client({ name: "live-test", version: "0.0.0" });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }).then(textOf);

  it("vision_from_file (image)", async () => {
    const text = await call("vision_from_file", {
      type: "image",
      prompt: "What is in this image? Reply in one sentence.",
      path: imgPath,
    });
    expectOk(text);
  }, 120_000);

  it("from_file alias (text)", async () => {
    const text = await call("from_file", {
      type: "text",
      prompt: "Repeat back the sentence in this file.",
      path: txtPath,
    });
    expectOk(text);
    expect(text.toLowerCase()).toContain("fox");
  }, 120_000);

  it("vision_from_files", async () => {
    const text = await call("vision_from_files", {
      type: "image",
      prompt: "How many images were provided? Reply in one sentence.",
      paths: [imgPath, imgPath2],
    });
    expectOk(text);
  }, 120_000);

  it("from_files alias", async () => {
    const text = await call("from_files", {
      type: "image",
      prompt: "Describe what these images have in common, in one sentence.",
      paths: [imgPath, imgPath2],
    });
    expectOk(text);
  }, 120_000);

  it("vision_from_files_mixed", async () => {
    const text = await call("vision_from_files_mixed", {
      types: ["image", "text"],
      prompt: "Does the text file mention anything visible in the image? One sentence.",
      paths: [imgPath, txtPath],
    });
    expectOk(text);
  }, 120_000);

  it("from_files_mixed alias", async () => {
    const text = await call("from_files_mixed", {
      types: ["text", "image"],
      prompt: "Summarize both inputs in one sentence.",
      paths: [txtPath, imgPath],
    });
    expectOk(text);
  }, 120_000);

  it("rejects mismatched types/paths lengths", async () => {
    const text = await call("vision_from_files_mixed", {
      types: ["image"],
      prompt: "x",
      paths: [imgPath, txtPath],
    });
    expect(text).toMatch(/^Error: types \(1\) and paths \(2\) must have same length/);
  }, 120_000);

  it("reports missing local files", async () => {
    const text = await call("vision_from_file", {
      type: "image",
      prompt: "x",
      path: join(tmpdir(), "gv-live-nope.png"),
    });
    expect(text).toMatch(/^Error: File not found/);
  }, 120_000);

  it("new_vision resets the session", async () => {
    const text = await call("new_vision", {});
    expect(text).toContain("Session reset");
    const usage = JSON.parse(await call("gemini_usage", {})) as {
      turn_count: number;
      session_count: number;
    };
    expect(usage.turn_count).toBe(0);
    expect(usage.session_count).toBe(0);
  }, 120_000);

  it("vision_from_resource", async () => {
    const text = await call("vision_from_resource", {
      type: "image",
      prompt: "What is in this image? Reply in one sentence.",
      resource: LOGO_2X,
    });
    expectOk(text);
    expect(text.toLowerCase()).toContain("google");
  }, 120_000);

  it("from_resource alias", async () => {
    const text = await call("from_resource", {
      type: "image",
      prompt: "What company logo is this? Reply in one sentence.",
      resource: LOGO_1X,
    });
    expectOk(text);
  }, 120_000);

  it("vision_from_resources", async () => {
    const text = await call("vision_from_resources", {
      type: "image",
      prompt: "How many images were provided? Reply in one sentence.",
      resources: [LOGO_2X, LOGO_1X],
    });
    expectOk(text);
  }, 120_000);

  it("from_resources alias", async () => {
    const text = await call("from_resources", {
      type: "image",
      prompt: "Describe what these images have in common, in one sentence.",
      resources: [LOGO_2X, LOGO_1X],
    });
    expectOk(text);
  }, 120_000);

  it("vision_from_resources_mixed", async () => {
    const text = await call("vision_from_resources_mixed", {
      types: ["image", "image"],
      prompt: "Are these the same logo? Reply in one sentence.",
      resources: [LOGO_2X, LOGO_1X],
    });
    expectOk(text);
  }, 120_000);

  it("from_resources_mixed alias", async () => {
    const text = await call("from_resources_mixed", {
      types: ["image", "image"],
      prompt: "Describe both resources in one sentence.",
      resources: [LOGO_1X, LOGO_2X],
    });
    expectOk(text);
  }, 120_000);

  it("rejects mismatched types/resources lengths", async () => {
    const text = await call("vision_from_resources_mixed", {
      types: ["image"],
      prompt: "x",
      resources: [LOGO_2X, LOGO_1X],
    });
    expect(text).toMatch(/^Error: types \(1\) and resources \(2\) must have same length/);
  }, 120_000);

  it("compact preserves context across reconnect", async () => {
    const text = await call("compact", {});
    expect(text).toMatch(/Compacted \d+ turns/);
    expect(text).toContain("reconnected");
  }, 120_000);

  it("gemini_usage reports token accounting", async () => {
    const usage = JSON.parse(await call("gemini_usage", {})) as {
      turn_count: number;
      session_count: number;
      total_tokens: number;
    };
    expect(usage.turn_count).toBeGreaterThan(0);
    expect(usage.session_count).toBeGreaterThanOrEqual(1);
    expect(usage.total_tokens).toBeGreaterThan(0);
  }, 120_000);
});
