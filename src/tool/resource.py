import base64
import logging
import mimetypes
from typing import Literal

import httpx
from fastmcp import FastMCP

logger = logging.getLogger(__name__)


def register(mcp: FastMCP, get_gemini, check_api_key, check_rate, lock):

	@mcp.tool
	async def vision_from_resource(
		type: Literal["text", "image", "audio", "video"],
		prompt: str,
		resource: str,
		compact: bool = False,
	) -> str:
		"""Describe a URL resource using Gemini.

		Args:
			type: Media category — text, image, audio, or video.
			prompt: Instructions to the model (what to describe/extract).
			resource: URL to fetch.
			compact: If true, compact history and reconnect after this request.

		Returns:
			Gemini's description of the resource.
		"""
		try:
			check_api_key()
			await check_rate()
			async with lock:
				async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
					resp = await client.get(resource)
					resp.raise_for_status()
				content_type = resp.headers.get("content-type", "")
				if ";" in content_type:
					content_type = content_type.split(";")[0].strip()
				if not content_type or content_type == "application/octet-stream":
					guessed, _ = mimetypes.guess_type(resource)
					if guessed:
						content_type = guessed
				b64 = base64.b64encode(resp.content).decode()
				return await get_gemini().describe_image(
					b64, mime_type=content_type, prompt=prompt, compact=compact
				)
		except Exception as e:
			logger.exception("vision_from_resource failed")
			return f"Error: {e}"

	@mcp.tool
	async def from_resource(
		type: Literal["text", "image", "audio", "video"],
		prompt: str,
		resource: str,
		compact: bool = False,
	) -> str:
		"""Alias for vision_from_resource — describe a URL using Gemini.

		Args:
			type: Media category — text, image, audio, or video.
			prompt: Instructions to the model (what to describe/extract).
			resource: URL to fetch.
			compact: If true, compact history and reconnect after this request.

		Returns:
			Gemini's description of the resource.
		"""
		try:
			check_api_key()
			await check_rate()
			async with lock:
				async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
					resp = await client.get(resource)
					resp.raise_for_status()
				content_type = resp.headers.get("content-type", "")
				if ";" in content_type:
					content_type = content_type.split(";")[0].strip()
				if not content_type or content_type == "application/octet-stream":
					guessed, _ = mimetypes.guess_type(resource)
					if guessed:
						content_type = guessed
				b64 = base64.b64encode(resp.content).decode()
				return await get_gemini().describe_image(
					b64, mime_type=content_type, prompt=prompt, compact=compact
				)
		except Exception as e:
			logger.exception("from_resource failed")
			return f"Error: {e}"
