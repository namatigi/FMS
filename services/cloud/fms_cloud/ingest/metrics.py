"""Ingest metrics (port of services/ingest-api/src/metrics.ts), on the process-wide registry served at /metrics.

prom-client's default process metrics carried an fms_ingest_ prefix; prometheus_client's default
collectors (process_*, python_*) are unprefixed.
"""

from __future__ import annotations

from prometheus_client import Counter, Histogram

records = Counter(
    "fms_ingest_records_total",
    "Records processed, by kind, source and result (inserted|duplicate|ignored|rejected)",
    ["kind", "source", "result"],
)
batch_latency = Histogram(
    "fms_ingest_batch_duration_seconds",
    "End-to-end request processing time (auth + DB transaction)",
    ["route", "outcome"],
    buckets=[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
)
batch_size = Histogram(
    "fms_ingest_batch_records",
    "Records per request",
    ["route"],
    buckets=[1, 5, 10, 50, 100, 250, 500, 1000, 2500, 5000],
)
rejects = Counter("fms_ingest_rejects_total", "Rejected requests or records by reason", ["route", "reason"])
alerts = Counter("fms_ingest_alerts_raised_total", "Alerts inserted by ingest, by code and severity", ["code", "severity"])


def record(kind: str, source: str, result: str) -> None:
    records.labels(kind, source, result).inc()


def reject(route: str, reason: str) -> None:
    rejects.labels(route, reason).inc()
