import base64
import logging
from pathlib import Path
from typing import Literal

from fastmcp import FastMCP

from ._helpers import detect_mime, file_to_image_dict

logger = logging.getLogger(__name__)


def register(mcp: FastMCP, get_gemini, check_api_key, check_rate, lock):

	@mcp.tool
	async def vision_from_file(
		type: Literal["text", "image", "audio", "video"],
		prompt: str,
		path: str,
		compact: bool = False,
	) -> str:
		"""Describe a single file (image, audio, video, or text) using Gemini.

		Args:
			type: Media category — text, image, audio, or video.
			prompt: Instructions to the model (what to describe/extract).
			path: Local file path to read.
			compact: If true, compact history and reconnect after this request.

		Returns:
			Gemini's description of the file content.
		"""
		try:
			check_api_key()
			await check_rate()
			async with lock:
				p = Path(path)
				if not p.exists():
					return f"Error: File not found: {path}"

				if type == "text":
					text = p.read_text(encoding="utf-8", errors="replace")
					return await get_gemini().describe_image(
						base64.b64encode(text.encode()).decode(),
						mime_type="text/plain",
						prompt=prompt,
						compact=compact,
					)

				mime = detect_mime(p, type)
				b64 = base64.b64encode(p.read_bytes()).decode()
				return await get_gemini().describe_image(b64, mime_type=mime, prompt=prompt, compact=compact)
		except Exception as e:
			logger.exception("vision_from_file failed")
			return f"Error: {e}"

	@mcp.tool
	async def from_file(
		type: Literal["text", "image", "audio", "video"],
		prompt: str,
		path: str,
		compact: bool = False,
	) -> str:
		"""Alias for vision_from_file — describe a single file using Gemini.

		Args:
			type: Media category — text, image, audio, or video.
			prompt: Instructions to the model (what to describe/extract).
			path: Local file path to read.
			compact: If true, compact history and reconnect after this request.

		Returns:
			Gemini's description of the file content.
		"""
		try:
			check_api_key()
			await check_rate()
			async with lock:
				p = Path(path)
				if not p.exists():
					return f"Error: File not found: {path}"

				if type == "text":
					text = p.read_text(encoding="utf-8", errors="replace")
					return await get_gemini().describe_image(
						base64.b64encode(text.encode()).decode(),
						mime_type="text/plain",
						prompt=prompt,
						compact=compact,
					)

				mime = detect_mime(p, type)
				b64 = base64.b64encode(p.read_bytes()).decode()
				return await get_gemini().describe_image(b64, mime_type=mime, prompt=prompt, compact=compact)
		except Exception as e:
			logger.exception("from_file failed")
			return f"Error: {e}"
