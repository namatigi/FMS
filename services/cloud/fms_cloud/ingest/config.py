"""ingest-api configuration (port of services/ingest-api/src/config.ts): same env vars, same defaults.

DATABASE_URL, PG_STATEMENT_TIMEOUT_MS and LOG_LEVEL are read by fms_cloud.settings; PORT, HOST,
PG_POOL_MAX, PG_IDLE_TIMEOUT_MS and SHUTDOWN_TIMEOUT_MS belong to gunicorn / Django's connection
handling and are kept here only so the configuration surface is the same.
"""

from __future__ import annotations

import dataclasses
import math
import os
import re
from dataclasses import dataclass


def _int(name: str, default: int) -> int:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    try:
        n = float(v)
    except ValueError:
        raise RuntimeError(f"env {name} must be a number") from None
    if not math.isfinite(n):
        raise RuntimeError(f"env {name} must be a number")
    return int(n) if n.is_integer() else n  # type: ignore[return-value]


def _bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return bool(re.fullmatch(r"1|true|yes|on", v, re.IGNORECASE))


@dataclass(frozen=True)
class Config:
    database_url: str
    port: int
    host: str
    log_level: str
    pg_pool_max: int
    pg_statement_timeout_ms: int
    pg_idle_timeout_ms: int
    body_limit_bytes: int
    max_records_per_batch: int
    cache_ttl_ms: int
    rate_limit_rps: float
    rate_limit_burst: float
    rollup_delay_s: int
    max_commands_per_response: int
    # Redeliver a command if no 'received' ack arrived this many seconds after delivery.
    command_redeliver_s: int
    archive_edge_batches: bool
    shutdown_timeout_ms: int


def load_config(**overrides) -> Config:
    cfg = Config(
        database_url=os.environ.get("DATABASE_URL", "postgres://postgres@localhost:5432/fms"),
        port=_int("PORT", 8081),
        host=os.environ.get("HOST", "0.0.0.0"),
        log_level=os.environ.get("LOG_LEVEL", "info"),
        pg_pool_max=_int("PG_POOL_MAX", 20),
        pg_statement_timeout_ms=_int("PG_STATEMENT_TIMEOUT_MS", 15000),
        pg_idle_timeout_ms=_int("PG_IDLE_TIMEOUT_MS", 30000),
        body_limit_bytes=_int("BODY_LIMIT_BYTES", 5 * 1024 * 1024),
        max_records_per_batch=_int("MAX_RECORDS_PER_BATCH", 5000),
        cache_ttl_ms=_int("CACHE_TTL_MS", 60000),
        rate_limit_rps=_int("RATE_LIMIT_RPS", 20),
        rate_limit_burst=_int("RATE_LIMIT_BURST", 40),
        rollup_delay_s=_int("ROLLUP_DELAY_S", 120),
        max_commands_per_response=_int("MAX_COMMANDS_PER_RESPONSE", 20),
        command_redeliver_s=_int("COMMAND_REDELIVER_S", 120),
        archive_edge_batches=_bool("ARCHIVE_EDGE_BATCHES", False),
        shutdown_timeout_ms=_int("SHUTDOWN_TIMEOUT_MS", 15000),
    )
    return dataclasses.replace(cfg, **overrides) if overrides else cfg
