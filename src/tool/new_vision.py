import logging

from fastmcp import FastMCP

logger = logging.getLogger(__name__)


def register(mcp: FastMCP, get_gemini, check_api_key, client_holder):

	@mcp.tool
	async def new_vision() -> str:
		"""Force a fresh Gemini Live session.

		Call this to reset the connection if it's stale or returns errors.
		Existing conversation history is lost.
		"""
		try:
			check_api_key()
			gemini = get_gemini()
			if gemini:
				await gemini.close()
			client_holder["client"] = None
			return "Session reset. Call any vision tool to start a fresh session."
		except Exception as e:
			logger.exception("new_vision failed")
			return f"Error: {e}"
