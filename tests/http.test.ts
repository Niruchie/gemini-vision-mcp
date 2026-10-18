import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertHttpConfigSecurity,
  buildHttpApp,
  isLoopbackHost,
  resolveAllowedHosts,
  splitList,
  type HttpConfig,
} from "../src/http.js";

const TOKEN = "test-token-0123456789abcdef";
const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "http-test", version: "0.0.0" },
  },
});

interface Reply {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function send(
  base: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: opts.method ?? "GET",
        headers: {
          accept: "application/json, text/event-stream",
          ...(opts.body ? { "content-type": "application/json" } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const servers: Server[] = [];

async function boot(config: Partial<HttpConfig> = {}): Promise<string> {
  const app: Express = buildHttpApp({ port: 0, host: "127.0.0.1", ...config });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

describe("http config helpers", () => {
  it("splits comma-separated lists", () => {
    expect(splitList("a, b ,,c")).toEqual(["a", "b", "c"]);
    expect(splitList(undefined)).toEqual([]);
  });

  it("detects loopback bind hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.5.0.9")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("mcp.internal")).toBe(false);
  });

  it("always allows loopback hostnames and the concrete bind host", () => {
    expect(resolveAllowedHosts("127.0.0.1", [])).toContain("[::1]");
    expect(resolveAllowedHosts("mcp.internal", [])).toContain("mcp.internal");
    // A wildcard bind must not whitelist arbitrary hostnames.
    expect(resolveAllowedHosts("0.0.0.0", [])).toEqual(["localhost", "127.0.0.1", "[::1]"]);
    expect(resolveAllowedHosts("0.0.0.0", ["svc.local"])).toContain("svc.local");
  });
});

describe("fail-closed startup", () => {
  it("refuses a non-loopback bind without a token", () => {
    expect(() => assertHttpConfigSecurity({ port: 3000, host: "0.0.0.0" })).toThrow(
      /MCP_AUTH_TOKEN/,
    );
  });

  it("allows a non-loopback bind when a token is set", () => {
    expect(() =>
      assertHttpConfigSecurity({ port: 3000, host: "0.0.0.0", authToken: TOKEN }),
    ).not.toThrow();
  });

  it("allows loopback binds without a token", () => {
    expect(() => assertHttpConfigSecurity({ port: 3000, host: "127.0.0.1" })).not.toThrow();
  });

  it("allows an explicit insecure opt-out", () => {
    expect(() =>
      assertHttpConfigSecurity({ port: 3000, host: "0.0.0.0", allowInsecure: true }),
    ).not.toThrow();
  });
});

describe("http transport", () => {
  it("keeps /health public and rejects /mcp without a token", async () => {
    const base = await boot({ authToken: TOKEN });

    const health = await send(base, "/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ status: "ok" });

    const missing = await send(base, "/mcp", { method: "POST", body: INITIALIZE });
    expect(missing.status).toBe(401);
    expect(missing.body).not.toContain(TOKEN);

    const wrong = await send(base, "/mcp", {
      method: "POST",
      body: INITIALIZE,
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
  });

  it("accepts a valid bearer token", async () => {
    const base = await boot({ authToken: TOKEN });
    const ok = await send(base, "/mcp", {
      method: "POST",
      body: INITIALIZE,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("gemini-vision");
  });

  it("rejects a Host header that is not allowlisted", async () => {
    const base = await boot({ authToken: TOKEN });
    const bad = await send(base, "/mcp", {
      method: "POST",
      body: INITIALIZE,
      headers: { host: "attacker.example.com", authorization: `Bearer ${TOKEN}` },
    });
    expect(bad.status).toBe(403);
  });

  it("rejects browser requests with a foreign Origin", async () => {
    const base = await boot({ authToken: TOKEN });
    const bad = await send(base, "/mcp", {
      method: "POST",
      body: INITIALIZE,
      headers: { origin: "http://evil.example", authorization: `Bearer ${TOKEN}` },
    });
    expect(bad.status).toBe(403);

    const allowed = await boot({
      authToken: TOKEN,
      allowedOrigins: ["http://localhost:5173"],
    });
    const ok = await send(allowed, "/mcp", {
      method: "POST",
      body: INITIALIZE,
      headers: { origin: "http://localhost:5173", authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
  });

  it("answers unknown routes with JSON and hides internals", async () => {
    const base = await boot({ authToken: TOKEN });
    const missing = await send(base, "/nope", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body)).toHaveProperty("error");
    expect(missing.body).not.toContain("Cannot GET");
  });

  it("rejects a malformed body without leaking parser internals", async () => {
    const base = await boot({ authToken: TOKEN });
    const bad = await send(base, "/mcp", {
      method: "POST",
      body: "{not json",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bad.status).toBe(400);
    expect(bad.body).not.toContain("Unexpected token");
  });
});

describe("session management", () => {
  const auth = { authorization: `Bearer ${TOKEN}` };

  it("caps concurrent sessions instead of growing without bound", async () => {
    const base = await boot({ authToken: TOKEN, maxSessions: 1 });

    const first = await send(base, "/mcp", {
      method: "POST",
      body: INITIALIZE,
      headers: auth,
    });
    expect(first.status).toBe(200);
    const sessionId = first.headers["mcp-session-id"] as string;
    expect(sessionId).toBeTruthy();

    const second = await send(base, "/mcp", {
      method: "POST",
      body: INITIALIZE,
      headers: auth,
    });
    expect(second.status).toBe(429);
    expect(second.body).toContain("Too many active sessions");
  });

  it("expires idle sessions and rejects their session id", async () => {
    const base = await boot({ authToken: TOKEN, sessionTtlSeconds: 0.2 });

    const first = await send(base, "/mcp", {
      method: "POST",
      body: INITIALIZE,
      headers: auth,
    });
    const sessionId = first.headers["mcp-session-id"] as string;
    expect(sessionId).toBeTruthy();

    await new Promise((r) => setTimeout(r, 400));

    const stale = await send(base, "/mcp", {
      method: "POST",
      body: INITIALIZE,
      headers: { ...auth, "mcp-session-id": sessionId },
    });
    expect(stale.status).toBe(404);
  });

  it("keeps a session alive while it is being used", async () => {
    const base = await boot({ authToken: TOKEN, sessionTtlSeconds: 0.4 });

    const first = await send(base, "/mcp", {
      method: "POST",
      body: INITIALIZE,
      headers: auth,
    });
    const sessionId = first.headers["mcp-session-id"] as string;

    await new Promise((r) => setTimeout(r, 250));
    const touched = await send(base, "/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      headers: { ...auth, "mcp-session-id": sessionId },
    });
    expect(touched.status).toBe(200);
  });
});
