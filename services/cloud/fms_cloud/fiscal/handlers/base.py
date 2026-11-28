"""Handler contract (services/fiscal-worker/src/handlers/types.ts)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx

from fms_cloud.common.db import Conn

from ..config import WorkerConfig
from ..core import Log
from ..metrics import Metrics
from ..queue import Job, JobQueue


@dataclass
class WorkerDeps:
    db: Conn
    queue: JobQueue
    config: WorkerConfig
    log: Log
    metrics: Metrics
    # VSDC client (sign_sale / health) for a seller TPIN + branch.
    fiscal_client_for: Callable[[str, str], Any]
    notifiers: list[Any]
    storage: Any
    # Optional digital receipt archive (fiscal-printer file driver).
    receipt_archive: Any | None
    # Outbound HTTP (webhooks, SMS): the TypeScript fetchImpl.
    http: httpx.Client


@dataclass
class HandlerContext(WorkerDeps):
    job: Job | None = None


@dataclass
class JobHandler:
    kind: str
    handle: Callable[[HandlerContext], None]
    # Called once when a job is dead-lettered (non-retryable error or max_attempts reached).
    on_dead: Callable[[HandlerContext, str], None] | None = None
