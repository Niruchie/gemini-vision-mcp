#!/usr/bin/env node
import { main } from "./server.js";
import { runHttp, splitList } from "./http.js";

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const prefixed = process.argv.find((a) => a.startsWith(`${name}=`));
  return prefixed?.slice(name.length + 1);
}

const transport = argValue("--transport") ?? process.env.MCP_TRANSPORT ?? "stdio";
const port = Number(argValue("--port") ?? process.env.PORT ?? "3000");
const host = argValue("--host") ?? process.env.HOST ?? "127.0.0.1";

if (transport === "http") {
  const authToken = argValue("--auth-token") ?? process.env.MCP_AUTH_TOKEN;
  if (authToken && authToken.length < 16) {
    console.error(
      "[http] WARNING: MCP_AUTH_TOKEN is shorter than 16 characters; use a long random value " +
        "(e.g. openssl rand -hex 32).",
    );
  }
  await runHttp({
    port,
    host,
    authToken,
    allowedHosts: splitList(process.env.MCP_ALLOWED_HOSTS),
    allowedOrigins: splitList(process.env.MCP_ALLOWED_ORIGINS),
    allowInsecure: process.env.MCP_ALLOW_INSECURE_HTTP === "1",
    maxSessions: Number(process.env.MCP_MAX_SESSIONS) || undefined,
    sessionTtlSeconds: (() => {
      const raw = process.env.MCP_SESSION_TTL_SECONDS;
      if (raw === undefined || raw.trim() === "") return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    })(),
  });
} else {
  await main();
}
