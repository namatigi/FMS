"""`FMS_SERVICE=worker python manage.py fms_worker` (services/fiscal-worker/src/main.ts).

Starts the health/metrics server on METRICS_PORT, the job worker and (SCHEDULER_ENABLED)
the leader-elected scheduler; SIGTERM / SIGINT stop claiming, wait up to SHUTDOWN_GRACE_MS
for in-flight jobs and exit (forced exit SHUTDOWN_GRACE_MS + 10 s later).
"""

from __future__ import annotations

import datetime as dt
import logging
import os
import signal
import threading
import time
from typing import ClassVar

from django.core.management.base import BaseCommand
from django.db import connections
from prometheus_client import disable_created_metrics

from fms_cloud.common.jsonutil import iso
from fms_cloud.fiscal.app import create_app
from fms_cloud.fiscal.config import load_config
from fms_cloud.fiscal.core import Log, error_message
from fms_cloud.fiscal.httpserver import HttpDeps, start_http_server


class Command(BaseCommand):
    help = "Run the FMS job worker (fiscalise, rollup, webhook, notify, erb_export) and scheduler."
    requires_system_checks: ClassVar[list[str]] = []

    def handle(self, *args, **options) -> None:
        config = load_config()
        log = Log("fms.fiscal_worker", {"worker_id": config.worker_id})
        # Outbound requests are logged by the handlers themselves (like the node worker).
        logging.getLogger("httpx").setLevel(logging.WARNING)
        logging.getLogger("httpcore").setLevel(logging.WARNING)
        # prom-client exposes no *_created samples; keep /metrics the same shape.
        disable_created_metrics()
        try:
            self._main(config, log)
        except SystemExit:
            raise
        except BaseException as err:
            log.fatal("failed to start", err=error_message(err))
            logging.shutdown()
            raise SystemExit(1) from err

    def _main(self, config, log: Log) -> None:
        app = create_app(config, log)
        worker, scheduler = app.worker, app.scheduler
        started_at = dt.datetime.now(dt.UTC)

        def is_alive() -> bool:
            # Alive while the poll loop iterates (allow for one long poll/backoff cycle).
            return worker.running and (time.time() - worker.last_loop_at) * 1000 < max(60_000, config.poll_interval_ms * 10)

        server = start_http_server(
            config.metrics_port,
            HttpDeps(
                metrics=app.deps.metrics,
                log=log,
                is_alive=is_alive,
                info=lambda: {
                    "worker_id": config.worker_id,
                    "kinds": worker.kinds,
                    "scheduler_leader": scheduler.is_leader,
                    "started_at": iso(started_at),
                },
            ),
        )
        log.info("health/metrics server listening", port=config.metrics_port)

        worker.start()
        if config.scheduler.enabled:
            scheduler.start()

        stop = threading.Event()
        received: list[str] = []

        def on_signal(signum, _frame) -> None:
            if not received:
                received.append(signal.Signals(signum).name)
            stop.set()

        for name in ("SIGTERM", "SIGINT", "SIGBREAK"):
            if hasattr(signal, name):
                signal.signal(getattr(signal, name), on_signal)
        while not stop.wait(0.5):
            pass

        log.info("shutting down", signal=received[0] if received else None)

        def force_exit() -> None:
            log.error("forced exit after shutdown timeout")
            logging.shutdown()
            os._exit(1)

        force = threading.Timer((config.shutdown_grace_ms + 10_000) / 1000, force_exit)
        force.daemon = True
        force.start()
        try:
            scheduler.stop()
            worker.stop()
            server.close()
            app.deps.http.close()
            connections.close_all()
            log.info("shutdown complete")
        except Exception as err:
            log.error("error during shutdown", err=error_message(err))
            logging.shutdown()
            raise SystemExit(1) from err
        force.cancel()
