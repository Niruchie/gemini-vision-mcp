import logging
import os

logger = logging.getLogger(__name__)

async def on_session_start(gemini_client_holder):
	logger.info("Gemini Live session started")
	return True

async def on_session_end(gemini_client_holder):
	gemini = gemini_client_holder.get("client")
	if gemini:
		stats = gemini.usage_stats
		if stats:
			logger.info(
				f"Session ended - Total tokens: {stats.total_tokens:,}, "
				f"Turns: {stats.turns}"
			)
		gemini.cleanup()
	gemini_client_holder["client"] = None
