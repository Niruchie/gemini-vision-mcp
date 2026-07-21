import base64
import logging
import mimetypes
from typing import Literal

import httpx
from fastmcp import FastMCP

logger = logging.getLogger(__name__)


def register(mcp: FastMCP, get_gemini, check_api_key, check_rate, lock):

	@mcp.tool
	async def vision_from_resources(
		type: Literal["text", "image", "audio", "video"],
		prompt: str,
		resources: list[str],
		compact: bool = False,
	) -> str:
		"""Describe multiple URL resources in one Gemini session.

		Args:
			type: Media category — text, image, audio, or video.
			prompt: Instructions to the model (what to describe/extract).
			resources: List of URLs to fetch.
			compact: If true, compact history and reconnect after this request.

		Returns:
			Gemini's combined description of all resources.
		"""
		try:
			check_api_key()
			await check_rate()
			async with lock:
				images = []
				async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
					for url in resources:
						resp = await client.get(url)
						resp.raise_for_status()
						content_type = resp.headers.get("content-type", "")
						if ";" in content_type:
							content_type = content_type.split(";")[0].strip()
						if not content_type or content_type == "application/octet-stream":
							guessed, _ = mimetypes.guess_type(url)
							if guessed:
								content_type = guessed
						b64 = base64.b64encode(resp.content).decode()
						images.append({"data": b64, "mime_type": content_type})
				return await get_gemini().describe_images(images, prompt=prompt, compact=compact)
		except Exception as e:
			logger.exception("vision_from_resources failed")
			return f"Error: {e}"

	@mcp.tool
	async def from_resources(
		type: Literal["text", "image", "audio", "video"],
		prompt: str,
		resources: list[str],
		compact: bool = False,
	) -> str:
		"""Alias for vision_from_resources — describe multiple URLs using Gemini.

		Args:
			type: Media category — text, image, audio, or video.
			prompt: Instructions to the model (what to describe/extract).
			resources: List of URLs to fetch.
			compact: If true, compact history and reconnect after this request.

		Returns:
			Gemini's combined description of all resources.
		"""
		try:
			check_api_key()
			await check_rate()
			async with lock:
				images = []
				async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
					for url in resources:
						resp = await client.get(url)
						resp.raise_for_status()
						content_type = resp.headers.get("content-type", "")
						if ";" in content_type:
							content_type = content_type.split(";")[0].strip()
						if not content_type or content_type == "application/octet-stream":
							guessed, _ = mimetypes.guess_type(url)
							if guessed:
								content_type = guessed
						b64 = base64.b64encode(resp.content).decode()
						images.append({"data": b64, "mime_type": content_type})
				return await get_gemini().describe_images(images, prompt=prompt, compact=compact)
		except Exception as e:
			logger.exception("from_resources failed")
			return f"Error: {e}"
