"""Job handlers (services/fiscal-worker/src/handlers)."""

from .base import HandlerContext, JobHandler, WorkerDeps
from .erb_export import erb_export_handler
from .fiscalise import fiscalise_handler
from .notify import notify_handler
from .rollup import rollup_handler
from .webhook import webhook_handler

ALL_HANDLERS = [fiscalise_handler, rollup_handler, webhook_handler, notify_handler, erb_export_handler]

__all__ = [
    "ALL_HANDLERS",
    "HandlerContext",
    "JobHandler",
    "WorkerDeps",
    "erb_export_handler",
    "fiscalise_handler",
    "notify_handler",
    "rollup_handler",
    "webhook_handler",
]
