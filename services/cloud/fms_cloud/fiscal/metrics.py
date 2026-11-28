"""Prometheus metrics of the worker (services/fiscal-worker/src/metrics.ts).

Each create_metrics() call builds its own CollectorRegistry (like prom-client's `new Registry()`),
so several apps can coexist in one process (tests).
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram
from prometheus_client.core import GaugeMetricFamily
from prometheus_client.gc_collector import GCCollector
from prometheus_client.platform_collector import PlatformCollector
from prometheus_client.process_collector import ProcessCollector

DepthFn = Callable[[], list[dict[str, Any]]]

_DEPTH_NAME = "fms_worker_queue_depth"
_DEPTH_HELP = "Jobs in fms.jobs by kind and status (queued/running/dead)"


class _QueueDepthCollector:
    """Gauge computed at scrape time; keeps the last values when the database is unavailable."""

    def __init__(self, fn: DepthFn | None) -> None:
        self.fn = fn
        self.last: list[dict[str, Any]] = []

    def describe(self):
        return [GaugeMetricFamily(_DEPTH_NAME, _DEPTH_HELP, labels=["kind", "status"])]

    def collect(self):
        if self.fn is not None:
            try:
                self.last = self.fn()
            except Exception:  # noqa: BLE001, S110 - DB unavailable: keep last values
                pass
        g = GaugeMetricFamily(_DEPTH_NAME, _DEPTH_HELP, labels=["kind", "status"])
        for r in self.last:
            g.add_metric([r["kind"], r["status"]], r["count"])
        yield g


@dataclass
class Metrics:
    registry: CollectorRegistry
    jobs_processed: Counter
    job_duration: Histogram
    jobs_inflight: Gauge
    scheduler_leader: Gauge
    scheduler_runs: Counter
    fiscal_signed: Counter
    webhook_deliveries: Counter
    notifications: Counter
    lease_recoveries: Counter

    def start_timer(self, kind: str) -> Callable[[], None]:
        t0 = time.perf_counter()
        return lambda: self.job_duration.labels(kind=kind).observe(time.perf_counter() - t0)


def create_metrics(depth_collector: DepthFn | None = None) -> Metrics:
    reg = CollectorRegistry()
    # collectDefaultMetrics equivalent
    ProcessCollector(registry=reg)
    PlatformCollector(registry=reg)
    GCCollector(registry=reg)
    reg.register(_QueueDepthCollector(depth_collector))
    return Metrics(
        registry=reg,
        jobs_processed=Counter(
            "fms_worker_jobs_processed_total", "Jobs processed by outcome (done/retry/dead/lost)", ["kind", "outcome"], registry=reg
        ),
        job_duration=Histogram(
            "fms_worker_job_duration_seconds",
            "Job handler duration",
            ["kind"],
            buckets=[0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
            registry=reg,
        ),
        jobs_inflight=Gauge("fms_worker_jobs_inflight", "Jobs currently executing in this replica", ["kind"], registry=reg),
        scheduler_leader=Gauge("fms_worker_scheduler_leader", "1 if this replica holds the scheduler advisory lock", registry=reg),
        scheduler_runs=Counter("fms_worker_scheduler_runs_total", "Scheduler task runs", ["task", "outcome"], registry=reg),
        fiscal_signed=Counter(
            "fms_fiscal_cloud_receipts_total", "Cloud fiscalisation results (signed/skipped/failed)", ["result"], registry=reg
        ),
        webhook_deliveries=Counter("fms_webhook_deliveries_total", "Webhook delivery attempts", ["event", "outcome"], registry=reg),
        notifications=Counter("fms_notifications_total", "Notifications sent per channel", ["channel", "outcome"], registry=reg),
        lease_recoveries=Counter("fms_worker_lease_recoveries_total", "Expired job leases recovered", ["outcome"], registry=reg),
    )
