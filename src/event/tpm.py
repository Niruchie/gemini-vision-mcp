import asyncio
import logging
import os
import time

logger = logging.getLogger(__name__)


async def start_tpm_monitor(gemini_client_holder):
	background_tasks = set()

	async def _monitor():
		while True:
			try:
				await asyncio.sleep(60)
				gemini = gemini_client_holder.get("client")
				if not gemini or not gemini.usage_stats:
					continue

				stats = gemini.usage_stats
				tpm_limit = int(os.getenv("GEMINI_TPM_LIMIT", 4000000))
				now = time.time()
				window = 60.0

				if stats.turn_timestamps:
					recent = [t for t in stats.turn_timestamps if now - t < window]
					tpm_used = len(recent)

					if tpm_used >= tpm_limit * 0.75:
						logger.warning(
							f"TPM threshold reached: {tpm_used}/{tpm_limit} "
							f"({tpm_used/tpm_limit*100:.1f}%)"
						)
						stats.add_event({
							"event": "tpm_threshold",
							"tpm_used": tpm_used,
							"tpm_limit": tpm_limit,
							"timestamp": now,
						})

						if tpm_used >= tpm_limit:
							logger.warning("TPM limit exceeded, refreshing session")
							gemini.cleanup()
							gemini_client_holder["client"] = None

			except asyncio.CancelledError:
				break
			except Exception:
				logger.exception("TPM monitor error")
				await asyncio.sleep(10)

	task = asyncio.create_task(_monitor())
	background_tasks.add(task)
	task.add_done_handler(background_tasks.discard)
	return task
