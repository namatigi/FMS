"""Global per-IP rate limit on /api/v1 (RATE_LIMIT_RPM), like core-api's v1 onRequest hook."""

from __future__ import annotations

from django.http import HttpRequest, HttpResponse

from ..common.jsonutil import json_response
from ..common.ratelimit import FixedWindow
from .auth import client_ip
from .config import config


class V1RateLimitMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response
        self.limiter = FixedWindow(config().rate_limit_rpm, 60)

    def __call__(self, request: HttpRequest) -> HttpResponse:
        if request.path.startswith("/api/v1/"):
            ok, retry = self.limiter.allow(client_ip(request))
            if not ok:
                return json_response(
                    {"error": {"code": "rate_limited", "message": "rate limit exceeded, retry in 1 minute"}},
                    status=429,
                    headers={"Retry-After": str(retry)},
                )
        return self.get_response(request)
