import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { createApp, RATE_LIMIT, RATE_WINDOW } from "./server.js";
import { RateLimiter } from "./rate-limiter.js";
import { startTpmMonitor } from "./event/index.js";

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];
/** Max JSON-RPC request body accepted on /mcp. */
const MAX_REQUEST_BODY = "4mb";
/** Bearer tokens shorter than this trigger a startup warning. */
const MIN_TOKEN_LENGTH = 16;
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_SESSION_TTL_SECONDS = 1800;
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpConfig {
  port: number;
  host: string;
  /**
   * Bearer token required on `/mcp`. When empty the server only starts if it is
   * bound to a loopback address (or `allowInsecure` is set explicitly).
   */
  authToken?: string;
  /** Extra `Host` header hostnames (port-agnostic). A `*` entry disables the check. */
  allowedHosts?: string[];
  /** Exact `Origin` values allowed. Requests carrying an unlisted Origin are rejected. */
  allowedOrigins?: string[];
  /** Explicit opt-out of the fail-closed check for non-loopback binds without a token. */
  allowInsecure?: boolean;
  /** Concurrent session cap; further sessions get 429 (default `MCP_MAX_SESSIONS`, 100). */
  maxSessions?: number;
  /** Idle session lifetime in seconds; 0 keeps sessions until the client closes them. */
  sessionTtlSeconds?: number;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  monitor: NodeJS.Timeout;
  lastUsed: number;
}

export function splitList(value: string | undefined | null): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Whether a bind host (or Host header hostname) resolves to the local machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1" ||
    h.startsWith("127.")
  );
}

export function isWildcardHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "0.0.0.0" || h === "::" || h === "*" || h === "";
}

/** Host header hostnames to accept: loopback + concrete bind host + explicit extras. */
export function resolveAllowedHosts(bindHost: string, extra: string[]): string[] {
  const set = new Set(LOOPBACK_HOSTNAMES);
  if (!isWildcardHost(bindHost) && !isLoopbackHost(bindHost)) {
    set.add(bindHost.trim().toLowerCase());
  }
  for (const h of extra) {
    const v = h.trim().toLowerCase();
    if (v) set.add(v);
  }
  return [...set];
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

/** Refuse to start an unauthenticated server reachable from other machines. */
export function assertHttpConfigSecurity(config: HttpConfig): void {
  if (config.authToken) return;
  if (isLoopbackHost(config.host)) return;
  if (config.allowInsecure) {
    console.error(
      `[http] WARNING: listening on ${config.host} with no MCP_AUTH_TOKEN and ` +
        "MCP_ALLOW_INSECURE_HTTP=1 - anyone who can reach this port can use your " +
        "API key and read local files.",
    );
    return;
  }
  throw new Error(
    `Refusing to start: --host ${config.host} is reachable from other machines and no ` +
      "MCP_AUTH_TOKEN is set.\n" +
      "  - Set MCP_AUTH_TOKEN (recommended), or\n" +
      "  - bind a loopback address (--host 127.0.0.1), or\n" +
      "  - set MCP_ALLOW_INSECURE_HTTP=1 to accept an unauthenticated server (not recommended).",
  );
}

/** Constant-time Bearer token check for `/mcp`. */
export function bearerAuth(token: string) {
  const expected = Buffer.from(token, "utf8");
  const prefix = "bearer ";
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? "";
    if (!header.toLowerCase().startsWith(prefix)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="gemini-vision-mcp"');
      jsonRpcError(res, 401, -32001, "Unauthorized: missing bearer token");
      return;
    }
    const provided = Buffer.from(header.slice(prefix.length).trim(), "utf8");
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="gemini-vision-mcp"');
      jsonRpcError(res, 401, -32001, "Unauthorized: invalid bearer token");
      return;
    }
    next();
  };
}

/**
 * Reject browser requests whose `Origin` is not allowlisted. Non-browser clients
 * (no `Origin` header) are unaffected; this blocks DNS-rebinding style access.
 */
export function originGuard(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins.map((o) => o.trim()).filter(Boolean));
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (!origin || allowed.has(origin)) {
      next();
      return;
    }
    jsonRpcError(res, 403, -32000, "Forbidden: origin not allowed");
  };
}

