import os
import asyncio
import logging
import json

from dotenv import load_dotenv
from fastmcp import FastMCP

from .gemini_live import GeminiLiveClient
from .rate_limiter import RateLimiter
from .tool import (
	compact as tool_compact,
	file as tool_file,
	files as tool_files,
	files_mixed as tool_files_mixed,
	gemini_usage as tool_gemini_usage,
	new_vision as tool_new_vision,
	resource as tool_resource,
	resources as tool_resources,
	resources_mixed as tool_resources_mixed,
)
from .event import start_tpm_monitor

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

API_KEY = os.environ.get("GOOGLE_API_KEY", "")
MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.1-flash-live-preview")
RATE_LIMIT = int(os.environ.get("RATE_LIMIT_REQUESTS", "10"))
RATE_WINDOW = float(os.environ.get("RATE_LIMIT_WINDOW_SECONDS", "60"))
TPM_LIMIT = int(os.environ.get("GEMINI_TPM_LIMIT", "4000000"))

LLM_INSTRUCTIONS = """## Gemini Vision MCP Server

Tools for describing media content using Gemini 3.1 Flash Live API.
Persistent WebSocket connection — one session shared across all tool calls.

### Tools

| Tool | Description |
|------|-------------|
| `vision_from_file` | Describe a single file (image, audio, video, or text) |
| `from_file` | Alias for `vision_from_file` |
| `vision_from_files` | Describe multiple files in one request |
| `from_files` | Alias for `vision_from_files` |
| `vision_from_resource` | Describe a URL resource |
| `from_resource` | Alias for `vision_from_resource` |
| `vision_from_resources` | Describe multiple URL resources |
| `from_resources` | Alias for `vision_from_resources` |
| `vision_from_files_mixed` / `from_files_mixed` | Multiple files with different types |
| `vision_from_resources_mixed` / `from_resources_mixed` | Multiple URLs with different types |
| `new_vision` | Force a fresh Gemini Live session (loses context) |
| `compact` | Summarize history via model, reconnect with summary |
| `gemini_usage` | Report current token usage and TPM status |

### Parameters

- `type`: Media category — `text`, `image`, `audio`, or `video`
- `prompt`: Instructions to the model (what to describe/extract)
- `path`: Local file path (file tools)
- `resource`: URL to fetch (resource tools)
- `compact`: If true, auto-compact history after this request (vision tools only)

### Usage

1. Use `type` to specify the media category
2. Provide a clear `prompt` — e.g., "Extract all text from this image" or "Describe the UI layout"
3. Use plural tools (`from_files`, `from_resources`) for batch processing
4. Call `compact` to summarize history and keep the session alive
5. Call `new_vision` to reset completely (loses all context)
6. Auto-compaction triggers at 70% TPM, hard refresh at 75%
7. Rate limit: 10 requests per 60 seconds (configurable via RATE_LIMIT_REQUESTS env var)
"""

mcp = FastMCP("gemini-vision", instructions=LLM_INSTRUCTIONS)

_gemini: GeminiLiveClient | None = None
limiter = RateLimiter(max_requests=RATE_LIMIT, window_seconds=RATE_WINDOW)
_request_lock = asyncio.Lock()  # Serialize all Gemini requests


def _get_gemini() -> GeminiLiveClient:
	global _gemini
	if _gemini is None:
		_gemini = GeminiLiveClient(api_key=API_KEY, model=MODEL, tpm_limit=TPM_LIMIT)
	return _gemini


def _check_api_key():
	if not API_KEY:
		raise Exception("GOOGLE_API_KEY not set")


async def _check_rate():
	if not await limiter.acquire():
		raise Exception(
			f"Rate limit exceeded. Try again in {RATE_WINDOW}s. ({limiter.remaining} remaining)"
		)
	gemini = _get_gemini()
	if gemini and gemini.usage.needs_refresh:
		raise Exception(
			f"TPM limit exceeded ({gemini.usage.tpm_usage_pct}%). "
			f"Call new_vision to reset session."
		)


async def _acquire_lock():
	"""Acquire the request lock. Returns an async context manager."""
	return _request_lock


client_holder = {"client": None}


def _get_client():
	global _gemini
	if _gemini is None:
		_gemini = GeminiLiveClient(api_key=API_KEY, model=MODEL, tpm_limit=TPM_LIMIT)
	client_holder["client"] = _gemini
	return _gemini


# Register tools
tool_file.register(mcp, _get_gemini, _check_api_key, _check_rate, _request_lock)
tool_files.register(mcp, _get_gemini, _check_api_key, _check_rate, _request_lock)
tool_files_mixed.register(mcp, _get_gemini, _check_api_key, _check_rate, _request_lock)
tool_resource.register(mcp, _get_gemini, _check_api_key, _check_rate, _request_lock)
tool_resources.register(mcp, _get_gemini, _check_api_key, _check_rate, _request_lock)
tool_resources_mixed.register(mcp, _get_gemini, _check_api_key, _check_rate, _request_lock)
tool_new_vision.register(mcp, _get_gemini, _check_api_key, client_holder)
tool_gemini_usage.register(mcp, _get_gemini, _check_api_key)
tool_compact.register(mcp, _get_gemini, _check_api_key)


@mcp.resource("config://gemini-vision")
def server_info() -> str:
	"""Return server configuration."""
	return json.dumps(
		{
			"name": "gemini-vision",
			"model": MODEL,
			"rate_limit": f"{RATE_LIMIT} requests / {RATE_WINDOW}s",
			"remaining": limiter.remaining,
			"tools": [
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
		indent=2,
	)


def main():
	mcp.run()


if __name__ == "__main__":
	main()
