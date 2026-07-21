import json
import logging

from fastmcp import FastMCP

logger = logging.getLogger(__name__)


def register(mcp: FastMCP, get_gemini, check_api_key):

	@mcp.tool
	async def gemini_usage() -> str:
		"""Get current Gemini API usage statistics.

		Returns token usage stats including input/output tokens and rate limit status.
		"""
		try:
			check_api_key()
			gemini = get_gemini()
			if not gemini:
				return "No active session"
			stats = gemini.usage.to_dict()
			return json.dumps(stats, indent=2)
		except Exception as e:
			logger.exception("gemini_usage failed")
			return f"Error: {e}"
