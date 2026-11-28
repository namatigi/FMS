"""Worker configuration (services/fiscal-worker/src/config.ts): same env vars, defaults and validation."""

from __future__ import annotations

import json
import math
import os
import socket
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from .jscompat import is_finite, js_number

JOB_KINDS = ("fiscalise", "rollup", "webhook", "notify", "erb_export")
PAYMENT_TYPES = ("cash", "card", "mobile_money", "credit", "other")


@dataclass
class DailyAt:
    hour: float
    minute: float


@dataclass
class SchedulerConfig:
    enabled: bool = True
    tick_ms: float = 30_000
    lock_key: int = 727_301
    daily_at: DailyAt = field(default_factory=lambda: DailyAt(0, 15))
    time_zone: str = "Africa/Lusaka"
    fiscal_sweep_every_ms: float = 5 * 60_000
    partitions_every_ms: float = 60 * 60_000
    fiscal_direct_delay_minutes: float = 2
    fiscal_cloud_fallback_minutes: float = 60
    fiscal_sweep_lookback_days: float = 30
    fiscal_sweep_limit: float = 5000
    gateway_offline_minutes: float = 15
    erb_export_delay_minutes: float = 10


@dataclass
class ZraConfig:
    default_base_url: str | None = None
    default_device_serial: str = ""
    timeout_ms: float = 15_000
    vat_rates: dict[str, float] = field(default_factory=dict)
    # Per "<tpin>:<bhfId>" VSDC device overrides: {"baseUrl", "deviceSerial", "cmcKey"?}.
    devices: dict[str, dict[str, Any]] = field(default_factory=dict)
    default_payment_type: str = "cash"
    receipt_archive_dir: str | None = None


@dataclass
class WebhookConfig:
    timeout_ms: float = 10_000
    max_attempts: float = 12
    user_agent: str = "FMS-Webhooks/1.0"


@dataclass
class NotifyConfig:
    smtp: dict[str, Any] | None = None  # {host, port, from}
    sms: dict[str, Any] | None = None  # {url, token}
    fcm: dict[str, Any] | None = None  # {projectId}


@dataclass
class WorkerConfig:
    database_url: str
    log_level: str = "info"
    metrics_port: int = 9464
    worker_id: str = ""
    kinds: list[str] = field(default_factory=lambda: list(JOB_KINDS))
    concurrency: float = 8
    batch_size: float = 10
    poll_interval_ms: float = 1000
    job_timeout_ms: float = 120_000
    lease_timeout_minutes: float = 10
    lease_check_interval_ms: float = 60_000
    backoff_base_ms: float = 5_000
    backoff_max_ms: float = 3_600_000
    shutdown_grace_ms: float = 30_000
    db_pool_max: float = 10
    scheduler: SchedulerConfig = field(default_factory=SchedulerConfig)
    zra: ZraConfig = field(default_factory=ZraConfig)
    webhook: WebhookConfig = field(default_factory=WebhookConfig)
    export_dir: str = "./exports"
    notify: NotifyConfig = field(default_factory=NotifyConfig)


def _int(env: Mapping[str, str], name: str, default: float) -> float:
    v = env.get(name)
    if v is None or v == "":
        return default
    n = js_number(v)
    if not is_finite(n):
        raise ValueError(f"Invalid number for {name}: {v}")
    return n


def _bool(env: Mapping[str, str], name: str, default: bool) -> bool:
    v = env.get(name)
    if v is None or v == "":
        return default
    return v.lower() in ("1", "true", "yes", "on")


def parse_rates(s: str | None) -> dict[str, float]:
    """ "A=16,B=16,D=0" -> {"A": 16, "B": 16, "D": 0}"""
    out: dict[str, float] = {}
    for part in [x.strip() for x in (s or "").split(",")]:
        if not part:
            continue
        pieces = part.split("=")
        k = pieces[0]
        n = js_number(pieces[1]) if len(pieces) > 1 else math.nan  # Number(undefined) is NaN
        if not k or not is_finite(n):
            raise ValueError(f"Invalid ZRA_VAT_RATES entry: {part}")
        out[k.strip()] = n
    return out


