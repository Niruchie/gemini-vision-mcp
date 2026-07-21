import asyncio
import logging
import time
from typing import Optional

from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

# TPM safety threshold: refresh session when usage exceeds this fraction of the limit
TPM_REFRESH_THRESHOLD = 0.75
# TPM compaction threshold: ask model to summarize history at this fraction
TPM_COMPACT_THRESHOLD = 0.70
# Default TPM limit for gemini-3.1-flash-live-preview (configurable)
DEFAULT_TPM_LIMIT = 4_000_000
# Sliding window size in tokens for context compression
SLIDING_WINDOW_TOKENS = 8_000
# Trigger compression at this many tokens
COMPRESSION_TRIGGER_TOKENS = 25_000
# Number of recent turns to keep verbatim during compaction
KEEP_RECENT_TURNS = 3
# Max chars for excerpted response during compaction
EXCERPT_MAX_CHARS = 200


class UsageStats:
	"""Track token usage across the session lifetime."""

	def __init__(self):
		self.total_input_tokens = 0
		self.total_output_tokens = 0
		self.total_tokens = 0
		self.turn_count = 0
		self.session_count = 0
		self.last_turn_tokens = 0
		self.last_turn_time: Optional[float] = None
		self.tpm_limit = DEFAULT_TPM_LIMIT
		self._turn_window: list[tuple[float, int]] = []  # (timestamp, tokens)

	def record_turn(self, usage_metadata):
		"""Record token usage from a usage_metadata response."""
		if usage_metadata is None:
			return

		input_tokens = getattr(usage_metadata, "prompt_token_count", 0) or 0
		output_tokens = getattr(usage_metadata, "candidates_token_count", 0) or 0
		total = getattr(usage_metadata, "total_token_count", 0) or 0

		self.total_input_tokens += input_tokens
		self.total_output_tokens += output_tokens
		self.total_tokens += total
		self.turn_count += 1
		self.last_turn_tokens = total
		self.last_turn_time = time.time()

		# Track rolling window for TPM estimation
		now = time.time()
		self._turn_window.append((now, input_tokens))
		# Keep only last 60 seconds
		self._turn_window = [(t, tok) for t, tok in self._turn_window if now - t < 60]

	@property
	def current_tpm(self) -> int:
		"""Estimate current tokens per minute from rolling window."""
		if not self._turn_window:
			return 0
		return sum(tok for _, tok in self._turn_window)

	@property
	def tpm_usage_pct(self) -> float:
		"""Percentage of TPM limit currently used."""
		if self.tpm_limit <= 0:
			return 0.0
		return (self.current_tpm / self.tpm_limit) * 100

	@property
	def needs_refresh(self) -> bool:
		"""Whether TPM usage exceeds the hard refresh threshold."""
		return self.tpm_usage_pct >= (TPM_REFRESH_THRESHOLD * 100)

	@property
	def needs_compact(self) -> bool:
		"""Whether TPM usage exceeds the compaction threshold."""
		return self.tpm_usage_pct >= (TPM_COMPACT_THRESHOLD * 100)

	def to_dict(self) -> dict:
		return {
			"total_input_tokens": self.total_input_tokens,
			"total_output_tokens": self.total_output_tokens,
			"total_tokens": self.total_tokens,
			"turn_count": self.turn_count,
			"session_count": self.session_count,
			"last_turn_tokens": self.last_turn_tokens,
			"current_tpm": self.current_tpm,
			"tpm_limit": self.tpm_limit,
			"tpm_usage_pct": round(self.tpm_usage_pct, 1),
			"needs_refresh": self.needs_refresh,
		}


