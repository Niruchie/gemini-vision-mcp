import logging

from fastmcp import FastMCP

logger = logging.getLogger(__name__)


def register(mcp: FastMCP, get_gemini, check_api_key):

	@mcp.tool
	async def compact() -> str:
		"""Compact conversation history and reconnect.

		Summarizes older turns, keeps recent ones verbatim, and replays
		into a fresh Gemini Live session so context carries over.
		Use instead of new_vision when you want to preserve context.
		"""
		try:
			check_api_key()
			gemini = get_gemini()
			if not gemini:
				return "No active session"
			return await gemini.compact()
		except Exception as e:
			logger.exception("compact failed")
			return f"Error: {e}"