def load_config(env: Mapping[str, str] | None = None) -> WorkerConfig:
    env = os.environ if env is None else env
    database_url = env.get("DATABASE_URL")
    if not database_url:
        raise ValueError("DATABASE_URL is required")
    kinds = [k.strip() for k in env["WORKER_KINDS"].split(",") if k.strip()] if env.get("WORKER_KINDS") else list(JOB_KINDS)
    for k in kinds:
        if k not in JOB_KINDS:
            raise ValueError(f"Unknown job kind in WORKER_KINDS: {k}")
    hm = [js_number(x) for x in env.get("SCHEDULER_DAILY_AT", "00:15").split(":")]
    h = hm[0] if len(hm) > 0 else 0
    m = hm[1] if len(hm) > 1 else 15
    payment = env.get("FISCAL_DEFAULT_PAYMENT_TYPE", "cash")
    if payment not in PAYMENT_TYPES:
        raise ValueError(f"Invalid FISCAL_DEFAULT_PAYMENT_TYPE: {payment}")

    smtp_host = env.get("SMTP_HOST")
    sms_url = env.get("SMS_GATEWAY_URL")
    fcm = env.get("FCM_PROJECT_ID")
    return WorkerConfig(
        database_url=database_url,
        log_level=env.get("LOG_LEVEL", "info"),
        metrics_port=int(_int(env, "METRICS_PORT", 9464)),
        worker_id=env.get("WORKER_ID", f"{socket.gethostname()}-{os.getpid()}"),
        kinds=kinds,
        concurrency=max(1, _int(env, "WORKER_CONCURRENCY", 8)),
        batch_size=max(1, _int(env, "WORKER_BATCH_SIZE", 10)),
        poll_interval_ms=_int(env, "WORKER_POLL_INTERVAL_MS", 1000),
        job_timeout_ms=_int(env, "JOB_TIMEOUT_MS", 120_000),
        lease_timeout_minutes=_int(env, "JOB_LEASE_TIMEOUT_MINUTES", 10),
        lease_check_interval_ms=_int(env, "JOB_LEASE_CHECK_INTERVAL_MS", 60_000),
        backoff_base_ms=_int(env, "JOB_BACKOFF_BASE_MS", 5_000),
        backoff_max_ms=_int(env, "JOB_BACKOFF_MAX_MS", 3_600_000),
        shutdown_grace_ms=_int(env, "SHUTDOWN_GRACE_MS", 30_000),
        db_pool_max=_int(env, "DB_POOL_MAX", 10),
        scheduler=SchedulerConfig(
            enabled=_bool(env, "SCHEDULER_ENABLED", True),
            tick_ms=_int(env, "SCHEDULER_TICK_MS", 30_000),
            lock_key=int(_int(env, "SCHEDULER_LOCK_KEY", 727_301)),
            daily_at=DailyAt(hour=h, minute=m),
            time_zone=env.get("SCHEDULER_TIMEZONE", "Africa/Lusaka"),
            fiscal_sweep_every_ms=_int(env, "FISCAL_SWEEP_INTERVAL_MS", 5 * 60_000),
            partitions_every_ms=_int(env, "PARTITIONS_INTERVAL_MS", 60 * 60_000),
            fiscal_direct_delay_minutes=_int(env, "FISCAL_DIRECT_DELAY_MINUTES", 2),
            fiscal_cloud_fallback_minutes=_int(env, "FISCAL_CLOUD_FALLBACK_MINUTES", 60),
            fiscal_sweep_lookback_days=_int(env, "FISCAL_SWEEP_LOOKBACK_DAYS", 30),
            fiscal_sweep_limit=_int(env, "FISCAL_SWEEP_LIMIT", 5000),
            gateway_offline_minutes=_int(env, "GATEWAY_OFFLINE_MINUTES", 15),
            erb_export_delay_minutes=_int(env, "ERB_EXPORT_DELAY_MINUTES", 10),
        ),
        zra=ZraConfig(
            default_base_url=env.get("ZRA_VSDC_URL") or None,
            default_device_serial=env.get("ZRA_DEVICE_SERIAL", ""),
            timeout_ms=_int(env, "ZRA_TIMEOUT_MS", 15_000),
            vat_rates=parse_rates(env.get("ZRA_VAT_RATES")),
            devices=json.loads(env["ZRA_VSDC_DEVICES"]) if env.get("ZRA_VSDC_DEVICES") else {},
            default_payment_type=payment,
            receipt_archive_dir=env.get("RECEIPT_ARCHIVE_DIR") or None,
        ),
        webhook=WebhookConfig(
            timeout_ms=_int(env, "WEBHOOK_TIMEOUT_MS", 10_000),
            max_attempts=_int(env, "WEBHOOK_MAX_ATTEMPTS", 12),
            user_agent=env.get("WEBHOOK_USER_AGENT", "FMS-Webhooks/1.0"),
        ),
        export_dir=env.get("EXPORT_DIR", "./exports"),
        notify=NotifyConfig(
            smtp={"host": smtp_host, "port": _int(env, "SMTP_PORT", 587), "from": env.get("SMTP_FROM", "fms@localhost")}
            if smtp_host
            else None,
            sms={"url": sms_url, "token": env.get("SMS_GATEWAY_TOKEN")} if sms_url else None,
            fcm={"projectId": fcm} if fcm else None,
        ),
    )
