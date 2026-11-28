"""Test database and Django setup.

Tests run against a real PostgreSQL 16 (the schema relies on citext, pgcrypto,
partitions and plpgsql). Each session (re)creates TEST_DB_NAME from scratch:
db/migrations/*.sql, db/seed/001_demo.sql, then the core-api SQL migrations.

  TEST_PG_ADMIN_URL  superuser URL used to create the database
                     (default postgres://fms:fms-dev-password@localhost:15432/postgres,
                      the compose pg-primary with PG_PORT=15432)
  TEST_DB_NAME       database name (default fms_cloud_test). Use different names to
                     run several test sessions in parallel.
  TEST_KEEP_DB=1     reuse an existing database instead of recreating it.

Fixtures: core_client / ingest_client (django.test.Client bound to that service's
URLs), db (fms_cloud.common.db.primary), login(email) -> access token.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import pytest

ROOT = Path(__file__).resolve().parents[1]  # services/cloud
REPO = ROOT.parents[1]
sys.path.insert(0, str(ROOT))

ADMIN_URL = os.environ.get("TEST_PG_ADMIN_URL", "postgres://fms:fms-dev-password@localhost:15432/postgres")
DB_NAME = os.environ.get("TEST_DB_NAME", "fms_cloud_test")
TEST_DB_URL = urlunparse(urlparse(ADMIN_URL)._replace(path=f"/{DB_NAME}"))

PASSWORD = "ChangeMe123!"
PARTNER_KEY = "erbdemo1.dev-partner-key-erb"
ST = {
    "LUS": "aaaaaaaa-0000-0000-0000-000000000001",
    "CEN": "aaaaaaaa-0000-0000-0000-000000000002",
    "COP": "aaaaaaaa-0000-0000-0000-000000000003",
    "SOU": "aaaaaaaa-0000-0000-0000-000000000004",
}


TEMPLATE_DB = f"{DB_NAME}_tpl"


def _drop(c, name: str) -> None:
    c.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid()", [name])
    c.execute(f'DROP DATABASE IF EXISTS "{name}"')


def _create_database() -> None:
    """Build the migrated + seeded template once per session, then clone the test database from it."""
    import psycopg

    with psycopg.connect(ADMIN_URL, autocommit=True) as c:
        exists = c.execute("SELECT 1 FROM pg_database WHERE datname = %s", [DB_NAME]).fetchone()
        if exists and os.environ.get("TEST_KEEP_DB") == "1":
            return
        _drop(c, TEMPLATE_DB)
        c.execute(f'CREATE DATABASE "{TEMPLATE_DB}"')
    files = sorted((REPO / "db" / "migrations").glob("*.sql")) + [REPO / "db" / "seed" / "001_demo.sql"]
    files += sorted((ROOT / "fms_cloud" / "core" / "sql").glob("*.sql"))
    tpl_url = urlunparse(urlparse(ADMIN_URL)._replace(path=f"/{TEMPLATE_DB}"))
    with psycopg.connect(tpl_url, autocommit=True) as c:
        for f in files:
            c.execute(f.read_text(encoding="utf-8").encode())
        c.execute(
            "CREATE TABLE IF NOT EXISTS fms.core_api_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
        )
        for f in sorted((ROOT / "fms_cloud" / "core" / "sql").glob("*.sql")):
            c.execute("INSERT INTO fms.core_api_migrations(name) VALUES (%s) ON CONFLICT DO NOTHING", [f.name])
    _reset_database()


def _reset_database() -> None:
    """Fresh copy of the template (CREATE DATABASE ... TEMPLATE is a fast file copy)."""
    import psycopg

    with psycopg.connect(ADMIN_URL, autocommit=True) as c:
        _drop(c, DB_NAME)
        c.execute(f'CREATE DATABASE "{DB_NAME}" TEMPLATE "{TEMPLATE_DB}"')


_current_area: list[str] = []


@pytest.fixture(scope="module", autouse=True)
def _fresh_database_per_area(request):
    """Each test folder (core, ingest, fiscal, ...) starts from the seeded database.

    The suites assert exact counts against the demo seed, and ingest/fiscal tests
    write telemetry for the seed stations, so sharing one database across folders
    would make results depend on the run order.
    """
    area = Path(str(request.node.path)).resolve().relative_to(Path(__file__).resolve().parent).parts[0]
    if _current_area and _current_area[0] != area and os.environ.get("TEST_KEEP_DB") != "1":
        from django.db import connections

        connections.close_all()
        _reset_database()
    _current_area[:] = [area]
    yield


def pytest_configure(config):
    _create_database()
    os.environ["DATABASE_URL"] = TEST_DB_URL
    os.environ.pop("DATABASE_URL_RO", None)
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "fms_cloud.settings")
    os.environ.setdefault("FMS_SERVICE", "core")
    os.environ.setdefault("JWT_SECRET", "test-secret-0123456789abcdef")
    os.environ.setdefault("LOG_LEVEL", "silent")
    os.environ.setdefault("LOGIN_RATE_LIMIT_RPM", "10000")
    os.environ.setdefault("RATE_LIMIT_RPM", "100000")
    os.environ.setdefault("STREAM_POLL_MS", "300")
    import django

    django.setup()


@pytest.fixture
def db():
    from fms_cloud.common.db import primary

    return primary


def _client(urlconf: str):
    from django.test import Client, override_settings

    with override_settings(ROOT_URLCONF=urlconf):
        yield Client(raise_request_exception=False)


@pytest.fixture
def core_client():
    yield from _client("fms_cloud.urls_core")


@pytest.fixture
def ingest_client():
    yield from _client("fms_cloud.urls_ingest")


@pytest.fixture
def login(core_client):
    def _login(email: str, password: str = PASSWORD) -> str:
        r = core_client.post("/api/v1/auth/login", {"email": email, "password": password}, content_type="application/json")
        assert r.status_code == 200, r.content
        return r.json()["access_token"]

    return _login


def auth(token: str) -> dict[str, str]:
    """Headers for django.test.Client: client.get(url, **auth(tok))."""
    return {"HTTP_AUTHORIZATION": f"Bearer {token}"}
