"""Prometheus metrics. Service-specific metrics live next to their service (core/metrics.py etc.).

Under gunicorn with several worker processes set PROMETHEUS_MULTIPROC_DIR so
/metrics aggregates all workers (see deploy/cloud/gunicorn.conf.py).
"""

from __future__ import annotations

import os

from django.http import HttpRequest, HttpResponse
from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Histogram, generate_latest
from prometheus_client import REGISTRY as DEFAULT_REGISTRY

HTTP_DURATION = Histogram(
    "http_request_duration_seconds",
    "HTTP request duration",
    ["method", "route", "status"],
    buckets=[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
)


def registry() -> CollectorRegistry:
    if os.environ.get("PROMETHEUS_MULTIPROC_DIR"):
        from prometheus_client import multiprocess

        reg = CollectorRegistry()
        multiprocess.MultiProcessCollector(reg)
        return reg
    return DEFAULT_REGISTRY


def metrics_view(request: HttpRequest) -> HttpResponse:
    return HttpResponse(generate_latest(registry()), content_type=CONTENT_TYPE_LATEST)
