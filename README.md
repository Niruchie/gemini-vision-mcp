# gemini-vision-mcp

MCP server for describing video, image, audio, and text using the Gemini 3.1 Flash Live API.

Uses a persistent WebSocket session (Google GenAI Live API) to describe media content through [FastMCP](https://github.com/jlowin/fastmcp).

## Requirements

- Python 3.11+
- Google API key with Gemini access

## Install

```bash
uv pip install gemini-vision-mcp
```

Or run directly with `uvx`:

```bash
uvx gemini-vision-mcp
```

## Configuration

Copy `.env.example` to `.env` and fill in your API key:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `GOOGLE_API_KEY` | — | Required. Your Google Gemini API key |
| `GEMINI_MODEL` | `gemini-3.1-flash-live-preview` | Gemini model to use (More models to be tested.) |
| `GEMINI_TPM_LIMIT` | `4000000` | Tokens per minute limit for auto-refresh |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Rate limit window in seconds |
| `RATE_LIMIT_REQUESTS` | `10` | Max requests per rate window |

## Usage

Run with `uvx`:

```bash
uvx --no-cache --from . gemini-vision-mcp
```

This project uses `uvx` for running and `venv` for development.

### MCP Client Configuration

Add to your MCP client (e.g. opencode `opencode.json`):

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
      "command": [
        "uvx",
        "--no-cache",
        "--from",
        ".",
        "gemini-vision-mcp"
      ]
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

- **`type`**: Media category — `text`, `image`, `audio`, or `video`
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

- **70% TPM** — Auto-compaction: the model summarizes the conversation history, then reconnects with the summary as context. History shrinks, session continues.
- **75% TPM** — Hard refresh: reconnects with whatever compacted history exists. Use `new_vision` to reset completely (loses all context).

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

## Architecture

- **`src/server.py`** — FastMCP server, tool registration, rate limiting
- **`src/gemini_live.py`** — Persistent Gemini Live WebSocket client with auto-reconnect, history tracking, and self-compaction
- **`src/rate_limiter.py`** — Sliding window rate limiter
- **`src/tool/`** — Tool implementations (compact, file, files, files_mixed, gemini_usage, new_vision, resource, resources, resources_mixed)
- **`src/event/`** — Background TPM monitoring
