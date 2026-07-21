import base64
import logging
from pathlib import Path
from typing import Literal

from fastmcp import FastMCP

from ._helpers import detect_mime

logger = logging.getLogger(__name__)


def register(mcp: FastMCP, get_gemini, check_api_key, check_rate, lock):

	@mcp.tool
	async def vision_from_files_mixed(
		types: list[Literal["text", "image", "audio", "video"]],
		prompt: str,
		paths: list[str],
		compact: bool = False,
	) -> str:
		"""Describe multiple files of mixed types in one Gemini session.

		Args:
			types: List of media categories, one per file (text, image, audio, video).
			prompt: Instructions to the model (what to describe/extract).
			paths: List of local file paths (must match length of types).
			compact: If true, compact history and reconnect after this request.

		Returns:
			Gemini's combined description of all files.
		"""
		try:
			check_api_key()
			await check_rate()
			async with lock:
				if len(types) != len(paths):
					return f"Error: types ({len(types)}) and paths ({len(paths)}) must have same length"
				images = []
				for media_type, path in zip(types, paths):
					p = Path(path)
					if not p.exists():
						return f"Error: File not found: {path}"
					if media_type == "text":
						text = p.read_text(encoding="utf-8", errors="replace")
						images.append({"data": base64.b64encode(text.encode()).decode(), "mime_type": "text/plain"})
					else:
						mime = detect_mime(p, media_type)
						b64 = base64.b64encode(p.read_bytes()).decode()
						images.append({"data": b64, "mime_type": mime})
				return await get_gemini().describe_images(images, prompt=prompt, compact=compact)
		except Exception as e:
			logger.exception("vision_from_files_mixed failed")
			return f"Error: {e}"

	@mcp.tool
	async def from_files_mixed(
		types: list[Literal["text", "image", "audio", "video"]],
		prompt: str,
		paths: list[str],
		compact: bool = False,
	) -> str:
		"""Alias for vision_from_files_mixed — describe mixed-type files using Gemini.

		Args:
			types: List of media categories, one per file (text, image, audio, video).
			prompt: Instructions to the model (what to describe/extract).
			paths: List of local file paths (must match length of types).
			compact: If true, compact history and reconnect after this request.

		Returns:
			Gemini's combined description of all files.
		"""
		try:
			check_api_key()
			await check_rate()
			async with lock:
				if len(types) != len(paths):
					return f"Error: types ({len(types)}) and paths ({len(paths)}) must have same length"
				images = []
				for media_type, path in zip(types, paths):
					p = Path(path)
					if not p.exists():
						return f"Error: File not found: {path}"
					if media_type == "text":
						text = p.read_text(encoding="utf-8", errors="replace")
						images.append({"data": base64.b64encode(text.encode()).decode(), "mime_type": "text/plain"})
					else:
						mime = detect_mime(p, media_type)
						b64 = base64.b64encode(p.read_bytes()).decode()
						images.append({"data": b64, "mime_type": mime})
				return await get_gemini().describe_images(images, prompt=prompt, compact=compact)
		except Exception as e:
			logger.exception("from_files_mixed failed")
			return f"Error: {e}"
