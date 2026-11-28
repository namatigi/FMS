"""Wiring of the worker (services/fiscal-worker/src/app.ts)."""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx

from fms_cloud.common.db import primary

from .config import WorkerConfig
from .core import Log, permanent
from .handlers import ALL_HANDLERS
from .handlers.base import JobHandler, WorkerDeps
from .jscompat import coalesce
from .metrics import Metrics, create_metrics
from .notifiers import notifiers_from_config
from .printer import create_printer
from .queue import JobQueue
from .scheduler import Scheduler, SchedulerDeps
from .storage import LocalDirStorage
from .worker import Worker
from .zra import ZraVsdcClient


def fiscal_client_factory(cfg: WorkerConfig, http: httpx.Client | None = None) -> Callable[[str, str], ZraVsdcClient]:
    """VSDC client per seller TPIN + branch. Device/URL come from ZRA_VSDC_DEVICES["<tpin>:<bhfId>"]
    or fall back to ZRA_VSDC_URL / ZRA_DEVICE_SERIAL."""
    cache: dict[str, ZraVsdcClient] = {}
    lock = threading.Lock()

    def get(tpin: str, bhf_id: str) -> ZraVsdcClient:
        key = f"{tpin}:{bhf_id}"
        with lock:
            c = cache.get(key)
            if c is None:
                dev = cfg.zra.devices.get(key) or None
                base_url = coalesce((dev or {}).get("baseUrl"), cfg.zra.default_base_url)
                if not base_url:
                    raise permanent(f"No VSDC configured for {key} (set ZRA_VSDC_URL or ZRA_VSDC_DEVICES)", "NO_VSDC")
                serial = (dev or {}).get("deviceSerial")
                c = ZraVsdcClient(
                    base_url=base_url,
                    tpin=tpin,
                    bhf_id=bhf_id,
                    device_serial=serial if serial is not None else cfg.zra.default_device_serial,
                    cmc_key=(dev or {}).get("cmcKey"),
                    timeout_ms=cfg.zra.timeout_ms,
                    vat_rates=cfg.zra.vat_rates,
                    http=http,
                )
                cache[key] = c
            return c

    return get


@dataclass
class App:
    deps: WorkerDeps
    worker: Worker
    scheduler: Scheduler


def create_app(
    config: WorkerConfig,
    log: Log,
    *,
    queue: JobQueue | None = None,
    metrics: Metrics | None = None,
    http: httpx.Client | None = None,
    fiscal_client_for: Callable[[str, str], Any] | None = None,
    notifiers: list[Any] | None = None,
    storage: Any | None = None,
    receipt_archive: Any | None = None,
    handlers: list[JobHandler] | None = None,
) -> App:
    """Overrides mirror the TypeScript `overrides` (tests). The database is Django's default connection."""
    db = primary
    queue = queue or JobQueue(db, backoff_base_ms=config.backoff_base_ms, backoff_max_ms=config.backoff_max_ms)
    metrics = metrics or create_metrics(queue.depth)
    http = http or httpx.Client()
    if receipt_archive is None and config.zra.receipt_archive_dir:
        receipt_archive = create_printer({"driver": "file", "dir": config.zra.receipt_archive_dir})
    deps = WorkerDeps(
        db=db,
        queue=queue,
        config=config,
        log=log,
        metrics=metrics,
        fiscal_client_for=fiscal_client_for or fiscal_client_factory(config),
        notifiers=notifiers if notifiers is not None else notifiers_from_config(config, log, http),
        storage=storage or LocalDirStorage(config.export_dir),
        receipt_archive=receipt_archive,
        http=http,
    )
    worker = Worker(deps, handlers if handlers is not None else ALL_HANDLERS)
    scheduler = Scheduler(SchedulerDeps(db=db, queue=queue, config=config, log=log, metrics=metrics))
    return App(deps=deps, worker=worker, scheduler=scheduler)
