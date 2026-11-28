"""core-api configuration (same environment variables as services/core-api/src/config.ts)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache


@dataclass(frozen=True)
class CoreConfig:
    jwt_secret: str
    access_ttl_sec: int
    refresh_ttl_days: int
    rate_limit_rpm: int
    login_rate_limit_rpm: int
    stream_poll_ms: int
    run_migrations: bool
    mfa_issuer: str


@lru_cache(maxsize=1)
def config() -> CoreConfig:
    env = os.environ
    production = env.get("NODE_ENV") == "production" or env.get("ENVIRONMENT") == "production"
    jwt_secret = env.get("JWT_SECRET") or ("" if production else "dev-insecure-jwt-secret-change-me")
    if len(jwt_secret) < 16:
        raise RuntimeError("JWT_SECRET must be set (min 16 chars)")
    return CoreConfig(
        jwt_secret=jwt_secret,
        access_ttl_sec=int(env.get("ACCESS_TOKEN_TTL_SEC", "900")),
        refresh_ttl_days=int(env.get("REFRESH_TOKEN_TTL_DAYS", "30")),
        rate_limit_rpm=int(env.get("RATE_LIMIT_RPM", "1200")),
        login_rate_limit_rpm=int(env.get("LOGIN_RATE_LIMIT_RPM", "30")),
        stream_poll_ms=int(env.get("STREAM_POLL_MS", "5000")),
        run_migrations=env.get("RUN_MIGRATIONS", "true") != "false",
        mfa_issuer=env.get("MFA_ISSUER", "Zambia FMS"),
    )