class GeminiLiveClient:
	"""Persistent Gemini 3.1 Flash Live session using the official SDK."""

	def __init__(
		self,
		api_key: str,
		model: str = "gemini-3.1-flash-live-preview",
		tpm_limit: int = DEFAULT_TPM_LIMIT,
	):
		self.api_key = api_key
		self.model = model
		self._client = genai.Client(api_key=api_key)
		self._session: Optional[any] = None
		self._context = None
		self._lock = asyncio.Lock()
		self.usage = UsageStats()
		self.usage.tpm_limit = tpm_limit
		self._history: list[dict] = []  # [{"prompt": str, "response": str}, ...]

	@property
	def connected(self) -> bool:
		return self._session is not None

	def _record_turn(self, prompt: str, response: str):
		self._history.append({"prompt": prompt, "response": response})

	def _compact_history(self) -> str:
		if not self._history:
			return ""
		recent = self._history[-KEEP_RECENT_TURNS:]
		old = self._history[:-KEEP_RECENT_TURNS]
		if not old:
			lines = []
			for h in recent:
				lines.append(f"User: {h['prompt']}")
				lines.append(f"Assistant: {h['response']}")
			return "\n".join(lines)
		summary_lines = []
		for h in old:
			excerpt = h["response"][:EXCERPT_MAX_CHARS]
			if len(h["response"]) > EXCERPT_MAX_CHARS:
				excerpt += "..."
			summary_lines.append(f"- {h['prompt']} → {excerpt}")
		summary = "Previous conversation context:\n" + "\n".join(summary_lines)
		recent_lines = []
		for h in recent:
			recent_lines.append(f"User: {h['prompt']}")
			recent_lines.append(f"Assistant: {h['response']}")
		return summary + "\n\nRecent conversation:\n" + "\n".join(recent_lines)

	async def _replay_history(self):
		compacted = self._compact_history()
		if not compacted:
			return
		content = types.Content(
			role="user",
			parts=[types.Part(text=f"[Conversation context]\n{compacted}")],
		)
		await self._session.send_client_content(turns=content, turn_complete=False)
		logger.info(f"Replayed {len(self._history)} turns into new session")

	async def _ensure_connected(self):
		if self._session is not None:
			return
		async with self._lock:
			if self._session is not None:
				return
			await self._connect()

	async def _connect(self):
		config = types.LiveConnectConfig(
			response_modalities=["AUDIO"],
			output_audio_transcription=types.AudioTranscriptionConfig(),
			context_window_compression=types.ContextWindowCompressionConfig(
				sliding_window=types.SlidingWindow(),
				trigger_tokens=COMPRESSION_TRIGGER_TOKENS,
			),
		)
		self._context = self._client.aio.live.connect(
			model=self.model,
			config=config,
		)
		self._session = await self._context.__aenter__()
		self.usage.session_count += 1
		logger.info(
			f"Gemini Live session connected (session #{self.usage.session_count})"
		)

	async def _reconnect(self):
		await self.close()
		await self._connect()
		await self._replay_history()

	async def describe_image(
		self,
		image_b64: str,
		mime_type: str = "image/jpeg",
		prompt: str = "Describe this image in detail.",
		timeout: float = 30.0,
		compact: bool = False,
	) -> str:
		await self._check_tpm_refresh()
		await self._ensure_connected()
		try:
			content = types.Content(
				role="user",
				parts=[
					types.Part(
						inline_data=types.Blob(data=image_b64, mime_type=mime_type)
					),
					types.Part(text=prompt),
				],
			)
			await self._session.send_client_content(turns=content, turn_complete=True)
			response = await self._receive(timeout)
			self._record_turn(prompt, response)
			if compact:
				await self._compact_and_reconnect()
			return response
		except Exception as e:
			logger.warning(f"Session error, reconnecting: {e}")
			await self._reconnect()
			content = types.Content(
				role="user",
				parts=[
					types.Part(
						inline_data=types.Blob(data=image_b64, mime_type=mime_type)
					),
					types.Part(text=prompt),
				],
			)
			await self._session.send_client_content(turns=content, turn_complete=True)
			response = await self._receive(timeout)
			self._record_turn(prompt, response)
			if compact:
				await self._compact_and_reconnect()
			return response

	async def describe_images(
		self,
		images: list[dict],
		prompt: str = "Describe these images in detail.",
		timeout: float = 45.0,
		compact: bool = False,
	) -> str:
		await self._check_tpm_refresh()
		await self._ensure_connected()
		try:
			parts = []
			for img in images:
				parts.append(
					types.Part(
						inline_data=types.Blob(
							data=img["data"], mime_type=img["mime_type"]
						)
					)
				)
			parts.append(types.Part(text=prompt))
			content = types.Content(role="user", parts=parts)
			await self._session.send_client_content(turns=content, turn_complete=True)
			response = await self._receive(timeout)
			self._record_turn(prompt, response)
			if compact:
				await self._compact_and_reconnect()
			return response
		except Exception as e:
			logger.warning(f"Session error, reconnecting: {e}")
			await self._reconnect()
			parts = []
			for img in images:
				parts.append(
					types.Part(
						inline_data=types.Blob(
							data=img["data"], mime_type=img["mime_type"]
						)
					)
				)
			parts.append(types.Part(text=prompt))
			content = types.Content(role="user", parts=parts)
			await self._session.send_client_content(turns=content, turn_complete=True)
			response = await self._receive(timeout)
			self._record_turn(prompt, response)
			if compact:
				await self._compact_and_reconnect()
			return response

	async def _receive(self, timeout: float = 30.0) -> str:
		parts: list[str] = []
		deadline = asyncio.get_event_loop().time() + timeout

		while True:
			remaining = deadline - asyncio.get_event_loop().time()
			if remaining <= 0:
				break
			try:
				async with asyncio.timeout(remaining):
					async for response in self._session.receive():
						# Track token usage from every response
						if response.usage_metadata:
							self.usage.record_turn(response.usage_metadata)
							if self.usage.needs_refresh:
								logger.warning(
									f"TPM threshold reached ({self.usage.tpm_usage_pct}%), "
									f"scheduling session refresh"
								)

						if response.server_content:
							tc = response.server_content.output_transcription
							if tc and tc.text:
								parts.append(tc.text)
							if response.server_content.turn_complete:
								return (
									"\n".join(parts)
									if parts
									else "(no description returned)"
								)
			except asyncio.TimeoutError:
				break

		return "\n".join(parts) if parts else "(no description returned)"

	async def _self_compact(self) -> str:
		"""Ask Gemini to summarize the conversation history. Returns the summary."""
		if not self._history or not self._session:
			return ""
		full_transcript = []
		for h in self._history:
			full_transcript.append(f"User: {h['prompt']}")
			full_transcript.append(f"Assistant: {h['response']}")
		transcript = "\n".join(full_transcript)
		compact_prompt = (
			"Summarize the following conversation into a concise context block. "
			"Preserve all key facts, topics discussed, decisions made, and important details. "
			"Keep it under 500 words.\n\n"
			f"{transcript}"
		)
		content = types.Content(
			role="user",
			parts=[types.Part(text=compact_prompt)],
		)
		await self._session.send_client_content(turns=content, turn_complete=True)
		summary = await self._receive(timeout=30.0)
		return summary

	async def _check_tpm_refresh(self):
		"""Handle TPM thresholds: compact at 70%, hard refresh at 75%."""
		if self.usage.needs_refresh and self._session is not None:
			logger.info(
				f"Hard refresh: TPM at {self.usage.tpm_usage_pct}% "
				f"({self.usage.current_tpm}/{self.usage.tpm_limit})"
			)
			await self._reconnect()
		elif self.usage.needs_compact and self._session is not None:
			logger.info(
				f"Auto-compacting: TPM at {self.usage.tpm_usage_pct}% "
				f"({self.usage.current_tpm}/{self.usage.tpm_limit})"
			)
			summary = await self._self_compact()
			if summary and summary != "(no description returned)":
				self._history = [{"prompt": "[conversation summary]", "response": summary}]
				logger.info(f"Self-compacted to summary ({len(summary)} chars)")
			else:
				compact_text = self._compact_history()
				if compact_text:
					self._history = [{"prompt": "[conversation summary]", "response": compact_text}]
					logger.info(f"Fallback compaction ({len(compact_text)} chars)")
			await self._reconnect()

	async def _compact_and_reconnect(self):
		"""Ask model to compact history, then reconnect with summary."""
		if not self._history:
			await self._reconnect()
			return
		logger.info(
			f"Compacting history ({len(self._history)} turns) via self-summarization"
		)
		summary = await self._self_compact()
		if summary and summary != "(no description returned)":
			self._history = [{"prompt": "[conversation summary]", "response": summary}]
			logger.info(f"Self-compacted to summary ({len(summary)} chars)")
		else:
			compact_text = self._compact_history()
			if compact_text:
				self._history = [{"prompt": "[conversation summary]", "response": compact_text}]
				logger.info(f"Fallback compaction ({len(compact_text)} chars)")
		await self._reconnect()

	async def compact(self) -> str:
		"""Compact history via self-summarization and reconnect."""
		if not self._history:
			return "No history to compact."
		turn_count = len(self._history)
		summary = await self._self_compact()
		if summary and summary != "(no description returned)":
			self._history = [{"prompt": "[conversation summary]", "response": summary}]
			method = "self-summarized"
			size = len(summary)
		else:
			compact_text = self._compact_history()
			self._history = [{"prompt": "[conversation summary]", "response": compact_text}]
			method = "fallback excerpt"
			size = len(compact_text)
		await self._reconnect()
		return f"Compacted {turn_count} turns ({method}, {size} chars) and reconnected."

	async def close(self):
		if self._context and self._session:
			try:
				await self._context.__aexit__(None, None, None)
			except Exception:
				pass
		self._session = None
		self._context = None
