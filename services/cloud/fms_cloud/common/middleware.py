"""Cross-cutting HTTP behaviour shared by the core and ingest services."""

from __future__ import annotations

import logging
import time
import uuid
from typing import ClassVar

from django.conf import settings
from django.db import DatabaseError
from django.http import HttpRequest, HttpResponse

from .errors import HttpError, from_db_error
from .jsonutil import json_response
from .metrics import HTTP_DURATION

log = logging.getLogger("fms.http")


class RequestIdMiddleware:
    """X-Request-Id: reuse the caller's, else generate. Available as request.id."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        request.id = request.headers.get("X-Request-Id") or str(uuid.uuid4())
        response = self.get_response(request)
        response["X-Request-Id"] = request.id
        return response


class SecurityHeadersMiddleware:
    """The helmet defaults core-api used (no CSP; cross-origin resource policy)."""

    HEADERS: ClassVar[dict[str, str]] = {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Cross-Origin-Opener-Policy": "same-origin",
        "X-DNS-Prefetch-Control": "off",
        "Strict-Transport-Security": "max-age=15552000; includeSubDomains",
    }

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        response = self.get_response(request)
        for k, v in self.HEADERS.items():
            response.headers.setdefault(k, v)
        return response


class CorsMiddleware:
    """CORS_ORIGINS: empty or '*' reflects any origin (credentials allowed), else a comma list."""

    METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    HEADERS = "Authorization, Content-Type, X-API-Key, X-Request-Id"

    def __init__(self, get_response):
        self.get_response = get_response
        raw = settings.CORS_ORIGINS
        self.any = raw in ("", "*")
        self.allowed = {o.strip() for o in raw.split(",") if o.strip()}

    def __call__(self, request: HttpRequest) -> HttpResponse:
        origin = request.headers.get("Origin")
        ok = bool(origin) and (self.any or origin in self.allowed)
        if request.method == "OPTIONS" and ok and request.headers.get("Access-Control-Request-Method"):
            response = HttpResponse(status=204)
            response["Access-Control-Allow-Methods"] = self.METHODS
            response["Access-Control-Allow-Headers"] = request.headers.get("Access-Control-Request-Headers") or self.HEADERS
            response["Access-Control-Max-Age"] = "600"
        else:
            response = self.get_response(request)
        if ok:
            response["Access-Control-Allow-Origin"] = origin
            response["Access-Control-Allow-Credentials"] = "true"
            response["Vary"] = "Origin"
        return response


class MetricsMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        t0 = time.perf_counter()
        response = self.get_response(request)
        match = getattr(request, "resolver_match", None)
        route = getattr(request, "metrics_route", None) or (match.route if match else "unmatched")
        HTTP_DURATION.labels(request.method, route or "unmatched", str(response.status_code)).observe(time.perf_counter() - t0)
        return response


class JsonErrorMiddleware:
    """Last line of defence: HttpError / database errors / crashes -> JSON error bodies."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        return self.get_response(request)

    def process_exception(self, request: HttpRequest, exc: Exception) -> HttpResponse | None:
        return error_response(request, exc)


def error_response(request: HttpRequest, exc: BaseException) -> HttpResponse:
    if isinstance(exc, HttpError):
        return json_response(exc.body(), status=exc.status_code, headers=exc.headers)
    if isinstance(exc, DatabaseError):
        mapped = from_db_error(exc)
        if mapped:
            return json_response(mapped.body(), status=mapped.status_code)
    log.error("unhandled error", exc_info=exc, extra={"path": request.path, "request_id": getattr(request, "id", None)})
    return json_response({"error": {"code": "internal_error", "message": "internal server error"}}, status=500)


def not_found_view(request: HttpRequest, exception: Exception | None = None) -> HttpResponse:
    return json_response({"error": {"code": "not_found", "message": f"route {request.method} {request.path} not found"}}, status=404)


def server_error_view(request: HttpRequest) -> HttpResponse:
    return json_response({"error": {"code": "internal_error", "message": "internal server error"}}, status=500)
