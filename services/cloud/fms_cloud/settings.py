"""Django settings for the FMS cloud services.

One code base, three processes, picked with FMS_SERVICE:
  core    -> core API   (fms_cloud.urls_core; /api/v1, /api/partner/v1, /api/docs)
  ingest  -> ingest API (fms_cloud.urls_ingest; /ingest/pts, /ingest/v1/edge/...)
  worker  -> background worker (`manage.py fms_worker`; no HTTP routes besides its metrics port)

The database schema is owned by db/migrations (plain SQL) and is not managed by
Django: there are no Django models or Django migrations for the fms schema.
Environment variables keep the names the TypeScript services used.
"""

from __future__ import annotations

import os
from urllib.parse import unquote, urlparse

SERVICE = os.environ.get("FMS_SERVICE", "core").strip().lower()
if SERVICE not in {"core", "ingest", "worker"}:
    raise RuntimeError(f"FMS_SERVICE must be core, ingest or worker (got {SERVICE!r})")

DEBUG = os.environ.get("DJANGO_DEBUG", "false").lower() in {"1", "true", "yes", "on"}
PRODUCTION = os.environ.get("NODE_ENV", os.environ.get("ENVIRONMENT", "")).lower() == "production"
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY") or os.environ.get("JWT_SECRET") or "dev-insecure-django-secret-change-me"
ALLOWED_HOSTS = [h.strip() for h in os.environ.get("ALLOWED_HOSTS", "*").split(",") if h.strip()]
USE_X_FORWARDED_HOST = True
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

INSTALLED_APPS = [
    "django.contrib.staticfiles",  # Ninja's Swagger UI assets (/api/docs)
    "ninja",
    "fms_cloud.common",
    "fms_cloud.core",
    "fms_cloud.ingest",
    "fms_cloud.fiscal",
]

MIDDLEWARE = [
    "fms_cloud.common.middleware.RequestIdMiddleware",
    "fms_cloud.common.middleware.SecurityHeadersMiddleware",
    "fms_cloud.common.middleware.CorsMiddleware",
    "fms_cloud.common.middleware.MetricsMiddleware",
    "fms_cloud.common.middleware.JsonErrorMiddleware",
]
if SERVICE == "core":
    MIDDLEWARE.append("fms_cloud.core.middleware.V1RateLimitMiddleware")

ROOT_URLCONF = {"core": "fms_cloud.urls_core", "ingest": "fms_cloud.urls_ingest", "worker": "fms_cloud.urls_worker"}[SERVICE]
WSGI_APPLICATION = "fms_cloud.wsgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {"context_processors": ["django.template.context_processors.request"]},
    }
]
STATIC_URL = "/api/static/"


def _db_from_url(url: str, app_name: str) -> dict:
    u = urlparse(url)
    if u.scheme not in {"postgres", "postgresql"}:
        raise RuntimeError(f"unsupported database url scheme {u.scheme!r}")
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": unquote(u.path.lstrip("/")) or "fms",
        "USER": unquote(u.username or "postgres"),
        "PASSWORD": unquote(u.password or ""),
        "HOST": u.hostname or "localhost",
        "PORT": str(u.port or 5432),
        # Persistent connections per thread; gunicorn gthread workers reuse them.
        "CONN_MAX_AGE": int(os.environ.get("PG_CONN_MAX_AGE", "60")),
        "CONN_HEALTH_CHECKS": True,
        "ATOMIC_REQUESTS": False,
        "OPTIONS": {
            "application_name": app_name,
            # The HTTP roles cap queries at 15 s like ingest-api did; the worker had no cap
            # (roll-ups and partition maintenance can run long), so its default is 0 = off.
            "options": f"-c statement_timeout={int(os.environ.get('PG_STATEMENT_TIMEOUT_MS', '0' if SERVICE == 'worker' else '15000'))}",
        },
        "TEST": {"NAME": None},
    }


DATABASE_URL = os.environ.get("DATABASE_URL", "postgres://postgres@localhost:5432/fms")
DATABASE_URL_RO = os.environ.get("DATABASE_URL_RO") or None
_app = {"core": "core-api", "ingest": "ingest-api", "worker": "fiscal-worker"}[SERVICE]
DATABASES = {"default": _db_from_url(DATABASE_URL, _app)}
if DATABASE_URL_RO:
    DATABASES["ro"] = _db_from_url(DATABASE_URL_RO, f"{_app}-ro")
# Code always asks for "ro"; fms_cloud.common.db maps it to "default" when no replica is configured.
RO_ALIAS = "ro" if DATABASE_URL_RO else "default"

USE_TZ = True
TIME_ZONE = "UTC"
USE_I18N = False
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
DATA_UPLOAD_MAX_MEMORY_SIZE = int(os.environ.get("BODY_LIMIT_BYTES", str(5 * 1024 * 1024 if SERVICE == "ingest" else 1024 * 1024)))
APPEND_SLASH = False

LOG_LEVEL = os.environ.get("LOG_LEVEL", "info").upper()
if LOG_LEVEL in {"SILENT", "FATAL"}:
    LOG_LEVEL = "CRITICAL"
if LOG_LEVEL == "TRACE":
    LOG_LEVEL = "DEBUG"
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"json": {"()": "fms_cloud.common.logs.JsonFormatter", "service": _app}},
    "handlers": {"stdout": {"class": "logging.StreamHandler", "formatter": "json"}},
    "root": {"handlers": ["stdout"], "level": LOG_LEVEL},
    "loggers": {
        "django.request": {"level": "ERROR"},
        "django.server": {"level": "WARNING"},
    },
}

CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "").strip()
