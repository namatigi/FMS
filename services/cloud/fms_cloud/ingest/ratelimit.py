"""Per-instance token bucket per key (gateway code / controller pts id). Port of ratelimit.ts.

take(key) -> 0 when allowed, otherwise the seconds to wait (Retry-After). rate <= 0 disables it.
"""

from __future__ import annotations

from fms_cloud.common.ratelimit import TokenBucket


class RateLimiter(TokenBucket):
    def __init__(self, rate_per_s: float, burst: float) -> None:
        super().__init__(rate_per_s, burst)
