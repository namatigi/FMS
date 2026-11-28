"""/healthz (liveness), /readyz (database reachable) and /metrics."""

from __future__ import annotations

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.urls import path

from .db import ping
from .jsonutil import json_response
from .metrics import metrics_view


def healthz(request: HttpRequest) -> HttpResponse:
    return json_response({"status": "ok"})


def readyz(request: HttpRequest) -> HttpResponse:
    try:
        ping("default")
        if settings.RO_ALIAS != "default":
            ping(settings.RO_ALIAS)
        return json_response({"status": "ready"})
    except Exception as e:  # noqa: BLE001
        return json_response({"error": {"code": "not_ready", "message": str(e)}}, status=503)


urlpatterns = [
    path("healthz", healthz),
    path("readyz", readyz),
    path("metrics", metrics_view),
]
