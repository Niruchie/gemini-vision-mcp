import base64
import logging
from pathlib import Path
from typing import Literal

from fastmcp import FastMCP

from ._helpers import detect_mime

logger = logging.getLogger(__name__)


def register(mcp: FastMCP, get_gemini, check_api_key, check_rate, lock):

	@mcp.tool
	async def vision_from_files(
		type: Literal["text", "image", "audio", "video"],
		prompt: str,
		paths: list[str],
		compact: bool = False,
	) -> str:
		"""Describe multiple files in one Gemini session.

		Args:
			type: Media category — text, image, audio, or video.
			prompt: Instructions to the model (what to describe/extract).
			paths: List of local file paths.
			compact: If true, compact history and reconnect after this request.

		Returns:
			Gemini's combined description of all files.
		"""
		try:
			check_api_key()
			await check_rate()
			async with lock:
				images = []
				for path in paths:
					p = Path(path)
					if not p.exists():
						return f"Error: File not found: {path}"
					if type == "text":
						text = p.read_text(encoding="utf-8", errors="replace")
						images.append({"data": base64.b64encode(text.encode()).decode(), "mime_type": "text/plain"})
					else:
						mime = detect_mime(p, type)
						b64 = base64.b64encode(p.read_bytes()).decode()
						images.append({"data": b64, "mime_type": mime})
				return await get_gemini().describe_images(images, prompt=prompt, compact=compact)
		except Exception as e:
			logger.exception("vision_from_files failed")
			return f"Error: {e}"

	@mcp.tool
	async def from_files(
		type: Literal["text", "image", "audio", "video"],
		prompt: str,
		paths: list[str],
		compact: bool = False,
	) -> str:
		"""Alias for vision_from_files — describe multiple files using Gemini.

		Args:
			type: Media category — text, image, audio, or video.
			prompt: Instructions to the model (what to describe/extract).
			paths: List of local file paths.
			compact: If true, compact history and reconnect after this request.

		Returns:
			Gemini's combined description of all files.
		"""
		try:
			check_api_key()
			await check_rate()
			async with lock:
				images = []
				for path in paths:
					p = Path(path)
					if not p.exists():
						return f"Error: File not found: {path}"
					if type == "text":
						text = p.read_text(encoding="utf-8", errors="replace")
						images.append({"data": base64.b64encode(text.encode()).decode(), "mime_type": "text/plain"})
					else:
						mime = detect_mime(p, type)
						b64 = base64.b64encode(p.read_bytes()).decode()
						images.append({"data": b64, "mime_type": mime})
				return await get_gemini().describe_images(images, prompt=prompt, compact=compact)
		except Exception as e:
			logger.exception("from_files failed")
			return f"Error: {e}"
