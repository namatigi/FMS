"""Runtime settings, read from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta, timezone
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parent.parent

# Zambia is UTC+2 all year (no DST); business days are station-local days.
LUSAKA_TZ = timezone(timedelta(hours=2), name="Africa/Lusaka")


def business_today() -> date:
    return datetime.now(UTC).astimezone(LUSAKA_TZ).date()


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    database_url: str = ""
    database_url_ro: str = ""
    jwt_secret: str = ""
    log_level: str = "INFO"
    port: int = 8090
    models_config: Path = field(default_factory=lambda: SERVICE_ROOT / "config" / "models.yaml")
    pricing_config: Path = field(default_factory=lambda: SERVICE_ROOT / "config" / "pricing_defaults.yaml")
    apply_migrations: bool = True
    forecast_cache_ttl_s: int = 600
    db_pool_min: int = 1
    db_pool_max: int = 10
    statement_timeout_ms: int = 30000

    @classmethod
    def from_env(cls) -> Settings:
        db = os.environ.get("DATABASE_URL", "postgres://postgres@localhost:5432/fms")
        return cls(
            database_url=db,
            database_url_ro=os.environ.get("DATABASE_URL_RO") or db,
            jwt_secret=os.environ.get("JWT_SECRET", ""),
            log_level=os.environ.get("LOG_LEVEL", "INFO").upper(),
            port=int(os.environ.get("PORT", "8090")),
            models_config=Path(os.environ.get("MODELS_CONFIG", str(SERVICE_ROOT / "config" / "models.yaml"))),
            pricing_config=Path(
                os.environ.get("PRICING_CONFIG", str(SERVICE_ROOT / "config" / "pricing_defaults.yaml"))
            ),
            apply_migrations=_bool("ANALYTICS_APPLY_MIGRATIONS", True),
            forecast_cache_ttl_s=int(os.environ.get("FORECAST_CACHE_TTL_S", "600")),
            db_pool_min=int(os.environ.get("DB_POOL_MIN", "1")),
            db_pool_max=int(os.environ.get("DB_POOL_MAX", "10")),
            statement_timeout_ms=int(os.environ.get("DB_STATEMENT_TIMEOUT_MS", "30000")),
        )
