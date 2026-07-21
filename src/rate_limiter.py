import time
import asyncio
from collections import deque


class RateLimiter:
	"""Sliding window rate limiter."""

	def __init__(self, max_requests: int, window_seconds: float):
		self.max_requests = max_requests
		self.window_seconds = window_seconds
		self._timestamps: deque[float] = deque()
		self._lock = asyncio.Lock()

	async def acquire(self) -> bool:
		async with self._lock:
			now = time.monotonic()
			cutoff = now - self.window_seconds

			while self._timestamps and self._timestamps[0] <= cutoff:
				self._timestamps.popleft()

			if len(self._timestamps) >= self.max_requests:
				return False

			self._timestamps.append(now)
			return True

	@property
	def remaining(self) -> int:
		now = time.monotonic()
		cutoff = now - self.window_seconds
		while self._timestamps and self._timestamps[0] <= cutoff:
			self._timestamps.popleft()
		return max(0, self.max_requests - len(self._timestamps))
