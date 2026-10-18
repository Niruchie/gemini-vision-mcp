# gemini-vision-mcp

MCP server for describing video, image, audio, and text using the Gemini Live API.

Uses a persistent WebSocket session (Google GenAI Live API via [`@google/genai`](https://www.npmjs.com/package/@google/genai)) to describe media content through the [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

Supports both stdio and Streamable HTTP transports (select with `--transport`).

## Requirements

- Node.js 18+
- pnpm 8+
- Google API key with Gemini access

## Install

```bash
pnpm install
pnpm build
```

## Configuration

Copy `.env.example` to `.env` and fill in your API key:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `GOOGLE_API_KEY` | - | Required. Your Google Gemini API key |
| `GEMINI_MODEL` | `gemini-3.1-flash-live-preview` | Gemini Live model to use |
| `GEMINI_TPM_LIMIT` | `4000000` | Tokens per minute limit for auto-refresh |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Rate limit window in seconds |
| `RATE_LIMIT_REQUESTS` | `10` | Max requests per rate window |
| `PORT` | `3000` | HTTP transport port |
| `HOST` | `127.0.0.1` | HTTP transport host |
| `MCP_AUTH_TOKEN` | - | Bearer token for `/mcp`. **Required** when `HOST` is not a loopback address |
| `MCP_ALLOWED_HOSTS` | loopback + `HOST` | Extra `Host` header hostnames (comma-separated, port-agnostic); `*` disables the check |
| `MCP_ALLOWED_ORIGINS` | - | Exact `Origin` values allowed on `/mcp`; requests with any other `Origin` are rejected |
| `MCP_ALLOW_INSECURE_HTTP` | - | `1` allows an unauthenticated server on a public interface (not recommended) |
| `MCP_MAX_SESSIONS` | `100` | Concurrent MCP sessions per process; further sessions get HTTP 429 |
| `MCP_SESSION_TTL_SECONDS` | `1800` | Idle session lifetime; `0` keeps sessions until the client closes them |
| `MCP_MAX_FILE_BYTES` | `67108864` | Max bytes read from a local file (64 MiB) |
| `MCP_MAX_URL_BYTES` | `67108864` | Max bytes accepted from a fetched URL (64 MiB) |
| `MCP_ALLOW_PRIVATE_URLS` | - | `1` lets the URL tools reach loopback/private/link-local addresses |

See [Security](#security) for what these do and why the defaults are strict.


## Usage

Stdio (default):

```bash
node dist/index.js
# or
pnpm start
```

HTTP (Streamable HTTP + `/health`):

```bash
export MCP_AUTH_TOKEN=$(openssl rand -hex 32)   # required when HOST is not loopback
node dist/index.js --transport http --port 3000
# or
pnpm start:http
```

Flags (`--transport stdio|http`, `--port`, `--host`, `--auth-token`) override the
`MCP_TRANSPORT`, `PORT`, `HOST`, `MCP_AUTH_TOKEN` env vars.

The server **refuses to start** when it is bound to a non-loopback address and no
token is configured (use `MCP_ALLOW_INSECURE_HTTP=1` to override deliberately).

### MCP Client Configuration

Stdio (e.g. opencode `opencode.json`):

```json
{
  "mcp": {
    "gemini-vision": {
      "environment": {
        "GOOGLE_API_KEY": "your-api-key",
        "GEMINI_MODEL": "gemini-3.1-flash-live-preview",
        "RATE_LIMIT_WINDOW_SECONDS": "60",
        "RATE_LIMIT_REQUESTS": "10"
      },
      "enabled": true,
      "type": "local",
      "cwd": ".",
      "command": ["node", "dist/index.js"]
    }
  }
}
```

HTTP:

```json
{
  "mcp": {
    "gemini-vision": {
      "enabled": true,
      "type": "remote",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_AUTH_TOKEN}"
      }
    }
  }
}
```

## Tools

| Tool | Description |
|---|---|
| `vision_from_file` | Describe a single file (image, audio, video, or text) |
| `from_file` | Alias for `vision_from_file` |
| `vision_from_files` | Describe multiple files in one request |
| `from_files` | Alias for `vision_from_files` |
| `vision_from_files_mixed` | Multiple files with different media types |
| `from_files_mixed` | Alias for `vision_from_files_mixed` |
| `vision_from_resource` | Describe a URL resource |
| `from_resource` | Alias for `vision_from_resource` |
| `vision_from_resources` | Describe multiple URL resources |
| `from_resources` | Alias for `vision_from_resources` |
| `vision_from_resources_mixed` | Multiple URLs with different media types |
| `from_resources_mixed` | Alias for `vision_from_resources_mixed` |
| `new_vision` | Force a fresh Gemini Live session (loses context) |
| `compact` | Summarize history via model, reconnect with summary |
| `gemini_usage` | Report current token usage and TPM status |

### Parameters

- **`type`**: Media category - `text`, `image`, `audio`, or `video`
- **`prompt`**: Instructions to the model (what to describe/extract)
- **`path`**: Local file path (file tools)
- **`resource`**: URL to fetch (resource tools)
- **`compact`**: If true, auto-compact history after this request (vision tools only)

### Example: describe an image

```
vision_from_file(type="image", path="/path/to/photo.jpg", prompt="Describe the scene in detail")
```

### Example: extract text from a screenshot

```
vision_from_file(type="image", path="/path/to/screenshot.png", prompt="Extract all visible text")
```

### Example: batch describe images

```
vision_from_files(type="image", paths=["/a.jpg", "/b.jpg", "/c.jpg"], prompt="Describe each image")
```

### Example: describe a URL resource

```
vision_from_resource(type="image", resource="https://example.com/photo.png", prompt="What is in this image?")
```

### Session management

The server maintains a conversation history across tool calls and uses a two-tier TPM management strategy:

- **70% TPM** - Auto-compaction: the model summarizes the conversation history, then reconnects with the summary as context. History shrinks, session continues.
- **75% TPM** - Hard refresh: reconnects with whatever compacted history exists. Use `new_vision` to reset completely (loses all context).

You can also trigger compaction manually:

```
compact()
```

Or pass `compact=true` to any vision tool to compact after that request:

```
vision_from_file(type="image", path="photo.jpg", prompt="Describe this", compact=true)
```

Call `new_vision` to force a clean reset (no history carried over).
Call `gemini_usage` to inspect current token consumption and rate limit status.

## Docker

```bash
docker build -t gemini-vision-mcp:0.1.0 .
docker run --rm -p 3000:3000 \
  -e GOOGLE_API_KEY=your-api-key \
  -e MCP_AUTH_TOKEN=$(openssl rand -hex 32) \
  gemini-vision-mcp:0.1.0
```

The image defaults to HTTP transport on port 3000 (`/mcp`, `/health`) bound to
`0.0.0.0`, so `MCP_AUTH_TOKEN` is mandatory - the container exits at startup
without it. Override the command for stdio:
`docker run --rm -i gemini-vision-mcp:0.1.0 node dist/index.js`.

## Helm

```bash
helm install gemini-vision ./helm/gemini-vision-mcp \
  --set apiKey.value=your-api-key
# or reference an existing secret:
helm install gemini-vision ./helm/gemini-vision-mcp \
  --set apiKey.existingSecret=my-secret \
  --set authToken.existingSecret=my-auth-secret
```

The chart generates a random `MCP_AUTH_TOKEN` when `authToken.value` is empty and
keeps it across upgrades; `helm install` prints the command to read it. The chart
also runs the pod as non-root with a read-only root filesystem, drops all
capabilities, keeps the Service internal (`ClusterIP`) and allowlists the service
DNS names in the `Host` header check.

Key values: `image.repository`/`tag`, `transport` (`http` creates a
Service; `stdio` skips it), `config.model`, `config.tpmLimit`,
`config.rateLimitRequests`, `config.rateLimitWindowSeconds`, `resources`,
`probes`, `authToken`, `allowedHosts`, `allowedOrigins`,
`podSecurityContext`, `containerSecurityContext`.

## Security

What the server protects against, and what it deliberately leaves to you:

| Area | Behavior |
|---|---|
| **HTTP auth** | `/mcp` requires `Authorization: Bearer $MCP_AUTH_TOKEN` (constant-time compare). Started without a token it binds loopback only, and refuses to start on a public interface. `/health` stays public for probes and returns no configuration. |
| **DNS rebinding** | `Host` headers are validated against an allowlist (loopback + bind host + `MCP_ALLOWED_HOSTS`), and any request carrying an `Origin` header must match `MCP_ALLOWED_ORIGINS` exactly. `/mcp` never sends CORS headers, so browsers cannot read it cross-origin. |
| **SSRF** | The URL tools refuse non-`http(s)` schemes and - unless `MCP_ALLOW_PRIVATE_URLS=1` - any host resolving to a loopback, private, link-local (incl. cloud metadata `169.254.169.254`), CGNAT, multicast or reserved address. Every redirect hop is re-validated, so a public URL cannot bounce into the internal network. |
| **Resource exhaustion** | Bodies are capped at 4 MiB per JSON-RPC request, URL responses and local files at 64 MiB (`MCP_MAX_URL_BYTES` / `MCP_MAX_FILE_BYTES`), fetches time out after 15 s and at most 3 redirects are followed. Concurrent sessions are capped (`MCP_MAX_SESSIONS`, 100) and idle ones are reaped (`MCP_SESSION_TTL_SECONDS`, 30 min) so a client cannot pin memory, sockets or upstream connections by opening sessions it never closes. |
| **Rate limiting** | The sliding-window limiter is shared across HTTP sessions, so opening a new session cannot reset it. `compact` (which spends tokens) is also rate limited. |
| **Error handling** | Internal error details are logged server-side only; clients get a generic message plus a correlation `ref`. Unknown routes answer JSON, not stack traces. |
| **Credentials** | `.env` and `.env.*` are gitignored (only `.env.example` is tracked). In Kubernetes the key and token come from Secrets via `secretKeyRef`, never from values or args in the manifest. |

**What is not covered - read before exposing this server:**

- `vision_from_file` reads whatever the process can read, and the URL tools fetch
  whatever the network allows. **Anyone who can call `/mcp` gets that same
  access** (file read + reachable HTTP endpoints), so treat the bearer token like
  a shell credential: no public ingress, no shared tokens, keep it behind a
  private network.
- Path and URL access is intentionally unrestricted (that is the point of the
  tools). There is no per-directory sandbox; run it in a container or under a
  dedicated user if you need one.
- The token is a shared secret with no rotation or expiry: rotate it by changing
  `MCP_AUTH_TOKEN` and restarting, and restart pods after updating the Secret.
- The rate limiter lives in process memory. With `replicaCount > 1` each pod keeps
  its own window, so the effective limit is `RATE_LIMIT_REQUESTS` multiplied by replicas. Use a
  single replica or a shared store (Redis) if you need a global limit.
- Media sent through the tools leaves the machine for the Gemini API - do not
  feed it anything you would not send to Google.


## Testing

```bash
pnpm test        # unit tests (vitest, no API key or network needed)
pnpm test:live  # live integration test against the real Gemini Live API
```

Unit tests use vitest plus the MCP SDK's `InMemoryTransport` (there is no
dedicated MCP unit-testing tool, so this is the standard approach: an
in-memory client talks to the real server with stubbed env). They cover the
rate limiter, token-usage accounting, media helpers, tool registration, the
`config://gemini-vision` resource, missing-key handling, and rate-limit
enforcement - all hermetic via `vi.stubEnv` + `vi.resetModules()`.

`tests/http.test.ts` boots the real Express app on an ephemeral port and checks
the transport security: bearer auth (missing/wrong/valid), fail-closed startup
on a public interface, `Host` and `Origin` rejection, JSON error responses, and
that `/health` stays public. `tests/helpers.test.ts` additionally covers the SSRF
blocklist, redirect re-validation and the size caps (no network needed).

`tests/live.test.ts` boots `dist/` over stdio and exercises every tool in one
session: all six file tools (plus aliases) against downloaded fixtures, a
`new_vision` reset asserting zeroed usage, all six URL tools (plus aliases),
length-mismatch and missing-file error paths, `compact`, and `gemini_usage`.
It raises `RATE_LIMIT_REQUESTS` to 100 for the server subprocess so the
default 10 req/60s limiter doesn't interfere. Costs roughly 15k input tokens.

## Architecture

- **`src/server.ts`** - MCP server, tool registration, rate limiting
- **`src/gemini-live.ts`** - Persistent Gemini Live WebSocket client with auto-reconnect, history tracking, and self-compaction
- **`src/rate-limiter.ts`** - Sliding window rate limiter
- **`src/http.ts`** - Streamable HTTP transport, bearer auth, host/origin validation, error sanitization
- **`src/index.ts`** - CLI entry, `--transport stdio|http`
- **`src/tool/`** - Tool implementations (compact, file, files, files_mixed, gemini_usage, new_vision, resource, resources, resources_mixed) plus `_helpers.ts` (mime detection, URL/file size caps and SSRF guards)
- **`src/event/`** - Background TPM monitoring

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for the
copyright holder.

The software is provided **"as is", without warranty or condition of any kind**,
and the author is not liable for any damages or losses arising from its use,
misuse or modification - see Section 7 (Disclaimer of Warranty) and Section 8 (Limitation of
Liability) of the license text.

If you are modifying it and want others to know, Section 4(b) requires you to carry
prominent notices stating that you changed the files.

Found a security problem? Read [SECURITY.md](SECURITY.md) before opening an issue.