export function buildHttpApp(config: HttpConfig): Express {
  assertHttpConfigSecurity(config);

  const app = express();
  app.disable("x-powered-by");

  const allowedHosts = resolveAllowedHosts(config.host, config.allowedHosts ?? []);
  if (allowedHosts.includes("*")) {
    console.error("[http] WARNING: MCP_ALLOWED_HOSTS contains '*' - Host header validation disabled");
  } else {
    app.use(hostHeaderValidation(allowedHosts));
  }
  app.use(originGuard(config.allowedOrigins ?? []));

  // Public probe target (kubelet/load balancers cannot send credentials).
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", name: "gemini-vision" });
  });

  if (config.authToken) {
    app.use(bearerAuth(config.authToken));
  }
  app.use(express.json({ limit: MAX_REQUEST_BODY }));

  // One shared limiter across HTTP sessions: a per-session limiter could be
  // reset simply by opening a new session.
  const limiter = new RateLimiter(RATE_LIMIT, RATE_WINDOW);
  const rawMax = config.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxSessions = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : DEFAULT_MAX_SESSIONS;
  const rawTtl = config.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const ttlMs = (Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : DEFAULT_SESSION_TTL_SECONDS) * 1000;
  const sessions = new Map<string, SessionEntry>();
  let janitor: NodeJS.Timeout | null = null;

  /** Close a session and release its TPM monitor (idempotent). */
  const dropSession = (id: string, reason: string): void => {
    const entry = sessions.get(id);
    if (!entry) return;
    clearInterval(entry.monitor);
    sessions.delete(id);
    void entry.transport.close().catch(() => undefined);
    console.error(`[http] session ${id} closed (${reason}); ${sessions.size} active`);
    if (sessions.size === 0 && janitor !== null) {
      clearInterval(janitor);
      janitor = null;
    }
  };

  /** Lazily run the idle-expiry sweep only while sessions exist. */
  const ensureJanitor = (): void => {
    if (janitor !== null || ttlMs <= 0) return;
    const interval = Math.min(60_000, Math.max(250, Math.floor(ttlMs / 4)));
    janitor = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of [...sessions]) {
        if (now - entry.lastUsed > ttlMs) dropSession(id, `idle > ${ttlMs / 1000}s`);
      }
    }, interval);
    janitor.unref?.();
  };

  /** Look up a session, expiring it lazily and marking it as recently used. */
  const lookup = (req: Request): StreamableHTTPServerTransport | undefined => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) return undefined;
    const entry = sessions.get(sessionId);
    if (!entry) return undefined;
    if (ttlMs > 0 && Date.now() - entry.lastUsed > ttlMs) {
      dropSession(sessionId, `idle > ${ttlMs / 1000}s`);
      return undefined;
    }
    entry.lastUsed = Date.now();
    return entry.transport;
  };

  /** Handle a route body, converting unexpected failures into a safe response. */
  const guarded =
    (name: string, handler: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        await handler(req, res);
      } catch (e) {
        const ref = randomUUID();
        console.error(`[http] ${name} failed (ref ${ref}): ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
        if (!res.headersSent) {
          // Never echo internal error details back to the caller - just a correlation id.
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error", data: { ref } },
            id: null,
          });
        }
      }
    };

  app.post(
    "/mcp",
    guarded("POST /mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const existing = lookup(req);
      if (existing) {
        await existing.handleRequest(req, res, req.body);
        return;
      }
      if (sessionId) {
        jsonRpcError(res, 404, -32001, "Session not found");
        return;
      }
      if (sessions.size >= maxSessions) {
        console.error(`[http] refusing new session: ${sessions.size}/${maxSessions} active`);
        jsonRpcError(res, 429, -32002, "Too many active sessions");
        return;
      }
      const { server, clientHolder } = createApp(limiter);
      const monitor = startTpmMonitor(clientHolder);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, monitor, lastUsed: Date.now() });
          console.error(`[http] session ${id} opened; ${sessions.size}/${maxSessions} active`);
        },
      });
      transport.onclose = () => {
        clearInterval(monitor);
        const id = transport.sessionId;
        if (id !== undefined) sessions.delete(id);
        if (sessions.size === 0 && janitor !== null) {
          clearInterval(janitor);
          janitor = null;
        }
      };
      ensureJanitor();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    }),
  );

  app.get(
    "/mcp",
    guarded("GET /mcp", async (req, res) => {
      const transport = lookup(req);
      if (!transport) {
        jsonRpcError(res, 404, -32001, "Session not found");
        return;
      }
      await transport.handleRequest(req, res);
    }),
  );

  app.delete(
    "/mcp",
    guarded("DELETE /mcp", async (req, res) => {
      const transport = lookup(req);
      if (!transport) {
        jsonRpcError(res, 404, -32001, "Session not found");
        return;
      }
      await transport.handleRequest(req, res);
    }),
  );

  app.use((_req, res) => {
    jsonRpcError(res, 404, -32601, "Not found");
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      (err as { status?: number })?.status ??
      (err as { statusCode?: number })?.statusCode ??
      500;
    const mapped = status === 400 || status === 413 || status === 415 ? status : 500;
    if (mapped >= 500) console.error(`[http] unhandled error: ${err}`);
    const message =
      mapped === 413
        ? "Request body too large"
        : mapped === 415
          ? "Unsupported media type"
          : mapped === 400
            ? "Bad request"
            : "Internal server error";
    jsonRpcError(res, mapped, -32603, message);
  });

  return app;
}

/** Serve the MCP server over Streamable HTTP (stateful, one McpServer per session). */
export async function runHttp(config: HttpConfig): Promise<void> {
  const app = buildHttpApp(config);
  await new Promise<void>((resolve) => {
    app.listen(config.port, config.host, () => {
      console.error(
        `[gemini-vision] MCP server listening on http://${config.host}:${config.port}/mcp` +
          (config.authToken ? " (bearer auth required)" : " (NO AUTH)"),
      );
      resolve();
    });
  });
}
