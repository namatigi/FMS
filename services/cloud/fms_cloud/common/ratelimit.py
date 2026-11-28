"""In-process rate limiters (per worker process, like @fastify/rate-limit's default memory store)."""

from __future__ import annotations

import threading
import time


class FixedWindow:
    """N requests per window seconds per key. allow() -> (ok, retry_after_seconds)."""

    def __init__(self, limit: int, window_s: float = 60.0) -> None:
        self.limit = limit
        self.window_s = window_s
        self._lock = threading.Lock()
        self._hits: dict[str, tuple[float, int]] = {}

    def allow(self, key: str) -> tuple[bool, int]:
        now = time.monotonic()
        with self._lock:
            start, n = self._hits.get(key, (now, 0))
            if now - start >= self.window_s:
                start, n = now, 0
            n += 1
            self._hits[key] = (start, n)
            if len(self._hits) > 50_000:  # bound memory: drop expired windows
                self._hits = {k: v for k, v in self._hits.items() if now - v[0] < self.window_s}
            if n > self.limit:
                return False, max(1, int(self.window_s - (now - start)) + 1)
            return True, 0


class TokenBucket:
    """rate tokens/second, burst capacity per key. take() -> seconds to wait (0 = allowed). Port of ingest-api ratelimit.ts."""

    def __init__(self, rate_per_s: float, burst: float) -> None:
        self.rate = rate_per_s
        self.burst = burst
        self._lock = threading.Lock()
        self._b: dict[str, tuple[float, float]] = {}

    def take(self, key: str, cost: float = 1) -> int:
        if self.rate <= 0:  # RATE_LIMIT_RPS=0 disables limiting
            return 0
        now = time.monotonic()
        with self._lock:
            tokens, ts = self._b.get(key, (self.burst, now))
            tokens = min(self.burst, tokens + (now - ts) * self.rate)
            if len(self._b) > 100_000:
                self._b = {k: v for k, v in self._b.items() if now - v[1] <= 60}
            if tokens >= cost:
                self._b[key] = (tokens - cost, now)
                return 0
            self._b[key] = (tokens, now)
            import math

            return max(1, math.ceil((cost - tokens) / self.rate))
